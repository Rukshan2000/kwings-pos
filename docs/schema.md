# Data model

> Phase 1 only. The full MVP schema arrives in phase 2 and this document grows with
> it — products, stock ledger, sales, payments, customers, suppliers, users.

## Conventions

These hold for every table added from phase 2 onward.

| Concern | Rule |
|---|---|
| Money | `NUMERIC(14,2)`. Never `float`/`double`. `rust_decimal::Decimal` in Rust. |
| Quantity | `NUMERIC(14,3)`, to carry kg and litre fractions. |
| Stock | Always stored in the product's **base unit**. Conversion happens at the edges. |
| Time | `timestamptz`, always UTC in the database. |
| Identity | `bigint` generated as identity, unless a natural key is genuinely stable. |
| Ledgers | Append-only. Stock movement and payment rows are **never** updated or deleted; corrections are new rows. |
| Deletion | Soft delete (`archived_at`) for anything a historical document might reference. |

## Migrations

Versioned, forward-only, applied automatically at startup by `sqlx::migrate!`.
They live in `src-tauri/migrations` and are tracked in `_sqlx_migrations`.

Migrations must be idempotent in effect: re-running the set on an up-to-date
database is a no-op, which the bootstrap test asserts.

## Tables

### `app_setting`

Key/value shop configuration. Values are `jsonb` so a setting can grow from a scalar
into a structure without a migration.

| Column | Type | Notes |
|---|---|---|
| `key` | `text` | Primary key |
| `value` | `jsonb` | |
| `updated_at` | `timestamptz` | Defaults to `now()` |

Seeded with `schema_owner` and `currency`.
