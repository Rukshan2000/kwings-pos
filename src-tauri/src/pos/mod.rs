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
use crate::domain::money::{bill_totals, Discount, PricedLine, Totals};

/// A discount as the till sends it: what the cashier typed, not what it works
/// out to. The amount is computed here rather than trusted from the client, so
/// the clamping in `Discount::amount_on` cannot be bypassed by the UI and the
/// stored `amount` is always the one the arithmetic actually used.
#[derive(Deserialize, Clone, Copy)]
pub struct DiscountInput {
    /// 'percent' | 'fixed'
    pub kind: DiscountKind,
    pub value: Decimal,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiscountKind {
    Percent,
    Fixed,
}

impl DiscountKind {
    /// The `discount_kind` enum label, so the cast in SQL cannot drift from the
    /// variant names.
    fn as_sql(self) -> &'static str {
        match self {
            DiscountKind::Percent => "percent",
            DiscountKind::Fixed => "fixed",
        }
    }
}

impl From<DiscountInput> for Discount {
    fn from(d: DiscountInput) -> Self {
        match d.kind {
            DiscountKind::Percent => Discount::Percent(d.value),
            DiscountKind::Fixed => Discount::Fixed(d.value),
        }
    }
}

#[derive(Deserialize)]
pub struct SaleLineInput {
    pub product_id: i64,
    pub unit_id: i64,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    /// Absent when the line is sold at full price.
    #[serde(default)]
    pub discount: Option<DiscountInput>,
}

impl SaleLineInput {
    fn priced(&self) -> PricedLine {
        PricedLine {
            qty: self.quantity,
            unit_price: self.unit_price,
            discount: self.discount.map(Into::into),
        }
    }
}

fn priced_lines(lines: &[SaleLineInput]) -> Vec<PricedLine> {
    lines.iter().map(SaleLineInput::priced).collect()
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
    /// A discount off the whole bill, on top of any per-line ones.
    #[serde(default)]
    pub bill_discount: Option<DiscountInput>,
}

#[derive(Serialize, FromRow)]
pub struct SaleSummary {
    pub id: i64,
    pub invoice_number: Option<String>,
    pub subtotal: Decimal,
    pub discount_total: Decimal,
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
///
/// `held_sale_id` is set when re-holding a cart that was resumed from a held
/// sale, so it is updated in place. Without it, parking a resumed cart would
/// leave the original held sale behind alongside a new one holding the same
/// items.
#[tauri::command]
pub async fn hold_sale(
    state: tauri::State<'_, AppDb>,
    customer_id: Option<i64>,
    lines: Vec<SaleLineInput>,
    bill_discount: Option<DiscountInput>,
    held_sale_id: Option<i64>,
) -> Result<i64, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    if lines.is_empty() {
        return Err(DbError::Conflict("cannot hold an empty cart".into()));
    }

    let totals = bill_totals(&priced_lines(&lines), bill_discount.map(Into::into));

    let mut tx = db.pool.begin().await?;

    let sale_id = match held_sale_id {
        Some(id) => {
            let status: String = sqlx::query_scalar("SELECT status::text FROM sale WHERE id = $1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
            if status != "held" {
                return Err(DbError::Conflict(format!(
                    "sale is '{status}', not 'held' — it cannot be re-held"
                )));
            }
            clear_sale_lines(&mut tx, id).await?;
            sqlx::query(
                "UPDATE sale SET customer_id = $1, subtotal = $2, discount_total = $3,
                                 grand_total = $4
                 WHERE id = $5",
            )
            .bind(customer_id)
            .bind(totals.subtotal)
            .bind(totals.discount_total)
            .bind(totals.grand_total)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            id
        }
        None => {
            sqlx::query_scalar(
                "INSERT INTO sale (location_id, customer_id, status, subtotal, discount_total, grand_total)
                 VALUES ($1, $2, 'held', $3, $4, $5) RETURNING id",
            )
            .bind(default_location())
            .bind(customer_id)
            .bind(totals.subtotal)
            .bind(totals.discount_total)
            .bind(totals.grand_total)
            .fetch_one(&mut *tx)
            .await?
        }
    };

    write_lines_and_discounts(&mut tx, sale_id, &lines, &totals, bill_discount).await?;

    tx.commit().await?;
    Ok(sale_id)
}

/// Writes every `sale_line` and the `sale_discount` audit row behind each
/// discount that was actually applied.
///
/// A `sale_discount` row records what the cashier asked for (`kind`, `value`)
/// alongside what it came to (`amount`); the two differ whenever a discount was
/// clamped, and keeping both is the only way to see afterwards that someone
/// typed 150% or 9,999 off a 500 bill.
async fn write_lines_and_discounts(
    tx: &mut Transaction<'_, Postgres>,
    sale_id: i64,
    lines: &[SaleLineInput],
    totals: &Totals,
    bill_discount: Option<DiscountInput>,
) -> Result<(), DbError> {
    for (line, amounts) in lines.iter().zip(&totals.lines) {
        let line_id: i64 = sqlx::query_scalar(
            "INSERT INTO sale_line (sale_id, product_id, unit_id, quantity, unit_price, discount_amount, line_total)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        )
        .bind(sale_id)
        .bind(line.product_id)
        .bind(line.unit_id)
        .bind(line.quantity)
        .bind(line.unit_price)
        .bind(amounts.discount_amount)
        .bind(amounts.line_total)
        .fetch_one(&mut **tx)
        .await?;

        if let Some(d) = line.discount {
            // A discount that clamped to nothing (0%, or a fixed 0) is not worth
            // an audit row; one that was reduced but still gave something is.
            if amounts.discount_amount > Decimal::ZERO {
                insert_discount(tx, sale_id, Some(line_id), "line", d, amounts.discount_amount).await?;
            }
        }
    }

    if let Some(d) = bill_discount {
        if totals.bill_discount_amount > Decimal::ZERO {
            insert_discount(tx, sale_id, None, "bill", d, totals.bill_discount_amount).await?;
        }
    }
    Ok(())
}

async fn insert_discount(
    tx: &mut Transaction<'_, Postgres>,
    sale_id: i64,
    sale_line_id: Option<i64>,
    scope: &str,
    discount: DiscountInput,
    amount: Decimal,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO sale_discount (sale_id, sale_line_id, scope, kind, value, amount)
         VALUES ($1, $2, $3::discount_scope, $4::discount_kind, $5, $6)",
    )
    .bind(sale_id)
    .bind(sale_line_id)
    .bind(scope)
    .bind(discount.kind.as_sql())
    .bind(discount.value)
    .bind(amount)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// `sale_discount.sale_line_id` references `sale_line`, so the discounts have to
/// go before the lines they point at or the delete trips the foreign key.
async fn clear_sale_lines(
    tx: &mut Transaction<'_, Postgres>,
    sale_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM sale_discount WHERE sale_id = $1")
        .bind(sale_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM sale_line WHERE sale_id = $1")
        .bind(sale_id)
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

/// A held sale's saved cart, in the shape the till needs to rebuild it.
#[derive(Serialize, FromRow)]
pub struct HeldSaleLine {
    pub product_id: i64,
    pub name: String,
    pub unit_id: i64,
    pub quantity: Decimal,
    pub unit_price: Decimal,
    /// The discount as it was typed, so resuming shows "10%" again rather than
    /// the amount it happened to work out to on the original cart.
    pub discount_kind: Option<String>,
    pub discount_value: Option<Decimal>,
}

#[derive(Serialize)]
pub struct HeldDiscount {
    pub kind: String,
    pub value: Decimal,
}

#[derive(Serialize)]
pub struct HeldSaleDetail {
    pub id: i64,
    pub customer_id: Option<i64>,
    pub lines: Vec<HeldSaleLine>,
    pub bill_discount: Option<HeldDiscount>,
}

/// Everything needed to put a held cart back on the screen.
///
/// Held sales were previously write-only: `list_held_sales` could show that one
/// existed, but nothing could read its lines back, so "Resume" had no cart to
/// restore.
#[tauri::command]
pub async fn held_sale(state: tauri::State<'_, AppDb>, id: i64) -> Result<HeldSaleDetail, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let (status, customer_id): (String, Option<i64>) =
        sqlx::query_as("SELECT status::text, customer_id FROM sale WHERE id = $1")
            .bind(id)
            .fetch_one(&db.pool)
            .await?;
    if status != "held" {
        return Err(DbError::Conflict(format!(
            "sale is '{status}', not 'held' — it cannot be resumed"
        )));
    }

    let lines = sqlx::query_as(
        "SELECT l.product_id, p.name, l.unit_id, l.quantity, l.unit_price,
                d.kind::text AS discount_kind, d.value AS discount_value
         FROM sale_line l
         JOIN product p ON p.id = l.product_id
         LEFT JOIN sale_discount d ON d.sale_line_id = l.id AND d.scope = 'line'
         WHERE l.sale_id = $1
         ORDER BY l.id",
    )
    .bind(id)
    .fetch_all(&db.pool)
    .await?;

    let bill_discount = sqlx::query_as::<_, (String, Decimal)>(
        "SELECT kind::text, value FROM sale_discount
         WHERE sale_id = $1 AND scope = 'bill' LIMIT 1",
    )
    .bind(id)
    .fetch_optional(&db.pool)
    .await?
    .map(|(kind, value)| HeldDiscount { kind, value });

    Ok(HeldSaleDetail {
        id,
        customer_id,
        lines,
        bill_discount,
    })
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
    clear_sale_lines(&mut tx, id).await?;
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

    let totals = bill_totals(
        &priced_lines(&input.lines),
        input.bill_discount.map(Into::into),
    );
    let paid: Decimal = input.payments.iter().map(|p| p.amount).sum();
    let balance_due = (totals.grand_total - paid).max(Decimal::ZERO);

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
            clear_sale_lines(&mut tx, id).await?;
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

    write_lines_and_discounts(&mut tx, sale_id, &input.lines, &totals, input.bill_discount).await?;

    for line in &input.lines {
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
    .bind(totals.subtotal)
    .bind(totals.discount_total)
    .bind(totals.grand_total)
    .bind(balance_due)
    .bind(sale_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(SaleSummary {
        id: sale_id,
        invoice_number: Some(invoice_number),
        subtotal: totals.subtotal,
        discount_total: totals.discount_total,
        grand_total: totals.grand_total,
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
    /// What came off this line, already computed — the receipt prints it, it
    /// does not recompute it.
    pub discount_amount: Decimal,
}

#[derive(Serialize)]
pub struct ReceiptData {
    pub invoice_number: String,
    pub completed_at: chrono::DateTime<chrono::Utc>,
    pub lines: Vec<ReceiptLine>,
    pub subtotal: Decimal,
    /// Line discounts plus the bill discount.
    pub discount_total: Decimal,
    /// The bill-level discount alone, so the receipt can show it on its own row
    /// rather than folded into the line discounts.
    pub bill_discount: Decimal,
    pub grand_total: Decimal,
}

#[tauri::command]
pub async fn sale_receipt(state: tauri::State<'_, AppDb>, sale_id: i64) -> Result<ReceiptData, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    receipt_for(&db.pool, sale_id).await
}

async fn receipt_for(pool: &PgPool, sale_id: i64) -> Result<ReceiptData, DbError> {
    let (invoice_number, completed_at, subtotal, discount_total, grand_total): (
        Option<String>,
        Option<chrono::DateTime<chrono::Utc>>,
        Decimal,
        Decimal,
        Decimal,
    ) = sqlx::query_as(
        "SELECT invoice_number, completed_at, subtotal, discount_total, grand_total
         FROM sale WHERE id = $1",
    )
    .bind(sale_id)
    .fetch_one(pool)
    .await?;

    let lines = sqlx::query_as(
        "SELECT p.name, l.quantity AS qty, l.unit_price AS price, l.discount_amount
         FROM sale_line l JOIN product p ON p.id = l.product_id
         WHERE l.sale_id = $1 ORDER BY l.id",
    )
    .bind(sale_id)
    .fetch_all(pool)
    .await?;

    // Read back rather than recomputed: what was banked is what gets printed,
    // even if the pricing rules change between the sale and a reprint.
    let bill_discount: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(amount), 0) FROM sale_discount
         WHERE sale_id = $1 AND scope = 'bill'",
    )
    .bind(sale_id)
    .fetch_one(pool)
    .await?;

    Ok(ReceiptData {
        invoice_number: invoice_number.unwrap_or_default(),
        completed_at: completed_at.unwrap_or_else(chrono::Utc::now),
        lines,
        subtotal,
        discount_total,
        bill_discount,
        grand_total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    /// The exact JSON `api.completeSale` sends. TypeScript checks its own side of
    /// this and Rust checks its own; nothing but a test checks that they agree,
    /// and a mismatch here is a checkout that fails only on a real till.
    #[test]
    fn the_checkout_payload_the_till_sends_deserializes() {
        let json = r#"{
            "held_sale_id": null,
            "customer_id": null,
            "lines": [
                {"product_id": 1, "unit_id": 2, "quantity": "3", "unit_price": "150.00",
                 "discount": {"kind": "percent", "value": "10"}},
                {"product_id": 4, "unit_id": 2, "quantity": "1", "unit_price": "75.50",
                 "discount": null}
            ],
            "payments": [{"method": "cash", "amount": "500.00"}],
            "bill_discount": {"kind": "fixed", "value": "25.00"}
        }"#;

        let input: CheckoutInput = serde_json::from_str(json).expect("payload must deserialize");
        assert_eq!(input.lines.len(), 2);
        assert!(input.lines[1].discount.is_none(), "an undiscounted line sends null");

        let totals = bill_totals(&priced_lines(&input.lines), input.bill_discount.map(Into::into));
        assert_eq!(totals.subtotal, dec!(525.50));
        assert_eq!(totals.line_discount_total, dec!(45.00), "10% of 450.00");
        assert_eq!(totals.bill_discount_amount, dec!(25.00));
        assert_eq!(totals.grand_total, dec!(455.50));
    }

    /// Both discount fields are `#[serde(default)]`, so a till that has never
    /// applied one does not have to send the keys at all.
    #[test]
    fn discounts_are_optional_on_the_wire() {
        let json = r#"{
            "held_sale_id": null,
            "customer_id": null,
            "lines": [{"product_id": 1, "unit_id": 2, "quantity": "2", "unit_price": "22.00"}],
            "payments": []
        }"#;

        let input: CheckoutInput = serde_json::from_str(json).expect("payload must deserialize");
        assert!(input.bill_discount.is_none());
        let totals = bill_totals(&priced_lines(&input.lines), None);
        assert_eq!(totals.grand_total, dec!(44.00));
        assert_eq!(totals.discount_total, dec!(0));
    }

    #[test]
    fn the_discount_kind_labels_match_the_postgres_enum() {
        // These strings are cast to `discount_kind` in SQL; a typo is a runtime
        // error on a real sale, not a compile error.
        assert_eq!(DiscountKind::Percent.as_sql(), "percent");
        assert_eq!(DiscountKind::Fixed.as_sql(), "fixed");
    }
}
