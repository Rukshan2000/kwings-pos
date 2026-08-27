use std::path::Path;

use rand::Rng;
use serde::{Deserialize, Serialize};

use crate::db::{paths, DbError};

pub const DB_NAME: &str = "pos";
pub const DB_USER: &str = "pos_admin";

/// Local machine configuration. Created on first launch, then never regenerated —
/// the password must survive restarts because it is baked into the cluster's roles.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbConfig {
    pub port: u16,
    pub password: String,
    /// PostgreSQL version the cluster was initialised with. A mismatch means the
    /// on-disk format may not be readable and must not be silently ignored.
    pub pg_version: String,
}

impl DbConfig {
    pub fn load_or_create(root: &Path, pg_version: &str) -> Result<Self, DbError> {
        let file = paths::config_file(root);

        if file.exists() {
            let text = std::fs::read_to_string(&file)?;
            let cfg: DbConfig = serde_json::from_str(&text)?;
            return Ok(cfg);
        }

        std::fs::create_dir_all(root)?;
        let cfg = DbConfig {
            port: free_port()?,
            password: generate_password(),
            pg_version: pg_version.to_string(),
        };
        write_private(&file, &serde_json::to_vec_pretty(&cfg)?)?;
        Ok(cfg)
    }

    pub fn save(&self, root: &Path) -> Result<(), DbError> {
        write_private(&paths::config_file(root), &serde_json::to_vec_pretty(self)?)
    }

    pub fn url(&self) -> String {
        format!(
            "postgres://{DB_USER}:{}@127.0.0.1:{}/{DB_NAME}",
            urlencode(&self.password),
            self.port
        )
    }

    pub fn maintenance_url(&self) -> String {
        format!(
            "postgres://{DB_USER}:{}@127.0.0.1:{}/postgres",
            urlencode(&self.password),
            self.port
        )
    }
}

/// The config holds a database password; keep it off other users' reach where the
/// platform lets us say so.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), DbError> {
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Ask the OS for an unused loopback port. There is an inherent race between
/// releasing it and PostgreSQL binding it, so the chosen port is persisted and
/// reused rather than re-picked on every launch.
fn free_port() -> Result<u16, DbError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn generate_password() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..40)
        .map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char)
        .collect()
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
