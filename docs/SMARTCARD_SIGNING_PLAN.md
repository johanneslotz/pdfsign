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

### Option F — WebUSB/WebHID + custom CCID stack

Theoretically possible. In practice means writing an APDU layer for every
card OS (NXP JCOP, Gemalto IDPrime, Athena IDProtect, …). Months of work,
fragile, no PIN-pad readers, blocked by enterprise USB policies. **Not
recommended.**

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
