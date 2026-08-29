//! Login, the current session, and user management. The session lives only in
//! memory (`SessionState`, managed by Tauri like `AppDb`) — there is one till per
//! process, so there is nothing to persist across restarts; closing the app signs
//! the till out.

use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::db::{require_name, AppDb, DbError};

const ROLES: [&str; 3] = ["admin", "manager", "cashier"];

#[derive(Clone, Serialize)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub must_change_password: bool,
}

/// One till, one session — the same in-memory-`Option` idiom as `BootstrapError`.
pub struct SessionState(pub tokio::sync::RwLock<Option<CurrentUser>>);

impl SessionState {
    pub fn empty() -> Self {
        SessionState(tokio::sync::RwLock::new(None))
    }
}

fn hash_password(password: &str) -> Result<String, DbError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| DbError::Conflict(format!("could not hash password: {e}")))
}

fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn require_password(password: &str) -> Result<(), DbError> {
    if password.trim().len() < 6 {
        return Err(DbError::Conflict("password must be at least 6 characters".into()));
    }
    Ok(())
}

fn require_role_name(role: &str) -> Result<(), DbError> {
    if !ROLES.contains(&role) {
        return Err(DbError::Conflict(format!("unknown role '{role}'")));
    }
    Ok(())
}

/// Every admin-only command starts with this. Errors read as ordinary messages —
/// there is no separate "forbidden" status code surfaced to the frontend, same
/// convention as every other `DbError::Conflict` in this codebase.
pub async fn require_role(
    session: &tauri::State<'_, SessionState>,
    roles: &[&str],
) -> Result<CurrentUser, DbError> {
    match session.0.read().await.as_ref() {
        Some(u) if roles.contains(&u.role.as_str()) => Ok(u.clone()),
        Some(_) => Err(DbError::Conflict("you don't have permission to do this".into())),
        None => Err(DbError::Conflict("please sign in first".into())),
    }
}

#[derive(FromRow)]
struct UserAuthRow {
    id: i64,
    display_name: String,
    password_hash: String,
    role: String,
    must_change_password: bool,
}

#[tauri::command]
pub async fn login(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    username: String,
    password: String,
) -> Result<CurrentUser, DbError> {
    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;

    let row = sqlx::query_as::<_, UserAuthRow>(
        "SELECT id, display_name, password_hash, role::text AS role, must_change_password
         FROM app_user
         WHERE lower(username) = lower($1) AND active AND archived_at IS NULL",
    )
    .bind(&username)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| DbError::Conflict("invalid username or password".into()))?;

    if !verify_password(&password, &row.password_hash) {
        return Err(DbError::Conflict("invalid username or password".into()));
    }

    let user = CurrentUser {
        id: row.id,
        username,
        display_name: row.display_name,
        role: row.role,
        must_change_password: row.must_change_password,
    };
    *session.0.write().await = Some(user.clone());
    Ok(user)
}

#[tauri::command]
pub async fn logout(session: tauri::State<'_, SessionState>) -> Result<(), DbError> {
    *session.0.write().await = None;
    Ok(())
}

#[tauri::command]
pub async fn current_user(session: tauri::State<'_, SessionState>) -> Result<Option<CurrentUser>, DbError> {
    Ok(session.0.read().await.clone())
}

#[derive(Deserialize)]
pub struct ChangePasswordInput {
    pub current_password: String,
    pub new_password: String,
}

#[tauri::command]
pub async fn change_password(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: ChangePasswordInput,
) -> Result<(), DbError> {
    let current = session
        .0
        .read()
        .await
        .clone()
        .ok_or_else(|| DbError::Conflict("please sign in first".into()))?;
    require_password(&input.new_password)?;

    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;

    let existing_hash: String = sqlx::query_scalar("SELECT password_hash FROM app_user WHERE id = $1")
        .bind(current.id)
        .fetch_one(pool)
        .await?;
    if !verify_password(&input.current_password, &existing_hash) {
        return Err(DbError::Conflict("current password is incorrect".into()));
    }

    let new_hash = hash_password(&input.new_password)?;
    sqlx::query("UPDATE app_user SET password_hash = $1, must_change_password = false WHERE id = $2")
        .bind(new_hash)
        .bind(current.id)
        .execute(pool)
        .await?;

    if let Some(u) = session.0.write().await.as_mut() {
        u.must_change_password = false;
    }
    Ok(())
}

#[derive(Serialize, FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub active: bool,
}

#[tauri::command]
pub async fn list_users(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
) -> Result<Vec<UserRow>, DbError> {
    require_role(&session, &["admin"]).await?;
    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;
    Ok(sqlx::query_as::<_, UserRow>(
        "SELECT id, username, display_name, role::text AS role, active
         FROM app_user WHERE archived_at IS NULL ORDER BY display_name",
    )
    .fetch_all(pool)
    .await?)
}

#[derive(Deserialize)]
pub struct CreateUserInput {
    pub username: String,
    pub display_name: String,
    pub password: String,
    pub role: String,
}

#[tauri::command]
pub async fn create_user(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    input: CreateUserInput,
) -> Result<UserRow, DbError> {
    require_role(&session, &["admin"]).await?;

    let username = require_name(&input.username, "username")?;
    let display_name = require_name(&input.display_name, "user")?;
    require_role_name(&input.role)?;
    require_password(&input.password)?;
    let hash = hash_password(&input.password)?;

    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;

    sqlx::query_as::<_, UserRow>(
        "INSERT INTO app_user (username, display_name, password_hash, role)
         VALUES ($1, $2, $3, $4::user_role)
         RETURNING id, username, display_name, role::text AS role, active",
    )
    .bind(&username)
    .bind(&display_name)
    .bind(&hash)
    .bind(&input.role)
    .fetch_one(pool)
    .await
    .map_err(|e| crate::db::duplicate(e, "user", &username))
}

#[tauri::command]
pub async fn set_user_role(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    id: i64,
    role: String,
) -> Result<(), DbError> {
    let acting = require_role(&session, &["admin"]).await?;
    require_role_name(&role)?;
    if acting.id == id && role != "admin" {
        return Err(DbError::Conflict("you can't demote your own account".into()));
    }
    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;
    sqlx::query("UPDATE app_user SET role = $1::user_role WHERE id = $2")
        .bind(role)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn set_user_active(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    id: i64,
    active: bool,
) -> Result<(), DbError> {
    let acting = require_role(&session, &["admin"]).await?;
    if acting.id == id && !active {
        return Err(DbError::Conflict("you can't deactivate your own account".into()));
    }
    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;
    sqlx::query("UPDATE app_user SET active = $1 WHERE id = $2")
        .bind(active)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn reset_user_password(
    db: tauri::State<'_, AppDb>,
    session: tauri::State<'_, SessionState>,
    id: i64,
    new_password: String,
) -> Result<(), DbError> {
    require_role(&session, &["admin"]).await?;
    require_password(&new_password)?;
    let hash = hash_password(&new_password)?;
    let guard = db.0.read().await;
    let pool = &guard.as_ref().ok_or(DbError::NotReady)?.pool;
    sqlx::query("UPDATE app_user SET password_hash = $1, must_change_password = true WHERE id = $2")
        .bind(hash)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
