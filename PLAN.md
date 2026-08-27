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
| Distribution | `theseus-rs/postgresql-binaries` **17.11.0** as a Tauri `resources` entry | Replaced the planned EnterpriseDB zip: 54 MB instead of ~250 MB, already trimmed, checksummed, and published for macOS too — which makes the whole bootstrap testable off Windows |
| Binaries in git | **No.** Fetched by `scripts/fetch-postgres.mjs`, cached in CI | 54 MB per platform would live in every clone forever |
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
- **`sqlx` offline cache is not needed yet.** Phase 1 uses runtime-checked
  `query_scalar`/`query_as` rather than the `query!` macros, so no `DATABASE_URL` or
  `.sqlx` directory is required to build. The moment a `query!` macro is introduced
  (likely in the phase 10 reports), `cargo sqlx prepare` output must be committed and
  kept fresh or the Windows build breaks.
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

### 1 — Postgres bootstrap · `AWAITING SIGN-OFF`
Done: fetch script with checksum + trim; resource bundling; Job Object supervisor;
`initdb` with a scram password read from a file; start on a persisted free loopback
port; readiness wait; clean `fast` shutdown; stale `postmaster.pid` recovery via
`pg_ctl status`; version-mismatch guard; migration runner; `pg_dump` backup; NSIS
hook creating `%PROGRAMDATA%\GreenPlusPOS` with a Users ACL; DB status banner and
"Backup now" in Settings; CI `test` + `smoke` jobs.

Verified locally on macOS (3 integration tests: bootstrap→migrate→backup→shutdown,
restart reuses the cluster, stale pidfile cleared). Windows paths verified only by CI.

**Gate:** installs and runs on a real till, leaves no orphan process.

### 2 — Schema · `AWAITING SIGN-OFF`
Done: `0002_mvp_schema.sql` (431 lines) — users/roles/permissions/audit/shifts,
locations, catalogue (products, categories, brands, units, per-product unit
conversions, price tiers), inventory (append-only stock ledger, transfers),
purchasing (suppliers, purchases, payments, returns), sales (gapless per-day
invoice counter, sales, lines, split payments, discounts with authorization,
returns), customers, expenses, payment-method settings. `0003_seed.sql` — units,
default location, payment methods, expense categories, one admin user
(Argon2id-hashed, verified against the `argon2` crate in `tests/argon2_seed.rs`,
not just the tool that generated it). `docs/schema.md` describes every table and
the non-obvious decisions (gapless counter over a SEQUENCE, `ref_table`/`ref_id`
instead of a variant foreign key, loyalty columns present but unused).

`src-tauri/src/domain/{money,units}.rs` — `Decimal`-based money and quantity types,
banker's rounding matching Postgres `NUMERIC` `round()`, discount clamping, unit
conversion. 10 unit tests, plus `tests/schema.rs` asserting the partial-unique and
FK/CHECK constraints actually reject bad data against a real running Postgres.

**Gate:** schema review before any feature is built on it.

### 3 — Catalogue · `AWAITING SIGN-OFF`
Done: `src-tauri/src/catalogue/` — Tauri commands for categories, brands, units,
and full product CRUD (create/update/soft-archive), plus per-product alternate
units with conversion factors and retail/wholesale price tiers with quantity
breaks. SKU/barcode collisions are caught by the DB's unique constraint and
mapped to a specific `ProductSaveError` the frontend can point at the right field,
rather than surfacing raw Postgres text.

Frontend restructured onto React Router + TanStack Query, per the locked decision:
`src/layout/Shell.tsx` (nav + the DB banner, now shown globally instead of only on
the POS screen), `src/pages/Pos.tsx` (the existing biller, moved not rewritten),
`src/pages/Products.tsx` (list/search, create/edit form, quick-add for
category/brand, and per-product unit-conversion and price-tier editors).
`src/api.ts` is the one place that knows the Tauri command shapes.

Verified: `cargo test` — 15 tests total (10 domain unit tests, plus 5 integration
tests against a real running Postgres: bootstrap/migrate/backup/shutdown, cluster
reuse, stale pidfile, schema constraints, and a full product lifecycle including
a real 23505 unique-violation on a duplicate SKU). `npm run build` and `tsc`
clean. **Not verified: the frontend has never been driven against a live Tauri
backend in a browser** — this environment has no way to click through a UI, so
the Products screen's wiring to `invoke()` is type-checked and code-reviewed but
not click-tested.

### 4 — Inventory · `AWAITING SIGN-OFF`
Done: `src-tauri/src/inventory/` — current stock is always `SUM(quantity)` over the
`stock_movement` ledger (never a stored counter, so it cannot drift from the ledger
that is supposed to explain it); low-stock filter; movement history per product;
valuation as `on_hand × current cost_price` (explicitly not FIFO/moving-average —
documented as such in code); opening-stock recording guarded against being run
twice for the same product (would silently double the shop's real stock).
Purchase/sale/transfer movements themselves land in phases 5/6/4-transfer-UI as
those features are built — the ledger and its invariants are what this phase
proves. `src/pages/Inventory.tsx` — stock table with low-stock filter and
highlighting, adjustment/opening-stock form, movement history panel.

Verified: 3 new integration tests against real Postgres — ledger sum matches
hand-computed stock after opening/sale/adjustment rows, the ledger keeps all rows
rather than merging them, the double-opening-stock guard, and the low-stock
boundary condition (`on_hand <= threshold`, not `<`). 18 Rust tests total.
`npm run build` clean. Frontend not click-tested (see phase 3 note — unchanged).

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
