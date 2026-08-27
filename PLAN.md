# Retail POS — Build Plan

Living document. Updated at every phase gate.

Status legend: `TODO` · `IN PROGRESS` · `AWAITING SIGN-OFF` · `DONE`

## What exists today

Tauri v2 + Vite + React 18 + TypeScript. A single-screen biller with no persistence:
cart in `useState`, printer choice in `localStorage`, shop details hardcoded in
`src/shop.ts`.

Raw ESC/POS printing works and is **not** being rewritten:

- `src-tauri/src/printing.rs` — winspool `OpenPrinterW` → `StartDocPrinterW(RAW)` →
  `WritePrinter`. Untouched by this project.
- `src/escpos.ts` — `buildReceipt(bill, logo, drawer)` → bytes. 48 cols, `GS v 0`
  logo raster, auto-cut, drawer kick. In phase 6 it is fed DB rows instead of
  `useState`; its signature is the seam.

## Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Datastore | Bundled PostgreSQL 16 | Real `NUMERIC`, and a multi-till/central-server future |
| Distribution | EnterpriseDB "binaries only" zip as a Tauri `resources` entry | `pg_dump`/`pg_restore` must be real files on disk for backup anyway; avoids embedding ~120 MB into the exe and fighting the LTO profile |
| Rejected | `pg-embed` | Unmaintained; fetches binaries at runtime — dead offline |
| Rejected | `postgresql_embedded` (bundled) | Embeds the archive in the binary, then unpacks to disk anyway — pays the cost twice |
| Data dir | `%PROGRAMDATA%\GreenPlusPOS\pgdata`, ACL for Users | Installer is `perMachine`; `%LOCALAPPDATA%` would give each Windows user a separate, invisible database |
| Process safety | Windows **Job Object** + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | Parent/child alone does not stop orphan `postgres.exe` when the app is killed |
| Money / qty | `NUMERIC(14,2)` / `NUMERIC(14,3)`, `rust_decimal` in Rust | Never `f32`/`f64` |
| Frontend | React Router + TanStack Query over `invoke()` | 14 screens; reports and dashboard need real caching and invalidation |
| Verification | CI smoke test on `windows-latest`, owner signs off on real hardware | No Windows machine, no `rustup` target, no thermal printer available to Claude |

### Consequences to honour

- **Drop `panic = "abort"`** from the release profile — it skips destructors, leaking
  the Postgres child and the connection pool on panic.
- **`sqlx` offline cache** (`cargo sqlx prepare`) must be committed and refreshed
  whenever SQL changes, or the Windows CI build fails. Compile-time checking is used
  for the complex reporting queries; runtime queries elsewhere.
- **Invoice numbers are not a `SEQUENCE`.** Sequences leak on rollback. Gapless
  per-day numbering uses a counter row with `SELECT … FOR UPDATE` inside the sale
  transaction. This deliberately serializes concurrent sales — correct for one till.
- Postgres binaries are trimmed: no `include/`, `pgAdmin`, `doc/`, `symbols/`, or
  most of `share/locale`. ~250 MB on disk, ~70 MB added to the NSIS installer.

## Open risks

- The Windows-only Rust cannot be compiled on the development machine. CI is the
  first real compile of every `src-tauri` change.
- Postgres data directories can corrupt on power loss. Auto-backup is the mitigation;
  a UPS on the till is the real one.
- Phase 1 rests on CI being green after the `Win32_Graphics_Gdi` fix (`ba3ad3d`).

## Phases

Each phase stops for testing and sign-off before the next begins.

### 1 — Postgres bootstrap · `TODO`
Resource bundling; Job Object supervisor; `initdb`, start on free `127.0.0.1` port,
clean shutdown; generated role password in app config; stale `postmaster.pid`
recovery; migration runner; CI clean-install smoke test (silent `/S` install →
launch → assert migrated → `pg_dump` non-empty → uninstall → assert no surviving
`postgres.exe`).
**Gate:** installs and runs on a real till, leaves no orphan process.

### 2 — Schema · `TODO`
Complete MVP schema + migrations + seed data + `docs/schema.md`. Written **once**,
covering phases 3–10, including multi-location and loyalty columns so they are never
retrofitted. Tests for money, stock and unit-conversion math land here.
**Gate:** schema review before any feature is built on it.

### 3 — Catalogue · `TODO`
Products, categories, brands, units + conversions (base unit + factors, stock always
stored in base unit), price tiers (cost, retail, wholesale, quantity breaks).

### 4 — Inventory · `TODO`
Opening stock, stock-in/out, adjustments with reason, transfers, current stock,
low-stock thresholds, valuation. Append-only movement ledger — movement rows are
never mutated.

### 5 — Purchasing · `TODO`
Suppliers, purchase entry + invoice, stock intake, purchase returns, supplier
outstanding.

### 6 — POS · `TODO`
Keyboard-first billing screen, barcode wedge capture, discounts, tax, split payments,
hold/resume/cancel, receipt print + reprint. Existing ESC/POS path is wired to real
sale records here.

### 7 — Returns & discounts · `TODO`
Returns against an invoice (partial or full), auto stock restore, refunds, discount
limits, manager authorization prompt.

### 8 — Customers & credit · `TODO`
Customers, purchase history, credit limits, outstanding balance, payments,
statements.

### 9 — Users & shifts · `TODO`
Roles (Admin/Manager/Cashier), Argon2 passwords, permissions **enforced in Rust**,
cashier shifts with opening/closing cash and variance, audit log.

### 10 — Reports & operations · `TODO`
Expenses, sales/inventory/financial reports with CSV export and print, dashboard,
settings, backup/restore with auto-backup folder.
