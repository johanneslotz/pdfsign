# Smartcard-based Digital Signing — Implementation Plan

## Status quo

The current "signature" is purely visual: `SignaturePad` draws ink on a canvas
and `PDFEditor.applySignatures` (`js/pdf-editor.js:34`) embeds a PNG image into
the PDF via `pdf-lib`. There is **no cryptographic signature** — the resulting
PDF carries no signer identity, no integrity protection, and no PAdES
signature dictionary.

Goal: produce a PDF with a real ETSI **PAdES B-B / B-T** signature where the
private key never leaves a smartcard (eID, D-Trust card, YubiKey PIV, HSM-style
USB token, etc.).

---

## The two hard problems

1. **Browsers cannot talk to PKCS#11 directly.**  Smartcards are accessed via
   the operating system's PC/SC stack and a PKCS#11 module (e.g. OpenSC,
   `aetpkss1`, `aws-cloudhsm-pkcs11`, vendor middleware). No mainstream browser
   exposes PKCS#11. WebUSB/WebHID can technically reach a CCID reader but
   re-implementing CCID + ISO 7816 + the card's applet is not realistic.
2. **`pdf-lib` cannot produce PAdES signatures.**  PAdES requires writing a
   signature dictionary with a `ByteRange` and a zero-padded `Contents`
   placeholder, hashing the file *minus* that placeholder, then patching the
   CMS/PKCS#7 SignedData back in. `pdf-lib` has no API for this; it must be
   done by post-processing the saved bytes.

Any solution has to deal with both.

---

## Options (ranked by realism for this PWA)

### Option A — Local signing agent (recommended)

A small native helper (Go, Rust, or Python) runs on the user's machine, listens
on `127.0.0.1`, exposes two endpoints, and talks to the card via PKCS#11 (or
the platform key store: macOS Keychain, Windows CNG/CryptoAPI, Linux p11-kit).

```
[ Browser PWA ] --HTTPS/WSS--> [ localhost agent ] --PKCS#11--> [ Smartcard ]
```

Endpoints (sketch):

- `GET  /certificates` → list available signing certs (subject, issuer, serial,
  key usage, slot id).
- `POST /sign` `{ slotId, hashAlg, digest }` → returns raw RSA/ECDSA signature
  after PIN prompt on the agent UI.

Pros
- Works with **any** PKCS#11 token, including qualified eIDAS cards.
- PIN entry happens in a native dialog — never in the browser.
- Same architecture used by Adobe Sign, DocuSign Local, Bundesdruckerei
  Sign-me Connector, Nexus Personal, etc.

Cons
- Users have to install the agent (signed installer / Homebrew / `.deb`).
- CORS + locally-trusted TLS cert needed (mkcert-style, or token-based origin
  pinning).
- Cross-platform packaging effort.

### Option B — Browser extension + native messaging host

Same idea as A, but the bridge is a Chrome/Firefox extension that spawns a
native messaging host (the PKCS#11 helper). The PWA communicates with the
extension via `window.postMessage` or `externally_connectable`.

Pros
- No localhost TLS gymnastics.
- Native messaging is already a vetted channel (used by 1Password, GPG, etc.).

Cons
- Two artefacts to ship and update (extension + host).
- Safari support is awful; mobile browsers have no extensions.

### Option C — WebAuthn / Passkeys for document signing

WebAuthn lets a FIDO2 token sign a server-issued challenge. Some YubiKeys also
expose a PIV applet (used via Option A), but **not** through WebAuthn.

Status: There is a draft "WebAuthn Signing Extension" but no shipping
implementation. For PAdES today this is **not viable** — the signature format
WebAuthn returns is wrapped in `authenticatorData || clientDataHash` and
verifiers expect a plain signature over the PDF hash.

Use only if you specifically want passkey-style signatures with a custom
verifier; not for standards-compliant PAdES.

### Option D — Remote / cloud smartcard (eIDAS "remote signing")

The key lives in a HSM at a Qualified Trust Service Provider (e.g.
D-Trust sign-me, Swisscom AIS, Namirial, GlobalSign DSS). The browser sends
the hash, the user authenticates with 2FA, the QTSP signs.

Pros
- No client install. Works on mobile. Legally a Qualified Electronic Signature
  in the EU when paired with a QSCD-backed identity.

Cons
- Not really a *smartcard* — it's a hosted HSM. If the user wants to use
  their own physical card, this option does not apply.
- Per-signature cost; account onboarding required.

### Option E — Soft token fallback (PKCS#12 / PFX import)

User exports their cert+key into a `.p12`, the PWA imports it via
`SubtleCrypto.importKey`, and signs in-browser.

Pros
- Zero install, pure browser.

Cons
- **Defeats the purpose of a smartcard** — the private key is now extractable
  and lives in browser memory. Worth offering as a clearly-labelled fallback,
  not the main path.

### Option F — Chromium Smart Card API (`navigator.smartCard`)

Chromium ships an experimental **Smart Card API** that exposes PC/SC to the
page: enumerate readers, connect to a card, transmit raw APDUs. Surface is
roughly:

```js
const ctx = await navigator.smartCard.establishContext();
const readers = await ctx.listReaders();
const conn = await ctx.connect(readers[0], 'shared', { preferredProtocols: ['t1'] });
const resp = await conn.transmit(selectAppletApdu);
```

Status (as of 2025): implemented in Chromium, but **gated to Isolated Web
Apps** (IWA) in managed/enterprise deployments. Not callable from a normal
`https://pdfsign.app` origin, and not available in Firefox or Safari at all.

Pros
- Pure browser, no native helper, no extension.
- Direct PC/SC — works with any reader the OS already supports.

Cons
- IWA-only ⇒ requires enterprise policy + signed bundle install. Defeats
  most of the "just open the website" appeal.
- You still have to drive the card yourself: SELECT applet, VERIFY PIN,
  PSO: COMPUTE DIGITAL SIGNATURE — i.e. an APDU layer per card OS (PIV,
  IAS-ECC, OpenPGP, German nPA, Estonian eID, …). This is the same code
  you'd avoid by going through PKCS#11.
- No PIN-pad reader support beyond what raw APDUs allow.
- API still flagged "experimental"; spec is not on a W3C standards track.

Adjacent Chrome-only options:
- **`chrome.platformKeys`** (MV3 extension API, ChromeOS): list client
  certs including smartcard-backed ones and call `subtleCrypto.sign` on
  the matching key handle. Works without writing APDUs but is ChromeOS
  only and requires an extension.
- **`chrome.certificateProvider`**: lets an extension *expose* a smartcard
  to the OS cert store. Useful for the inverse direction (TLS client auth)
  rather than for us.

Verdict: keep on the radar as **Option F-bis** for IWA deployments (e.g.
internal enterprise rollout where a managed bundle is acceptable). Wrap it
behind the same provider interface as the local agent so the orchestrator
doesn't care which transport delivers the signature. Not a replacement for
Option A on the public web today.

### Option G — WebUSB/WebHID + custom CCID stack

Theoretically possible. In practice means writing the CCID protocol *and*
an APDU layer for every card OS (NXP JCOP, Gemalto IDPrime, Athena
IDProtect, …). Months of work, fragile, no PIN-pad readers, blocked by
enterprise USB policies. **Not recommended.** Option F is strictly better
where it's available, since at least PC/SC handles the reader side.

---

## Recommended architecture

**Option A (local agent) as primary, Option E (PKCS#12) as labelled fallback,
Option D (remote QTSP) as a future plug-in.**

```
+-------------------------------------------------+
|                pdfsign PWA (browser)            |
|                                                 |
|  signing-orchestrator.js                        |
|    1. build PAdES placeholder via pdf-lib +     |
|       manual ByteRange patch                    |
|    2. hash the byte ranges (SubtleCrypto)       |
|    3. ask provider for cert + signature         |
|    4. assemble CMS SignedData (PKIjs)           |
|    5. splice into Contents placeholder          |
|                                                 |
|  providers/                                     |
|    local-agent.js   (Option A, default)         |
|    p12-soft.js      (Option E, fallback)        |
|    qtsp.js          (Option D, optional)        |
+-------------------------------------------------+
                    |
                    | https://127.0.0.1:7878
                    v
+-------------------------------------------------+
|        pdfsign-agent  (native, per-OS)          |
|   - PKCS#11 loader (OpenSC / vendor)            |
|   - PIN dialog                                  |
|   - certificate enumeration                     |
|   - raw sign(digest, mechanism)                 |
+-------------------------------------------------+
```

---

## Step-by-step plan

### Phase 1 — PAdES plumbing in the browser (no card yet)

Goal: produce a valid PAdES signature using a hard-coded test PKCS#12 so the
PDF/CMS pipeline can be verified independently of the card integration.

1. Add deps: `pkijs`, `asn1js`, `pvutils` (CMS construction in browser).
2. New module `js/sign/pdf-pades.js`:
   - `addSignaturePlaceholder(pdfBytes, { reason, location, signerName, contactInfo, signatureLength = 16384 })`
     → returns `{ pdfBytes, byteRange, contentsOffset }`.
     Implementation: load with `pdf-lib`, append an empty `/Sig` field +
     widget annotation, save, then post-process the saved bytes to write the
     real `ByteRange` and a zero-padded `Contents <00…00>` of
     `signatureLength` bytes. (pdf-lib produces deterministic output, so the
     two-pass save-then-patch trick works.)
   - `hashByteRanges(pdfBytes, byteRange, alg='SHA-256')` via `crypto.subtle`.
   - `embedCms(pdfBytes, contentsOffset, cmsDer)` — hex-encode and patch.
3. New module `js/sign/cms.js` (PKIjs):
   - `buildSignedAttributes(messageDigest, signingTime, signingCertV2)`.
   - `buildCmsSignedData({ signedAttrsDer, signatureBytes, cert, chain, hashAlg, sigAlg })`.
4. Soft-token provider `js/sign/providers/p12-soft.js`:
   - Import `.p12` via `forge` or PKIjs, expose `listCerts()` and
     `sign(digest)`.
5. Wire a "Sign cryptographically (test)" button next to the existing visual
   signature flow. Verify the output with Adobe Reader and `pdfsig` (poppler).

Exit criteria: Adobe Reader shows "Signed and all signatures are valid" for a
PDF signed with the test cert, and tampering invalidates it.

### Phase 2 — Local agent

1. Repo layout: `agent/` (Go, single static binary per OS).
2. Use `github.com/miekg/pkcs11` to load a configurable PKCS#11 module path
   (`OPENSC_LIBRARY` default per OS).
3. Endpoints:
   - `GET  /v1/health`
   - `GET  /v1/certificates` → `[{ slot, label, subject, issuer, serial,
     notAfter, certPem, chainPem[] }]`
   - `POST /v1/sign` `{ slot, keyId, hashAlg, digestB64 }` → `{ signatureB64 }`
   - All PIN handling done by the agent's tray UI; never returned to the
     browser.
4. Security:
   - TLS with a per-install self-signed cert; PWA pins the SPKI hash, fetched
     once via a user-confirmed pairing step (`/v1/pair` returns a one-time
     code shown in both UIs).
   - Origin allow-list (default: `https://pdfsign.app`, configurable).
   - Rate limit + audit log.
5. Browser provider `js/sign/providers/local-agent.js` mirroring the soft
   provider's interface so the orchestrator stays oblivious.

Exit criteria: Sign a PDF end-to-end with an OpenSC-supported card (e.g.
YubiKey PIV slot 9c, German nPA with AusweisApp PKCS#11) on macOS, Windows,
Linux.

### Phase 3 — Hardening & UX

- Detect signature algorithm from card (`CKM_RSA_PKCS_PSS`, `CKM_ECDSA`)
  and pick matching CMS `SignatureAlgorithmIdentifier`.
- Long-Term Validation: add `B-T` (RFC 3161 timestamp) by calling a TSA
  (Sectigo, FreeTSA, DFN). Implement TSP request/response in browser.
- LTV (`B-LT`): embed OCSP responses + CRLs in the DSS dictionary.
- Multiple signatures: incremental update so existing signatures stay valid.
- Visible signature: re-use the current PNG canvas as the signature
  appearance, but anchored to the `/Sig` widget rather than drawn as a
  separate image.
- Error UX: card removed mid-sign, wrong PIN, locked PIN, expired cert.

### Phase 4 — Distribution

- Sign and notarise the macOS agent; codesign the Windows build; provide
  `.deb`/`.rpm`/AUR for Linux.
- Auto-update channel (e.g. tuf-on-ci or sparkle).
- Document supported tokens and middleware; ship a "Test my card" diagnostic.

### Phase 5 (optional) — Remote QTSP provider

Add `providers/qtsp.js` implementing CSC API v2 (Cloud Signature Consortium)
so users can sign with a hosted qualified certificate without changing the
orchestrator.

---

## Library choices

| Concern               | Pick                                  | Why |
|-----------------------|----------------------------------------|-----|
| PDF placeholder/patch | `pdf-lib` + manual byte patch          | already in app |
| CMS / ASN.1 in browser| `pkijs` + `asn1js`                     | actively maintained, supports CAdES helpers |
| Soft P12 import       | `pkijs` (`PKCS12` class)               | no need to add `forge` |
| Hashing               | `crypto.subtle.digest`                 | native |
| Agent PKCS#11         | Go `miekg/pkcs11`                      | mature, single binary |
| TSA client            | hand-rolled with `pkijs` `TimeStampReq`| ~150 LoC |

---

## Risks & open questions

- **Deterministic `pdf-lib` output**: confirm that `save()` is byte-stable
  enough that the placeholder offsets we computed pre-save still match
  post-save. If not, fall back to streaming the placeholder during write.
- **PSS parameters**: some German eID cards force `RSASSA-PSS` with specific
  salt lengths; mis-encoding the `algorithmIdentifier` is the #1 cause of
  "signature invalid" in Adobe.
- **Localhost TLS UX**: Chrome's "Not secure" warning on `https://127.0.0.1`
  with self-signed cert. Two mitigations: ship a per-install root via OS
  trust store (requires admin), or use plain `http://127.0.0.1` and rely on
  origin-bound pairing tokens (browsers treat `127.0.0.1` as a secure
  context).
- **Mobile**: none of A/B/F work on iOS/Android. Mobile users get options D
  and E only.
- **Legal scope**: a Qualified Electronic Signature requires a QSCD-listed
  card *and* a qualified certificate from an EU trust list. The
  architecture supports it but we should not advertise QES until a specific
  card model has been certified end-to-end.

---

## Minimal first deliverable (1–2 days of work)

Phase 1 only, with the soft-token provider, behind a `?sign=crypto` flag.
That proves the PAdES pipeline works in-browser and gives us a realistic
target for the agent in Phase 2.

---

---

# Tauri Hybrid Plan (preferred path)

Supersedes the local-agent architecture above. The app ships as a Tauri
desktop application on macOS and Linux; the **same HTML/JS/CSS** also works
as a plain website (PWA) for users who just need visual signing or the
PKCS#12 soft fallback. Crypto signing is only available in the Tauri build.

---

## Why Tauri instead of the local agent

| Concern | Local agent | Tauri |
|---|---|---|
| Install footprint | agent binary + browser open | single `.app` / `.AppImage` |
| localhost TLS dance | required | gone — IPC is Tauri's built-in channel |
| CORS / pairing tokens | required | gone |
| PKCS#11 access | agent calls it | Rust backend calls it directly |
| PAdES library | JS (pkijs) + manual byte patch | Rust (`cryptoki` + `cms` crates) |
| PIN dialog | agent native UI | Tauri window or OS dialog |
| Code signing / notarisation | agent binary only | whole `.app` bundle |
| Auto-update | custom channel | Tauri updater built-in |
| Effort | ~4–5 weeks (agent + browser CMS) | ~2–3 weeks total |

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│            Tauri WebView  (same HTML/JS)          │
│                                                  │
│  js/sign/orchestrator.js                         │
│    detects window.__TAURI__ → tauri-provider.js  │
│    fallback                 → p12-soft.js        │
│                                                  │
│  invoke('list_smartcard_certs')                  │
│  invoke('sign_pdf', { pdfBytes, options })       │
└─────────────────┬────────────────────────────────┘
                  │ Tauri IPC (no network, no TLS)
                  ▼
┌──────────────────────────────────────────────────┐
│            Rust backend  (src-tauri/)            │
│                                                  │
│  commands/pkcs11.rs   — enumerate certs          │
│  commands/sign.rs     — full PAdES pipeline      │
│    ├─ lopdf: add /Sig placeholder + ByteRange    │
│    ├─ sha2: hash byte ranges                     │
│    ├─ cryptoki: C_Sign via PKCS#11 module        │
│    └─ cms + x509-cert + der: build SignedData    │
│  commands/file.rs     — native open/save dialogs │
└──────────────────────────────────────────────────┘
                  │ PKCS#11 C API
                  ▼
┌──────────────────────────────────────────────────┐
│  OS PKCS#11 module                               │
│  macOS: /Library/…/opensc-pkcs11.so             │
│         or Keychain via security-framework       │
│  Linux: /usr/lib/x86_64-linux-gnu/opensc-pkcs11.so│
└──────────────────────────────────────────────────┘
```

---

## Repository layout after migration

```
pdfsign/
├── index.html          ← unchanged
├── css/                ← unchanged
├── js/
│   ├── app.js          ← unchanged
│   ├── pdf-editor.js   ← unchanged (visual ops)
│   ├── pdf-viewer.js   ← unchanged
│   ├── signature-pad.js← unchanged
│   └── sign/           ← NEW
│       ├── orchestrator.js     detects Tauri, throws 'not-in-app' otherwise
│       └── tauri-provider.js   invokes Rust commands
├── src-tauri/          ← NEW
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       └── commands/
│           ├── sign.rs   PAdES pipeline
│           ├── pkcs11.rs cert enumeration + signing
│           └── file.rs   open/save dialogs
└── docs/
    └── SMARTCARD_SIGNING_PLAN.md
```

Everything in `js/` that exists today is untouched. The new `js/sign/`
layer is additive. The Tauri build bundles the whole `js/` + `index.html`
tree as the WebView frontend; the hosted PWA serves the same files.

---

## Tauri commands (Rust API surface)

```rust
// List PKCS#11 slots that have a signing certificate loaded.
// Returns JSON-serialisable structs; never returns key material.
#[tauri::command]
async fn list_smartcard_certs() -> Result<Vec<CertInfo>, String>

// Full PAdES B-B pipeline.  PDF bytes go in, signed PDF bytes come out.
// PIN prompt is shown natively before C_Sign is called.
// reason / location / signer_name go into the /Sig dictionary.
#[tauri::command]
async fn sign_pdf(
    pdf_bytes: Vec<u8>,
    slot_id: u64,
    hash_alg: String,          // "SHA-256" | "SHA-384" | "SHA-512"
    reason: String,
    location: String,
    signer_name: String,
    ts_url: Option<String>,    // RFC 3161 TSA; None → B-B, Some → B-T
) -> Result<Vec<u8>, String>

// Native file open dialog → bytes
#[tauri::command]
async fn open_pdf_dialog() -> Result<Option<(String, Vec<u8>)>, String>

// Native save dialog; writes bytes to chosen path
#[tauri::command]
async fn save_pdf_dialog(bytes: Vec<u8>, suggested_name: String) -> Result<(), String>
```

---

## Rust crate choices

| Concern | Crate | Notes |
|---|---|---|
| Tauri framework | `tauri 2.x` | 2.0 GA; supports macOS + Linux + Android later |
| PKCS#11 | `cryptoki` | idiomatic Rust wrapper, replaces `pkcs11` crate |
| CMS / SignedData | `cms` (RustCrypto) | PAdES-grade CMS without OpenSSL dep |
| X.509 parsing | `x509-cert` (RustCrypto) | pairs with `cms` |
| DER encoding | `der` (RustCrypto) | needed for signed attributes |
| PDF byte ops | `lopdf` | parse + mutate PDF for /Sig placeholder |
| Hashing | `sha2` | SHA-256/384/512 |
| macOS Keychain | `security-framework` | optional fallback if no PKCS#11 module |
| TSA client | hand-rolled ~100 LoC | `cms::TimeStampReq` + `reqwest` |
| File dialogs | `rfd` or tauri `dialog` plugin | native OS picker |

No OpenSSL dependency — the RustCrypto stack is pure Rust and cross-compiles
cleanly for both macOS (aarch64 + x86_64) and Linux (x86_64).

---

## PAdES pipeline in Rust (sign.rs)

```
sign_pdf(pdf_bytes, slot_id, …)
  │
  ├─1─ lopdf::Document::load_mem(pdf_bytes)
  │       add /AcroForm /Sig field + widget annotation
  │       write /ByteRange [0 0 0 0] placeholder
  │       write /Contents <000000…> (16 384 zero bytes)
  │       save to staging_bytes
  │
  ├─2─ locate actual ByteRange offsets in staging_bytes
  │       (scan for "/ByteRange [" literal — deterministic)
  │       patch real offsets in-place
  │
  ├─3─ sha2::Sha256: digest bytes[br[0]..br[1]] ++ bytes[br[2]..br[3]]
  │
  ├─4─ cryptoki: C_SignInit(CKM_RSA_PKCS / CKM_ECDSA)
  │              [native PIN dialog here]
  │              C_Sign(digest) → raw_sig_bytes
  │
  ├─5─ cms::builder::SignedDataBuilder
  │       .signer(cert, chain, signed_attrs, raw_sig_bytes)
  │       .build_der() → cms_der
  │
  ├─6─ optional: TSA round-trip
  │       cms::TimeStampReq::new(SHA-256(cms_der))
  │       POST to ts_url → TimeStampResp
  │       embed as unsigned attr id-aa-signatureTimeStampToken
  │
  └─7─ hex-encode cms_der, pad to 16 384 bytes
        splice into Contents placeholder
        return final_bytes
```

---

## JS-side changes

`js/sign/orchestrator.js`:

```js
import { TauriProvider } from './tauri-provider.js';
import { P12SoftProvider } from './p12-soft.js';

const isTauri = () => Boolean(window.__TAURI__);

export async function cryptoSign(pdfBytes, options) {
  if (!isTauri()) throw new Error('not-in-app'); // caller shows download prompt
  return new TauriProvider().sign(pdfBytes, options);
}
```

`js/sign/tauri-provider.js`:

```js
import { invoke } from '@tauri-apps/api/core';

export class TauriProvider {
  async listCerts()                  { return invoke('list_smartcard_certs'); }
  async sign(pdfBytes, options)      { return invoke('sign_pdf', { pdfBytes: Array.from(pdfBytes), ...options }); }
}
```

`app.js` gains a single new "Sign digitally" button that calls
`cryptoSign(currentPdfBytes, { slotId, reason, … })` and triggers a
save dialog. All existing visual-signature code is untouched.

---

## Hybrid PWA behaviour

| Context | Crypto signing | Visual signing |
|---|---|---|
| Tauri desktop app | Full smartcard PAdES | Yes (unchanged) |
| Browser (any) | Not available — "Download desktop app" prompt | Yes (unchanged) |

Detection is one check: `window.__TAURI__`. No feature flags, no URL params.
The "Sign digitally" button is simply hidden (or replaced by a download
prompt) when `window.__TAURI__` is falsy. No PKCS#12 path, no pkijs
dependency, no CMS code in the browser at all.

---

## Phased plan

### Phase 0 — Tauri scaffold (0.5 day)

- `npm create tauri-app` in repo root, targeting the existing `index.html`.
- Confirm the existing UI renders and all visual features still work inside
  the WebView.
- Commit `src-tauri/` skeleton; CI builds `.app` and `.AppImage`.

### Phase 1 — Native file dialogs (0.5 day)

- Implement `open_pdf_dialog` and `save_pdf_dialog` commands.
- In JS, detect Tauri and route file open/save through these commands instead
  of the current `<input type="file">` / `URL.createObjectURL` approach.
- Fallback: browser keeps existing flow.

Exit criteria: open a PDF via the native macOS/Linux file picker; save works.

### Phase 2 — PAdES pipeline with soft token (2 days)

- Implement `sign_pdf` command using a PKCS#11 software token
  (`softhsm2`) so the whole pipeline can be tested without a physical card.
- Implement `list_smartcard_certs` via `cryptoki`.
- Wire up `js/sign/` modules and the "Sign digitally" button.
- Verify output: Adobe Reader "Signed and all signatures are valid";
  `pdfsig -nssdir /etc/pki/nssdb <file>` reports valid.

Exit criteria: reproducible green test with SoftHSM2, CI-runnable.

### Phase 3 — Live smartcard (1–2 days)

- Test with YubiKey PIV (slot 9c, `opensc-pkcs11.so`).
- Test with a German nPA or similar eID card.
- Handle CKM_RSA_PKCS_PSS: detect mechanism from slot info and encode
  RSASSA-PSS `algorithmIdentifier` correctly in the CMS.
- Implement native PIN dialog: minimal Tauri window with a password input,
  or use the OS credential prompt where available.

Exit criteria: end-to-end sign with physical card on macOS and Linux.

### Phase 4 — Hardening (2 days)

- RFC 3161 timestamp (B-T): call FreeTSA or Sectigo TSA, embed token.
- Visible signature appearance: use the drawn canvas PNG as the `/AP`
  stream of the `/Sig` widget.
- Multiple signatures: incremental PDF update so earlier sigs stay valid.
- Error handling: card removed mid-sign, wrong PIN (with retry counter),
  PIN locked, expired certificate → clear user-facing messages.
- macOS Keychain path via `security-framework` as an additional provider
  (no PKCS#11 module needed for certs in Keychain).

### Phase 5 — Distribution (1 day)

- macOS: code-sign + notarise the `.app`; wrap in a `.dmg`.
- Linux: `.AppImage` + `.deb`; optionally a Flatpak for the sandboxed path.
- Tauri updater: point at a GitHub Releases JSON endpoint.
- Ship "Test my card" diagnostic command that lists readers, slots, certs,
  and checks key usage without signing anything.

### Phase 6 — "Get the app" prompt on web (0.5 day)

- When `window.__TAURI__` is falsy, the "Sign digitally" button is replaced
  by a banner: "Cryptographic signing requires the desktop app — Download
  for macOS / Linux".
- No JS crypto code ships to the browser. No pkijs, no pkcs12, no CMS.

---

## Total effort estimate

| Phase | Work |
|---|---|
| 0 Tauri scaffold | 0.5 day |
| 1 File dialogs | 0.5 day |
| 2 PAdES + soft token | 2 days |
| 3 Live smartcard | 1.5 days |
| 4 Hardening | 2 days |
| 5 Distribution | 1 day |
| 6 "Get the app" prompt | 0.5 day |
| **Total** | **~8 days** |

---

## Risks

- **`lopdf` placeholder stability**: confirm that `save()` is byte-stable
  and the `/ByteRange` offsets we scan for are unique and correctly patched.
  If lopdf reorders objects, switch to a pure byte-append strategy (write
  the /Sig as an incremental update appended to the original bytes).
- **PSS salt length**: German eID and some Gemalto cards mandate a specific
  PSS salt length that must match the `algorithmIdentifier` in the CMS.
  Wrong encoding is the #1 cause of "signature invalid" in Adobe Reader.
- **Tauri 2.x API churn**: the `invoke` serialisation format changed
  between 1.x and 2.x. Pin to 2.x from the start; do not start on 1.x.
- **SoftHSM2 on CI**: needs `libsofthsm2.so` in the CI image;
  straightforward on Ubuntu runners, needs a Homebrew step on macOS.
