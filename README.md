# kwings-pos — Green Plus Argo POS

Desktop POS (Tauri v2 + Vite + React + TypeScript) that builds a bill and prints an
80 mm thermal receipt matching the Green Plus Argo layout.

## Requirements

- Node.js 20+
- Rust stable (https://rustup.rs)
- Windows: Microsoft C++ Build Tools + WebView2 (bundled on Win 10/11)

## Develop

```bash
npm install
npm run tauri dev
```

## Build the EXE locally

```bash
npm run tauri build
```

Outputs land in `src-tauri/target/release/`:

- `Green Plus POS.exe` — the raw executable
- `bundle/nsis/*.exe` — installer
- `bundle/msi/*.msi` — MSI installer

## Build the EXE on GitHub

`.github/workflows/build.yml` builds on `windows-latest` for every push to `main`,
every PR, and manual runs. The installers are uploaded as the
`greenplus-pos-windows` artifact.

Pushing a tag also publishes a GitHub Release with the binaries attached:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Printing

Receipts are sent to the printer as **raw ESC/POS bytes through the Windows
spooler** (`RAW` datatype). There is no print dialog and no driver page rendering,
so the layout cannot be broken by the driver's paper settings.

- One click on `Print Bill` prints and cuts. No confirmation.
- Layout is fixed at 80 mm / 48 columns / 576 dots (`COLS` and `DOTS` in
  `src/escpos.ts`). For a 58 mm printer use `COLS = 32`, `DOTS = 384`.
- The logo is rasterized in the browser to a `GS v 0` bitmap. If it fails to
  load, the receipt still prints without it.
- `Settings` lists the installed Windows printers and saves the chosen one.
  Leave it on "Windows default" to follow the system default printer.
- Optionally pulses the cash drawer (`ESC p 0 25 250`) on the printer's RJ11 port.

Setup on the shop PC: install the printer's Windows driver as usual, run the app,
open `Settings`, pick the printer, Save. Nothing else to configure.

Outside the desktop shell (`npm run dev` opened in a plain browser) there is no
spooler access, so it falls back to the browser print dialog using the 80 mm print
CSS in `src/styles.css`.

## Customizing

- Shop name, phone, website, currency and footer lines: `src/shop.ts`
- Quick-pick product buttons: `CATALOG` in `src/shop.ts`
- Logo on the receipt and on the printout: replace `public/logo.png`
- Receipt byte layout, cut and drawer commands: `src/escpos.ts`
- App/installer icon: replace `app-icon.png`, then run `npx tauri icon app-icon.png`
