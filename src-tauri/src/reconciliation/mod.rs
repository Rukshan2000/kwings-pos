//! End-of-day till reconciliation, done in two independent steps matching how
//! a real till actually runs:
//!
//!   - **Morning**: a cashier counts the float going into an empty drawer and
//!     saves it (`save_opening_count`) before ringing anything up.
//!   - **Evening**: a (possibly different) cashier counts everything
//!     physically in the drawer at close and reconciles it (`save_closing_count`)
//!     against what the day's sales say should be there.
//!
//! `counted_cash` is the evening count on its own — the physical drawer count
//! already includes whatever survived from the morning float, so it is never
//! added to `opening_cash` a second time. What *is* derived from
//! `opening_cash` is `expected_cash = opening_cash + net cash sales`, which is
//! what the evening count is checked against.
//!
//! Cash and card/bank refunds (`sale_return.refund_method`) reduce what each
//! method should have taken in that day — a return paid back in cash lowers
//! expected cash, a return credited back to a card lowers that card's expected
//! total, exactly mirroring how the money actually left.
//!
//! There is still no shift/close-tracking (`cashier_shift` exists in the
//! schema but nothing opens or closes one) and no mid-day withdrawal tracking,
//! so this cannot yet catch a cash-drop that happened during the day — only
//! "did today's net takings make it into the drawer / settle on the terminal".

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::auth::SessionState;
use crate::db::{AppDb, DbError};

fn default_location() -> i64 {
    1
}

#[derive(Deserialize, Serialize, Clone)]
pub struct DenominationCount {
    pub value: Decimal,
    pub count: i64,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct PaymentMethodCount {
    pub method: String,
    pub counted: Decimal,
}

#[derive(Serialize, FromRow)]
pub struct PaymentMethodExpected {
    pub method: String,
    pub sales: Decimal,
    pub refunds: Decimal,
    pub expected: Decimal,
}

#[derive(Serialize, FromRow)]
struct DaySummaryRow {
    order_count: i64,
    sold: Decimal,
    earned: Decimal,
}

#[derive(Serialize, FromRow)]
struct SavedRow {
    opening_cash: Decimal,
    counted_cash: Decimal,
    variance: Decimal,
    opening_denominations: String,
    denominations: String,
    payment_counts: String,
    note: Option<String>,
}

#[derive(Serialize, Default)]
pub struct SavedReconciliation {
    pub opening_cash: Decimal,
    pub counted_cash: Decimal,
    pub variance: Decimal,
    pub opening_denominations: Vec<DenominationCount>,
    pub denominations: Vec<DenominationCount>,
    pub payment_counts: Vec<PaymentMethodCount>,
    pub note: Option<String>,
}

impl From<SavedRow> for SavedReconciliation {
    fn from(r: SavedRow) -> Self {
        SavedReconciliation {
            opening_cash: r.opening_cash,
            counted_cash: r.counted_cash,
            variance: r.variance,
            opening_denominations: serde_json::from_str(&r.opening_denominations).unwrap_or_default(),
            denominations: serde_json::from_str(&r.denominations).unwrap_or_default(),
            payment_counts: serde_json::from_str(&r.payment_counts).unwrap_or_default(),
            note: r.note,
        }
    }
}

#[derive(Serialize)]
pub struct DailyReconciliation {
    pub order_count: i64,
    pub sold: Decimal,
    pub earned: Decimal,
    pub cash_sales: Decimal,
    pub cash_refunds: Decimal,
    /// Net cash the till expects for the day, before adding the opening float.
    pub net_cash: Decimal,
    /// Every non-cash method with a sale or refund that day, net of refunds —
    /// for the cashier to check against the card terminal or bank statement.
    pub other_methods: Vec<PaymentMethodExpected>,
    pub saved: Option<SavedReconciliation>,
}

fn denomination_total(denominations: &[DenominationCount]) -> Decimal {
    denominations.iter().map(|d| d.value * Decimal::from(d.count)).sum()
}

async fn cash_sales_and_refunds(
    pool: &sqlx::PgPool,
    business_date: chrono::NaiveDate,
) -> Result<(Decimal, Decimal), DbError> {
    let cash_sales: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(sp.amount), 0) FROM sale_payment sp JOIN sale s ON s.id = sp.sale_id
         WHERE s.status = 'completed' AND sp.method = 'cash'
           AND (s.completed_at AT TIME ZONE 'UTC')::date = $1",
    )
    .bind(business_date)
    .fetch_one(pool)
    .await?;

    let cash_refunds: Decimal = sqlx::query_scalar(
        "SELECT COALESCE(SUM(total), 0) FROM sale_return
         WHERE status = 'completed' AND refund_method = 'cash'
           AND (created_at AT TIME ZONE 'UTC')::date = $1",
    )
    .bind(business_date)
    .fetch_one(pool)
    .await?;

    Ok((cash_sales, cash_refunds))
}

async fn other_methods_expected(
    pool: &sqlx::PgPool,
    business_date: chrono::NaiveDate,
) -> Result<Vec<PaymentMethodExpected>, DbError> {
    let sales = sqlx::query_as::<_, (String, Decimal)>(
        "SELECT sp.method::text, SUM(sp.amount)
         FROM sale_payment sp JOIN sale s ON s.id = sp.sale_id
         WHERE s.status = 'completed' AND sp.method != 'cash'
           AND (s.completed_at AT TIME ZONE 'UTC')::date = $1
         GROUP BY sp.method",
    )
    .bind(business_date)
    .fetch_all(pool)
    .await?;

    let refunds = sqlx::query_as::<_, (String, Decimal)>(
        "SELECT refund_method::text, SUM(total)
         FROM sale_return
         WHERE status = 'completed' AND refund_method IS NOT NULL AND refund_method != 'cash'
           AND (created_at AT TIME ZONE 'UTC')::date = $1
         GROUP BY refund_method",
    )
    .bind(business_date)
    .fetch_all(pool)
    .await?;

    let mut methods: Vec<String> = sales.iter().map(|(m, _)| m.clone()).collect();
    for (m, _) in &refunds {
        if !methods.contains(m) {
            methods.push(m.clone());
        }
    }
    methods.sort();

    Ok(methods
        .into_iter()
        .map(|method| {
            let sale_total = sales.iter().find(|(m, _)| m == &method).map(|(_, v)| *v).unwrap_or(Decimal::ZERO);
            let refund_total = refunds.iter().find(|(m, _)| m == &method).map(|(_, v)| *v).unwrap_or(Decimal::ZERO);
            PaymentMethodExpected {
                method,
                sales: sale_total,
                refunds: refund_total,
                expected: sale_total - refund_total,
            }
        })
        .collect())
}

async fn fetch_saved(
    pool: &sqlx::PgPool,
    business_date: chrono::NaiveDate,
) -> Result<Option<SavedRow>, DbError> {
    Ok(sqlx::query_as::<_, SavedRow>(
        "SELECT opening_cash, counted_cash, variance,
                opening_denominations::text AS opening_denominations,
                denominations::text AS denominations,
                payment_counts::text AS payment_counts,
                note
         FROM cash_reconciliation
         WHERE location_id = $1 AND business_date = $2",
    )
    .bind(default_location())
    .bind(business_date)
    .fetch_optional(pool)
    .await?)
}

#[tauri::command]
pub async fn daily_reconciliation(
    state: tauri::State<'_, AppDb>,
    business_date: chrono::NaiveDate,
) -> Result<DailyReconciliation, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let summary = sqlx::query_as::<_, DaySummaryRow>(
        "SELECT
            (SELECT COUNT(*) FROM sale
             WHERE status = 'completed' AND (completed_at AT TIME ZONE 'UTC')::date = $1) AS order_count,
            COALESCE((SELECT SUM(grand_total) FROM sale
                      WHERE status = 'completed' AND (completed_at AT TIME ZONE 'UTC')::date = $1), 0) AS sold,
            COALESCE((SELECT SUM(sl.line_total - sl.quantity * sl.unit_cost)
                      FROM sale_line sl JOIN sale s ON s.id = sl.sale_id
                      WHERE s.status = 'completed' AND (s.completed_at AT TIME ZONE 'UTC')::date = $1), 0) AS earned",
    )
    .bind(business_date)
    .fetch_one(&db.pool)
    .await?;

    let (cash_sales, cash_refunds) = cash_sales_and_refunds(&db.pool, business_date).await?;
    let other_methods = other_methods_expected(&db.pool, business_date).await?;
    let saved = fetch_saved(&db.pool, business_date).await?.map(SavedReconciliation::from);

    Ok(DailyReconciliation {
        order_count: summary.order_count,
        sold: summary.sold,
        earned: summary.earned,
        cash_sales,
        cash_refunds,
        net_cash: cash_sales - cash_refunds,
        other_methods,
        saved,
    })
}

#[derive(Deserialize)]
pub struct SaveOpeningInput {
    pub business_date: chrono::NaiveDate,
    pub denominations: Vec<DenominationCount>,
}

#[tauri::command]
pub async fn save_opening_count(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: SaveOpeningInput,
) -> Result<DailyReconciliation, DbError> {
    // Setting the till's opening float — including for a future date — is a
    // manager/admin call, not a cashier one.
    match session.0.read().await.as_ref() {
        Some(u) if u.role == "admin" || u.role == "manager" => {}
        Some(_) => return Err(DbError::Conflict("you don't have permission to do this".into())),
        None => return Err(DbError::Conflict("please sign in first".into())),
    }

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let opening_cash = denomination_total(&input.denominations);
    let existing = fetch_saved(&db.pool, input.business_date).await?;
    let (cash_sales, cash_refunds) = cash_sales_and_refunds(&db.pool, input.business_date).await?;
    let expected_cash = opening_cash + cash_sales - cash_refunds;
    let counted_cash = existing.as_ref().map(|r| r.counted_cash).unwrap_or(Decimal::ZERO);
    let variance = counted_cash - expected_cash;
    let opening_denominations_json = serde_json::to_string(&input.denominations)
        .map_err(|e| DbError::Conflict(format!("could not encode denominations: {e}")))?;
    let created_by = session.0.read().await.as_ref().map(|u| u.id);

    sqlx::query(
        "INSERT INTO cash_reconciliation
            (location_id, business_date, opening_cash, expected_cash, counted_cash, variance,
             opening_denominations, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (location_id, business_date) DO UPDATE SET
            opening_cash = EXCLUDED.opening_cash,
            expected_cash = EXCLUDED.expected_cash,
            variance = EXCLUDED.variance,
            opening_denominations = EXCLUDED.opening_denominations,
            created_at = now(),
            created_by = EXCLUDED.created_by",
    )
    .bind(default_location())
    .bind(input.business_date)
    .bind(opening_cash)
    .bind(expected_cash)
    .bind(counted_cash)
    .bind(variance)
    .bind(&opening_denominations_json)
    .bind(created_by)
    .execute(&db.pool)
    .await?;
    drop(guard);

    daily_reconciliation(state, input.business_date).await
}

#[derive(Deserialize)]
pub struct SaveClosingInput {
    pub business_date: chrono::NaiveDate,
    pub denominations: Vec<DenominationCount>,
    pub payment_counts: Vec<PaymentMethodCount>,
    pub note: Option<String>,
}

#[tauri::command]
pub async fn save_closing_count(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: SaveClosingInput,
) -> Result<DailyReconciliation, DbError> {
    if session.0.read().await.as_ref().is_none() {
        return Err(DbError::Conflict("please sign in first".into()));
    }

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    let counted_cash = denomination_total(&input.denominations);
    let existing = fetch_saved(&db.pool, input.business_date).await?;
    let opening_cash = existing.as_ref().map(|r| r.opening_cash).unwrap_or(Decimal::ZERO);
    let opening_denominations_json = existing
        .as_ref()
        .map(|r| r.opening_denominations.clone())
        .unwrap_or_else(|| "[]".to_string());
    let (cash_sales, cash_refunds) = cash_sales_and_refunds(&db.pool, input.business_date).await?;
    let expected_cash = opening_cash + cash_sales - cash_refunds;
    let variance = counted_cash - expected_cash;

    let denominations_json = serde_json::to_string(&input.denominations)
        .map_err(|e| DbError::Conflict(format!("could not encode denominations: {e}")))?;
    let payment_counts_json = serde_json::to_string(&input.payment_counts)
        .map_err(|e| DbError::Conflict(format!("could not encode payment counts: {e}")))?;
    let created_by = session.0.read().await.as_ref().map(|u| u.id);

    sqlx::query(
        "INSERT INTO cash_reconciliation
            (location_id, business_date, opening_cash, expected_cash, counted_cash, variance,
             opening_denominations, denominations, payment_counts, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
         ON CONFLICT (location_id, business_date) DO UPDATE SET
            expected_cash = EXCLUDED.expected_cash,
            counted_cash = EXCLUDED.counted_cash,
            variance = EXCLUDED.variance,
            denominations = EXCLUDED.denominations,
            payment_counts = EXCLUDED.payment_counts,
            note = EXCLUDED.note,
            created_at = now(),
            created_by = EXCLUDED.created_by",
    )
    .bind(default_location())
    .bind(input.business_date)
    .bind(opening_cash)
    .bind(expected_cash)
    .bind(counted_cash)
    .bind(variance)
    .bind(&opening_denominations_json)
    .bind(&denominations_json)
    .bind(&payment_counts_json)
    .bind(&input.note)
    .bind(created_by)
    .execute(&db.pool)
    .await?;
    drop(guard);

    daily_reconciliation(state, input.business_date).await
}

#[derive(Serialize, FromRow)]
pub struct ReconciliationHistoryRow {
    pub business_date: chrono::NaiveDate,
    pub opening_cash: Decimal,
    pub counted_cash: Decimal,
    pub expected_cash: Decimal,
    pub variance: Decimal,
    pub note: Option<String>,
    pub created_by_name: Option<String>,
}

#[tauri::command]
pub async fn list_reconciliations(
    state: tauri::State<'_, AppDb>,
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
) -> Result<Vec<ReconciliationHistoryRow>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;

    Ok(sqlx::query_as::<_, ReconciliationHistoryRow>(
        "SELECT cr.business_date, cr.opening_cash, cr.counted_cash, cr.expected_cash, cr.variance,
                cr.note, u.display_name AS created_by_name
         FROM cash_reconciliation cr
         LEFT JOIN app_user u ON u.id = cr.created_by
         WHERE cr.location_id = $1 AND cr.business_date BETWEEN $2 AND $3
         ORDER BY cr.business_date DESC",
    )
    .bind(default_location())
    .bind(from)
    .bind(to)
    .fetch_all(&db.pool)
    .await?)
}
