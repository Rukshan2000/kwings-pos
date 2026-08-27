//! The POS checkout itself. Phase 6.
//!
//! `complete_sale` is the single most important transaction in the whole
//! application: invoice number, sale header, every line, every payment, and every
//! stock_movement row must land together or not at all (PLAN.md: "sales are
//! atomic"). Held sales let a cashier park a cart and come back to it, and are
//! deliberately kept out of the stock ledger until the sale actually completes —
//! a held sale that is never resumed must not have reserved stock forever.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use crate::db::{AppDb, DbError};

#[derive(Deserialize)]
pub struct SaleLineInput {
    pub product_id: i64,
    pub unit_id: i64,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    pub discount_amount: Decimal,
}

#[derive(Deserialize)]
pub struct PaymentInput {
    pub method: String, // 'cash' | 'card' | 'bank_transfer' | 'credit'
    pub amount: Decimal,
}

#[derive(Deserialize)]
pub struct CheckoutInput {
    /// Present when completing a previously held sale — its lines are replaced
    /// rather than a new sale being created, so the same invoice slot is reused.
    pub held_sale_id: Option<i64>,
    pub customer_id: Option<i64>,
    pub lines: Vec<SaleLineInput>,
    pub payments: Vec<PaymentInput>,
    pub discount_total: Decimal,
}

#[derive(Serialize, FromRow)]
pub struct SaleSummary {
    pub id: i64,
    pub invoice_number: Option<String>,
    pub grand_total: Decimal,
    pub balance_due: Decimal,
}

#[derive(Serialize, FromRow)]
pub struct HeldSale {
    pub id: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub line_count: i64,
    pub subtotal: Decimal,
}

fn default_location() -> i64 {
    1
}

/// Gapless per-day invoice number. `SELECT ... FOR UPDATE` inside the sale's own
/// transaction serializes concurrent sales — deliberate, and fine for one till
/// (see docs/schema.md). A `SEQUENCE` was rejected because it advances even on a
/// rolled-back transaction, which would leave gaps in printed invoice numbers.
async fn next_invoice_number(tx: &mut Transaction<'_, Postgres>) -> Result<String, DbError> {
    let prefix = "INV";
    let today = chrono::Utc::now().date_naive();

    sqlx::query("INSERT INTO invoice_counter (prefix, day, next_seq) VALUES ($1, $2, 1) ON CONFLICT DO NOTHING")
        .bind(prefix)
        .bind(today)
        .execute(&mut **tx)
        .await?;

    let seq: i32 = sqlx::query_scalar(
        "SELECT next_seq FROM invoice_counter WHERE prefix = $1 AND day = $2 FOR UPDATE",
    )
    .bind(prefix)
    .bind(today)
    .fetch_one(&mut **tx)
    .await?;

    sqlx::query("UPDATE invoice_counter SET next_seq = next_seq + 1 WHERE prefix = $1 AND day = $2")
        .bind(prefix)
        .bind(today)
        .execute(&mut **tx)
        .await?;

    Ok(format!("{prefix}-{}-{seq:04}", today.format("%Y%m%d")))
}

/// A sale line's unit may not be the product's base unit; converts through
/// `product_unit.factor` the same way purchasing does. Kept private to this
/// module rather than shared with `purchasing` — the two call sites differ
/// enough (this one runs inside an existing checkout loop) that a shared helper
/// would need its own transaction-borrow plumbing for no real gain yet.
async fn to_base_qty(
    tx: &mut Transaction<'_, Postgres>,
    product_id: i64,
    unit_id: i64,
    qty: Decimal,
) -> Result<Decimal, DbError> {
    let base_unit_id: i64 = sqlx::query_scalar("SELECT base_unit_id FROM product WHERE id = $1")
        .bind(product_id)
        .fetch_one(&mut **tx)
        .await?;
    if unit_id == base_unit_id {
        return Ok(qty);
    }
    let factor: Decimal =
        sqlx::query_scalar("SELECT factor FROM product_unit WHERE product_id = $1 AND unit_id = $2")
            .bind(product_id)
            .bind(unit_id)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or_else(|| {
                DbError::Conflict(format!(
                    "product {product_id} has no conversion factor for unit {unit_id}"
                ))
            })?;
    Ok(qty * factor)
}

/// Saves the current cart without affecting stock or invoice numbering — both of
/// those only happen at `complete_sale`.
#[tauri::command]
pub async fn hold_sale(
    state: tauri::State<'_, AppDb>,
    customer_id: Option<i64>,
    lines: Vec<SaleLineInput>,
) -> Result<i64, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    if lines.is_empty() {
        return Err(DbError::Conflict("cannot hold an empty cart".into()));
    }

    let mut tx = db.pool.begin().await?;
    let subtotal: Decimal = lines.iter().map(|l| l.quantity * l.unit_price - l.discount_amount).sum();

    let sale_id: i64 = sqlx::query_scalar(
        "INSERT INTO sale (location_id, customer_id, status, subtotal, grand_total)
         VALUES ($1, $2, 'held', $3, $3) RETURNING id",
    )
    .bind(default_location())
    .bind(customer_id)
    .bind(subtotal)
    .fetch_one(&mut *tx)
    .await?;

    for line in &lines {
        insert_sale_line(&mut tx, sale_id, line).await?;
    }

    tx.commit().await?;
    Ok(sale_id)
}

async fn insert_sale_line(
    tx: &mut Transaction<'_, Postgres>,
    sale_id: i64,
    line: &SaleLineInput,
) -> Result<(), DbError> {
    let line_total = line.quantity * line.unit_price - line.discount_amount;
    sqlx::query(
        "INSERT INTO sale_line (sale_id, product_id, unit_id, quantity, unit_price, discount_amount, line_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(sale_id)
    .bind(line.product_id)
    .bind(line.unit_id)
    .bind(line.quantity)
    .bind(line.unit_price)
    .bind(line.discount_amount)
    .bind(line_total)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn list_held_sales(state: tauri::State<'_, AppDb>) -> Result<Vec<HeldSale>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(sqlx::query_as(
        "SELECT s.id, s.created_at, s.customer_id, c.name AS customer_name,
                COUNT(l.id) AS line_count, s.subtotal
         FROM sale s
         LEFT JOIN customer c ON c.id = s.customer_id
         LEFT JOIN sale_line l ON l.sale_id = s.id
         WHERE s.status = 'held'
         GROUP BY s.id, c.name
         ORDER BY s.created_at DESC",
    )
    .fetch_all(&db.pool)
    .await?)
}

/// Only a held sale can be cancelled here — a completed sale has already moved
/// stock and taken payment, and undoing that is the returns flow, not this one.
#[tauri::command]
pub async fn cancel_held_sale(state: tauri::State<'_, AppDb>, id: i64) -> Result<(), DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let mut tx = db.pool.begin().await?;
    let status: String = sqlx::query_scalar("SELECT status::text FROM sale WHERE id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if status != "held" {
        return Err(DbError::Conflict(format!(
            "sale is '{status}', not 'held' — only a held sale can be cancelled this way"
        )));
    }
    sqlx::query("DELETE FROM sale_line WHERE sale_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE sale SET status = 'cancelled' WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// The atomic checkout: assigns the invoice number, (re)writes the sale's lines,
/// writes one negative `stock_movement` per line (converted to base unit),
/// records payments, computes `balance_due` for credit sales, and marks the sale
/// completed — all in one transaction, or none of it happens.
#[tauri::command]
pub async fn complete_sale(
    state: tauri::State<'_, AppDb>,
    input: CheckoutInput,
) -> Result<SaleSummary, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    if input.lines.is_empty() {
        return Err(DbError::Conflict("a sale needs at least one line".into()));
    }

    let subtotal: Decimal = input
        .lines
        .iter()
        .map(|l| l.quantity * l.unit_price)
        .sum();
    let grand_total = subtotal - input.discount_total;
    let paid: Decimal = input.payments.iter().map(|p| p.amount).sum();
    let balance_due = (grand_total - paid).max(Decimal::ZERO);

    let mut tx = db.pool.begin().await?;

    let sale_id = match input.held_sale_id {
        Some(id) => {
            let status: String = sqlx::query_scalar("SELECT status::text FROM sale WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            if status != "held" {
                return Err(DbError::Conflict(format!(
                    "sale is '{status}', not 'held' — it cannot be completed again"
                )));
            }
            sqlx::query("DELETE FROM sale_line WHERE sale_id = $1").bind(id).execute(&mut *tx).await?;
            id
        }
        None => {
            sqlx::query_scalar("INSERT INTO sale (location_id, status, subtotal, grand_total) VALUES ($1, 'held', 0, 0) RETURNING id")
                .bind(default_location())
                .fetch_one(&mut *tx)
                .await?
        }
    };

    let invoice_number = next_invoice_number(&mut tx).await?;

    for line in &input.lines {
        insert_sale_line(&mut tx, sale_id, line).await?;

        let base_qty = to_base_qty(&mut tx, line.product_id, line.unit_id, line.quantity).await?;
        sqlx::query(
            "INSERT INTO stock_movement (product_id, location_id, quantity, reason, ref_table, ref_id)
             VALUES ($1, $2, $3, 'sale', 'sale', $4)",
        )
        .bind(line.product_id)
        .bind(default_location())
        .bind(-base_qty)
        .bind(sale_id)
        .execute(&mut *tx)
        .await?;
    }

    for payment in &input.payments {
        sqlx::query("INSERT INTO sale_payment (sale_id, method, amount) VALUES ($1, $2::payment_method, $3)")
            .bind(sale_id)
            .bind(&payment.method)
            .bind(payment.amount)
            .execute(&mut *tx)
            .await?;
    }

    sqlx::query(
        "UPDATE sale SET invoice_number = $1, customer_id = $2, status = 'completed',
                          subtotal = $3, discount_total = $4, grand_total = $5,
                          balance_due = $6, completed_at = now()
         WHERE id = $7",
    )
    .bind(&invoice_number)
    .bind(input.customer_id)
    .bind(subtotal)
    .bind(input.discount_total)
    .bind(grand_total)
    .bind(balance_due)
    .bind(sale_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(SaleSummary {
        id: sale_id,
        invoice_number: Some(invoice_number),
        grand_total,
        balance_due,
    })
}

/// Everything the receipt printer needs, shaped like the existing `Bill` type in
/// `src/types.ts` so `buildReceipt()` in escpos.ts needs no changes to accept it.
#[derive(Serialize, FromRow)]
pub struct ReceiptLine {
    pub name: String,
    pub qty: Decimal,
    pub price: Decimal,
}

#[derive(Serialize)]
pub struct ReceiptData {
    pub invoice_number: String,
    pub completed_at: chrono::DateTime<chrono::Utc>,
    pub lines: Vec<ReceiptLine>,
}

#[tauri::command]
pub async fn sale_receipt(state: tauri::State<'_, AppDb>, sale_id: i64) -> Result<ReceiptData, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    receipt_for(&db.pool, sale_id).await
}

async fn receipt_for(pool: &PgPool, sale_id: i64) -> Result<ReceiptData, DbError> {
    let (invoice_number, completed_at): (Option<String>, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as("SELECT invoice_number, completed_at FROM sale WHERE id = $1")
            .bind(sale_id)
            .fetch_one(pool)
            .await?;

    let lines = sqlx::query_as(
        "SELECT p.name, l.quantity AS qty, l.unit_price AS price
         FROM sale_line l JOIN product p ON p.id = l.product_id
         WHERE l.sale_id = $1 ORDER BY l.id",
    )
    .bind(sale_id)
    .fetch_all(pool)
    .await?;

    Ok(ReceiptData {
        invoice_number: invoice_number.unwrap_or_default(),
        completed_at: completed_at.unwrap_or_else(chrono::Utc::now),
        lines,
    })
}
