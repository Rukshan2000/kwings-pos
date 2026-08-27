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

`Print Bill` calls the webview print dialog. Print CSS (`src/styles.css`) hides the
UI and renders only the receipt at `@page { size: 80mm auto; margin: 0 }`, so any
80 mm thermal printer works through its normal Windows driver. For a 58 mm printer,
change both `80mm` values to `58mm`.

## Customizing

- Shop name, phone, website, currency and footer lines: `src/shop.ts`
- Quick-pick product buttons: `CATALOG` in `src/shop.ts`
- Logo on the receipt: replace `public/logo.png`
- App/installer icon: replace `app-icon.png`, then run `npx tauri icon app-icon.png`
