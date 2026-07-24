# pdfsign

A PDF signing app built entirely through vibe coding with [Claude Code](https://claude.ai/code) — no manual coding involved. Open PDFs, place handwritten signatures, fill form fields, and apply cryptographic PAdES signatures using a hardware smartcard (electronic ID card, YubiKey, or any OpenSC-compatible USB token).

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Open & view PDFs** — drag-and-drop or file picker, multi-page rendering via PDF.js
- **Handwritten signatures** — draw on a canvas, import a photo or scan, or re-use saved signatures
- **Photo import** — crop, rotate and de-skew a snapshot of a signature, then lift the ink off the
  paper onto a transparent background with an adjustable threshold (see below)
- **Free-text annotations** — click anywhere on a page to add typed text
- **AcroForm support** — existing PDF form fields are rendered as editable overlays
- **Cryptographic signing** — PAdES B-B signatures via smartcard (desktop app only)
- **AI form fill** — vision-based assistant that reads the PDF and suggests field values
- **Works offline** — pure static frontend, no server required for the web version

## Importing a signature from a photo

Open **Signature → Import → PNG / JPG** and pick a photo or scan. Instead of stamping the
picture in as-is, an editor opens:

- **Drag the four corners** around the signature to crop, and to pull a phone snapshot
  square again — the corners map to the output rectangle, so a photo taken at an angle
  comes out flat. The filled corner marks the top-left of the result.
- **⟲ / ⟳ 90°** re-orient a sideways scan, and **Straighten** takes out a small tilt.
- **Threshold** decides what counts as ink. It starts on a value detected from the image;
  **Auto** returns to it.
- **Despeckle** drops shapes smaller than the slider allows, which clears paper grain and dust.
- **Ink** defaults to the pen colour measured from the photo, and can be overridden or forced
  to black.

The result is saved as a transparent PNG, so only the strokes are stamped onto the PDF — no
white box, no page background. **Use unprocessed** skips all of this and stores the image as-is.

Robustness comes from thresholding *relative paper brightness* rather than raw pixel values:
the paper's own illumination is estimated and divided out first, so shadows and colour casts
don't shift the cut-off, and coloured ink is scored on whichever channel it darkens most.
See `js/signature-image.js`.

## Download

Pre-built binaries are produced by CI for every push to `main`:

| Platform | Format | Notes |
|---|---|---|
| Linux x86-64 | `.deb`, `.AppImage` | Requires OpenSC (`apt install opensc`) for smartcard |
| Linux arm64 | `.deb`, `.AppImage` | Same OpenSC requirement |
| macOS (Apple Silicon & Intel) | `.dmg` | Unsigned — see launch instructions below |

Download from the [Releases](../../releases) page or the **Actions** tab (artifact from the latest build).

---

## Getting started

### Web (no install)

Serve the repo root with any static file server:

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080`. Smartcard signing is not available in the browser — all other features work.

---

### Linux

**Install OpenSC** (required for smartcard signing):

```bash
# Debian / Ubuntu
sudo apt install opensc

# Fedora / RHEL
sudo dnf install opensc

# Arch
sudo pacman -S opensc
```

**AppImage** (no install needed):

```bash
chmod +x pdfsign_*.AppImage
./pdfsign_*.AppImage
```

**Debian package**:

```bash
sudo dpkg -i pdfsign_*.deb
pdfsign
```

---

### macOS

The DMG is **unsigned** (no Apple Developer certificate). macOS will block it on first launch.

**Step 1 — Mount the DMG and drag the app to Applications.**

**Step 2 — First launch (one-time only):**

- In Finder, **right-click** `pdfsign.app` → **Open**
- Click **Open** in the security dialog

Or from Terminal:

```bash
xattr -cr /Applications/pdfsign.app
open /Applications/pdfsign.app
```

After the first approved launch, the app opens normally by double-clicking.

**Smartcard support** requires OpenSC:

```bash
brew install opensc
```

---

## Building from source

**Prerequisites:**

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 20+
- Tauri CLI: `cargo install tauri-cli --version "^2" --locked`
- **Linux:** `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libpcsclite-dev`
- **macOS:** `brew install opensc`

**Run in development:**

```bash
npm install
cargo tauri dev
```

**Build a native bundle:**

```bash
cargo tauri build
# Outputs in src-tauri/target/release/bundle/
```

---

## Running tests

```bash
npm install
npx playwright install chromium --with-deps
npx playwright test --project=desktop
```

Rust unit tests (signing pipeline):

```bash
cd src-tauri
cargo test --lib
```

---

## How it was built

This project was built entirely through **vibe coding** — every line of code was written by [Claude Code](https://claude.ai/code) (Anthropic's CLI coding agent) in response to natural-language prompts. No manual coding was done by the human author.

The development flow:
1. Describe a feature or fix in plain language
2. Claude Code researches the codebase, plans the change, and implements it
3. Review, test, iterate

Areas Claude Code handled autonomously:
- PAdES B-B cryptographic signing pipeline (Rust, `lopdf`, `cryptoki`, hand-rolled CMS/DER)
- Tauri 2 IPC bridge between the web frontend and native Rust commands
- PKCS#11 smartcard integration via OpenSC
- Playwright end-to-end test suite (41 tests)
- GitHub Actions CI/CD for Linux x86-64, Linux arm64, and macOS
- Debugging macOS entitlement crashes, CI flakiness, and modal z-index bugs

## Architecture

```
pdfsign/
├── index.html          # Single-page app entry point
├── css/style.css       # All styles
├── js/
│   ├── app.js          # Main controller
│   ├── pdf-viewer.js   # PDF.js rendering + overlay management
│   ├── pdf-editor.js   # pdf-lib write-back (annotations, signatures)
│   ├── signature-pad.js
│   ├── signature-image.js   # photo → transparent signature (threshold, despeckle, warp)
│   ├── signature-import.js  # crop / rotate / threshold editor shown on import
│   ├── ai-assistant.js # Vision API form fill
│   └── sign/
│       ├── orchestrator.js   # Tauri detection + dispatch
│       └── tauri-provider.js # IPC calls to Rust backend
├── vendor/             # Vendored PDF.js and pdf-lib (no CDN dependency)
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs
│   │   └── commands/
│   │       ├── sign.rs    # PAdES signing, CMS/DER, ByteRange
│   │       ├── pkcs11.rs  # OpenSC / PKCS#11 certificate enumeration
│   │       └── file.rs    # Native open/save dialogs
│   └── tauri.conf.json
└── tests/e2e/          # Playwright tests
```

## License

MIT
