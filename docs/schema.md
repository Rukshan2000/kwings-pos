# Data model

Complete MVP schema, written once in `0002_mvp_schema.sql` (phase 2) so later
phases build features on top of it rather than reshaping core tables.

## Conventions

| Concern | Rule |
|---|---|
| Money | `NUMERIC(14,2)`. Never `float`/`double`. `rust_decimal::Decimal` in Rust — see `src-tauri/src/domain/money.rs`. |
| Quantity | `NUMERIC(14,3)`, to carry kg and litre fractions. |
| Stock | Always stored in the product's **base unit**. Conversion happens at the edges — see `src-tauri/src/domain/units.rs`. |
| Time | `timestamptz`, always UTC in the database. |
| Identity | `bigint GENERATED ALWAYS AS IDENTITY`. |
| Ledgers | Append-only. `stock_movement`, `sale_payment`, `audit_log` etc. are never `UPDATE`d or `DELETE`d; a correction is a new row. |
| Deletion | Soft (`archived_at`) for anything a historical document might reference — products, customers, suppliers, categories, units. |

## Migrations

Versioned, forward-only, applied automatically at startup via `sqlx::migrate!`,
tracked in `_sqlx_migrations`. Re-running an already-applied set is a no-op —
asserted by `bootstrap_migrate_backup_and_shutdown` in `src-tauri/tests/bootstrap.rs`.

| File | Purpose |
|---|---|
| `0001_bootstrap.sql` | Proves the migration runner. One table, `app_setting`. |
| `0002_mvp_schema.sql` | Full MVP schema, described below. |
| `0003_seed.sql` | Units, default location, payment methods, expense categories, one admin user. |

## Users, roles, shifts

- **`app_user`** — `role` is `admin` / `manager` / `cashier`. `password_hash` is
  Argon2id (`argon2` crate, defaults: m=64 MiB, t=3, p=4). Permission checks happen
  in Rust, not the UI — `user_permission` lets an individual user's rights be
  overridden above or below their role's default.
- **`audit_log`** — one row per recorded action. `entity`/`entity_id` point at
  whatever was changed; `detail` is free-form `jsonb`.
- **`cashier_shift`** — opening/closing cash and `variance` (closing − expected).
  Only one open shift per user, enforced by a partial index.
- **`cash_movement`** — withdrawals/deposits during a shift that are not sales
  (expenses paid from the till, owner drops). Sales affect cash through `sale` and
  `sale_payment`, not duplicated here.

## Catalogue

- **`product`** — one row per SKU. `base_unit_id` is the unit stock is always held
  in; `cost_price`/`selling_price` are the defaults, overridable per tier.
- **`product_unit`** — alternate units for a product with a `factor` relative to the
  base unit (1 box = 12 pc → `factor = 12`). Each can carry its own barcode, so
  scanning a box barcode and a piece barcode both resolve to the same product.
- **`product_price_tier`** — retail/wholesale, with `min_qty` for bulk breaks. A
  product can have many rows; the sale logic picks the best-matching tier for the
  unit and quantity being sold.
- **`category`**, **`brand`**, **`unit`** — reference tables, soft-deletable.

## Inventory

- **`stock_movement`** — the ledger. Every stock change of any kind is one signed
  row (`+` in, `-` out) in the product's base unit; current stock is
  `sum(quantity)` grouped by product and location. `ref_table`/`ref_id` point at
  whatever caused the movement (a sale, a purchase, ...) without being a foreign
  key, since the referenced table varies by `reason` and the ledger row must
  outlive application-level cleanup of the source document.
- **`stock_transfer`** / **`stock_transfer_line`** — between locations. The MVP UI
  is single-location, but the schema exists now so a second location is a
  UI/feature change, not a migration.
- **`location`** — a partial unique index guarantees exactly one `is_default` row.

## Purchasing

`supplier` → `purchase` → `purchase_line`, with `purchase_payment` tracking partial
payment against `purchase.total` (outstanding = `total - paid`) and
`purchase_return`/`purchase_return_line` reversing specific lines.

## Sales

- **`invoice_counter`** — gapless per-day numbering. **Deliberately not a
  `SEQUENCE`**: a sequence advances even on a rolled-back transaction, which would
  leave gaps in printed invoice numbers. Instead the sale transaction does
  `SELECT next_seq FROM invoice_counter WHERE prefix = $1 AND day = $2 FOR UPDATE`,
  which serializes concurrent sales — a deliberate bottleneck, acceptable for one
  till, worth revisiting before a second till is added.
- **`sale`** → **`sale_line`** → **`sale_payment`** — a sale can split across
  payment methods (`payment_method`: cash/card/bank_transfer/credit); a credit sale
  simply has payments totalling less than `grand_total`, tracked in
  `sale.balance_due`.
- **`sale_discount`** — records what was applied and, for anything above the
  configured limit, `authorized_by` — the manager-authorization requirement.
- **`sale_return`** / **`sale_return_line`** — against specific `sale_line` rows,
  full or partial; stock restoration happens via a `sale_return` row in
  `stock_movement`, never by editing the original sale.

## Customers & suppliers

`customer.credit_limit` and `customer.loyalty_points` (an explicit Phase 2
*product* extension point — the loyalty feature, not this schema phase — so it
never needs a migration to land). `customer_payment` and `purchase_payment` are
append-only against their respective outstanding balances.

## Expenses

`expense_category` → `expense`, optionally tied to a `cashier_shift` so a shift's
cash-out total includes expenses paid from the till.

## Settings

`app_setting` (from phase 1) holds free-form `jsonb` config — invoice numbering
format, tax rate, receipt text — so Settings can grow without a migration.
`payment_method_setting` is the one setting that needed real structure: which
payment methods this shop accepts.
