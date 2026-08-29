//! Customer loyalty: customers earn points on completed sales and can pay
//! with them at the till (`payment_method = 'loyalty_points'`). The earn and
//! redeem rates are a single global setting rather than a list — a shop has
//! exactly one active rate at a time.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};

use crate::auth::SessionState;
use crate::db::{duplicate, require_name, AppDb, DbError};

#[derive(Serialize, FromRow)]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: Option<String>,
    pub loyalty_points: Decimal,
}

#[tauri::command]
pub async fn list_customers(state: tauri::State<'_, AppDb>) -> Result<Vec<Customer>, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(sqlx::query_as(
        "SELECT id, name, phone, loyalty_points FROM customer
         WHERE archived_at IS NULL ORDER BY name",
    )
    .fetch_all(&db.pool)
    .await?)
}

#[tauri::command]
pub async fn create_customer(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    name: String,
    phone: Option<String>,
) -> Result<Customer, DbError> {
    if session.0.read().await.as_ref().is_none() {
        return Err(DbError::Conflict("please sign in first".into()));
    }
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    let name = require_name(&name, "customer")?;
    let phone = phone.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());

    sqlx::query_as(
        "INSERT INTO customer (name, phone) VALUES ($1, $2)
         RETURNING id, name, phone, loyalty_points",
    )
    .bind(&name)
    .bind(&phone)
    .fetch_one(&db.pool)
    .await
    .map_err(|e| duplicate(e, "customer", &name))
}

/// Soft delete, matching the catalogue entities — a customer may still be
/// referenced by past sales.
#[tauri::command]
pub async fn archive_customer(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    id: i64,
) -> Result<(), DbError> {
    if session.0.read().await.as_ref().is_none() {
        return Err(DbError::Conflict("please sign in first".into()));
    }
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    sqlx::query("UPDATE customer SET archived_at = now() WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

#[derive(Serialize, Deserialize, FromRow)]
pub struct LoyaltySetting {
    pub earn_amount_lkr: Decimal,
    pub earn_points: Decimal,
    pub redeem_value_per_point: Decimal,
}

#[tauri::command]
pub async fn loyalty_setting(state: tauri::State<'_, AppDb>) -> Result<LoyaltySetting, DbError> {
    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    Ok(fetch_setting(&db.pool).await?)
}

async fn fetch_setting(pool: &sqlx::PgPool) -> Result<LoyaltySetting, DbError> {
    Ok(sqlx::query_as(
        "SELECT earn_amount_lkr, earn_points, redeem_value_per_point FROM loyalty_setting WHERE id = 1",
    )
    .fetch_one(pool)
    .await?)
}

#[tauri::command]
pub async fn update_loyalty_setting(
    state: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: LoyaltySetting,
) -> Result<LoyaltySetting, DbError> {
    match session.0.read().await.as_ref() {
        Some(u) if u.role == "admin" || u.role == "manager" => {}
        Some(_) => return Err(DbError::Conflict("you don't have permission to do this".into())),
        None => return Err(DbError::Conflict("please sign in first".into())),
    }
    if input.earn_amount_lkr <= Decimal::ZERO || input.redeem_value_per_point <= Decimal::ZERO {
        return Err(DbError::Conflict("loyalty rates must be greater than zero".into()));
    }

    let guard = state.0.read().await;
    let db = guard.as_ref().ok_or(DbError::NotReady)?;
    let updated_by = session.0.read().await.as_ref().map(|u| u.id);

    sqlx::query(
        "UPDATE loyalty_setting SET earn_amount_lkr = $1, earn_points = $2,
                                     redeem_value_per_point = $3, updated_at = now(), updated_by = $4
         WHERE id = 1",
    )
    .bind(input.earn_amount_lkr)
    .bind(input.earn_points)
    .bind(input.redeem_value_per_point)
    .bind(updated_by)
    .execute(&db.pool)
    .await?;

    fetch_setting(&db.pool).await
}

/// Applied inside the same transaction as `pos::complete_sale`: locks the
/// customer row so a concurrent sale cannot redeem the same points twice,
/// converts `redeem_amount` (LKR, from the `loyalty_points` payment line)
/// back to points and checks it against the balance, then credits points
/// earned on `qualifying_amount` — the part of the sale *not* paid with
/// points, so a customer cannot earn points on their own points.
pub async fn award_and_redeem(
    tx: &mut Transaction<'_, Postgres>,
    customer_id: i64,
    qualifying_amount: Decimal,
    redeem_amount: Decimal,
) -> Result<(), DbError> {
    let setting = fetch_setting_tx(tx).await?;

    let redeemed_points = if redeem_amount > Decimal::ZERO {
        redeem_amount / setting.redeem_value_per_point
    } else {
        Decimal::ZERO
    };
    let earned_points = if setting.earn_amount_lkr > Decimal::ZERO && qualifying_amount > Decimal::ZERO {
        (qualifying_amount / setting.earn_amount_lkr) * setting.earn_points
    } else {
        Decimal::ZERO
    };

    let balance: Decimal = sqlx::query_scalar(
        "SELECT loyalty_points FROM customer WHERE id = $1 FOR UPDATE",
    )
    .bind(customer_id)
    .fetch_one(&mut **tx)
    .await?;

    if redeemed_points > balance {
        return Err(DbError::Conflict(format!(
            "customer only has {balance} points, not enough to redeem {redeemed_points}"
        )));
    }

    sqlx::query("UPDATE customer SET loyalty_points = loyalty_points - $1 + $2 WHERE id = $3")
        .bind(redeemed_points)
        .bind(earned_points)
        .bind(customer_id)
        .execute(&mut **tx)
        .await?;

    Ok(())
}

async fn fetch_setting_tx(tx: &mut Transaction<'_, Postgres>) -> Result<LoyaltySetting, DbError> {
    Ok(sqlx::query_as(
        "SELECT earn_amount_lkr, earn_points, redeem_value_per_point FROM loyalty_setting WHERE id = 1",
    )
    .fetch_one(&mut **tx)
    .await?)
}
