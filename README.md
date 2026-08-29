# kwings-pos — POS MASTER (for Green Plus Argo)

Offline-first retail POS for Windows. Tauri v2 + Vite + React + TypeScript, with a
**bundled portable PostgreSQL** and raw ESC/POS receipt printing.

The shop owner installs one `.exe`. There is no database to install, no service to
configure, and no internet required at any point.

Build progress lives in [PLAN.md](PLAN.md); the data model in [docs/schema.md](docs/schema.md).

## Requirements

- Node.js 20+
- Rust stable (https://rustup.rs)
- Windows builds: Microsoft C++ Build Tools + WebView2 (bundled on Win 10/11)

## Develop

```bash
npm install          # also fetches the PostgreSQL binaries via postinstall
npm run tauri dev
```

`npm install` runs [scripts/fetch-postgres.mjs](scripts/fetch-postgres.mjs), which
downloads PostgreSQL 17.11.0 for your platform, verifies its SHA-256, extracts it to
`src-tauri/resources/pgsql`, and strips everything the app never calls (~30 MB left).

The binaries are **not** in git — 54 MB per platform would sit in every clone
forever. Re-run it any time with `npm run pg:fetch`.

## Tests

```bash
cd src-tauri && cargo test --test bootstrap -- --test-threads=1
```

Exercises the real thing end to end: `initdb`, server start, migrations, `pg_dump`
backup, clean shutdown, cluster reuse across restarts, and stale-pidfile recovery.
Needs the fetched binaries; runs on macOS and Windows.

## Build the EXE

```bash
npm run tauri build
```

Outputs in `src-tauri/target/release/`: the raw `.exe`, `bundle/nsis/*.exe`
(installer), `bundle/msi/*.msi`. PostgreSQL ships inside as a Tauri resource.

`.github/workflows/build.yml` runs three jobs on `windows-latest`:

| Job | What it proves |
|---|---|
| `test` | The Windows-only code paths compile and the bootstrap works |
| `build` | Installers build; uploaded as `greenplus-pos-windows` |
| `smoke` | On a clean machine: silent install, first-launch `initdb`, migrations applied, `pg_dump` works, and **no orphan `postgres.exe` after the app is force-killed** |

Pushing a `v*` tag publishes a GitHub Release once all three pass.

## Database

PostgreSQL runs as a child of the app, bound to `127.0.0.1` on a persisted free port,
with a generated 40-character password.

- **Data directory:** `%PROGRAMDATA%\GreenPlusPOS\pgdata`. Deliberately shared rather
  than per-user — the installer is `perMachine`, and `%LOCALAPPDATA%` would give every
  Windows account its own invisible database. The NSIS hook grants the built-in Users
  group write access at install time.
- **No orphans:** the server is assigned to a Windows Job Object with
  `KILL_ON_JOB_CLOSE`, so the OS reaps it even if the app crashes. Normal exit does a
  `pg_ctl stop -m fast` first to avoid recovery on the next start.
- **Migrations** are versioned, forward-only, and applied automatically at startup
  from `src-tauri/migrations`.
- **Backup:** `Settings → Backup now` writes a compressed `pg_dump` custom-format
  archive to `Documents\GreenPlusPOS Backups`.
- Uninstalling the app **does not** delete the database.

Startup is asynchronous, so the window paints immediately and shows progress while
first-run `initdb` completes.

## Printing

Receipts go to the printer as **raw ESC/POS bytes through the Windows spooler**
(`RAW` datatype) — no print dialog, no driver page rendering, so the layout cannot be
broken by the driver's paper settings.

- One click on `Print Bill` prints and cuts.
- Fixed at 80 mm / 48 columns / 576 dots (`COLS` and `DOTS` in `src/escpos.ts`).
  For a 58 mm printer use `COLS = 32`, `DOTS = 384`.
- The logo is rasterized to a `GS v 0` bitmap; a missing logo never blocks a sale.
- `Settings` lists installed Windows printers. Leave it on "Windows default" to
  follow the system default.
- Optional cash-drawer pulse (`ESC p 0 25 250`) on the printer's RJ11 port.

In a plain browser (`npm run dev`) there is no spooler, so it falls back to the
browser print dialog using the 80 mm print CSS in `src/styles.css`.

## Layout

```
src/                     React UI
  escpos.ts              receipt byte stream (48 cols, logo raster, cut, drawer)
  printer.ts             printer selection + print entry point
  db.ts                  database status and backup calls
src-tauri/
  src/printing.rs        winspool RAW printing
  src/db/                server supervisor, config, migrations, backup, commands
  migrations/            versioned SQL, applied at startup
  resources/pgsql/       bundled PostgreSQL (fetched, gitignored)
  installer.nsh          NSIS hook: shared data dir + ACL
scripts/fetch-postgres.mjs
```

## Customizing

- Shop name, phone, website, currency, footer lines: `src/shop.ts`
- Quick-pick product buttons: `CATALOG` in `src/shop.ts`
- Receipt logo: replace `public/logo.png`
- Receipt byte layout, cut and drawer commands: `src/escpos.ts`
- App/installer icon: replace `app-icon.png`, then `npx tauri icon app-icon.png`
