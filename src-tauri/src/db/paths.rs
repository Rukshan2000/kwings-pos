use std::path::{Path, PathBuf};

use crate::db::DbError;

/// Strips a Windows `\\?\` extended-length prefix, if present.
///
/// `tauri::path::resource_dir()` returns a canonicalized, `\\?\`-prefixed
/// path on Windows. Postgres's own binaries (`initdb` finding its sibling
/// `postgres` executable) resolve paths relative to their own argv0 using
/// forward slashes and do not understand that prefix — a verbatim path fed
/// to them comes out as `//?/C:/...`, which Windows' path parser treats
/// literally (no `/`-to-`\` normalization under `\\?\`) and fails to find.
/// Our own paths are always short, so we never need the extended-length
/// escape hatch this prefix exists for.
fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    match path.to_str() {
        Some(s) => match s.strip_prefix(r"\\?\UNC\") {
            Some(rest) => PathBuf::from(format!(r"\\{rest}")),
            None => match s.strip_prefix(r"\\?\") {
                Some(rest) => PathBuf::from(rest),
                None => path.to_path_buf(),
            },
        },
        None => path.to_path_buf(),
    }
}

/// Where the bundled PostgreSQL binaries live.
///
/// In a packaged build these are a Tauri resource; in `cargo test` and `tauri dev`
/// they sit in the source tree, fetched by `scripts/fetch-postgres.mjs`.
pub fn pg_root(resource_dir: Option<&Path>) -> Result<PathBuf, DbError> {
    let mut tried = Vec::new();

    if let Some(dir) = resource_dir {
        let dir = strip_verbatim_prefix(dir);
        let p = dir.join("resources").join("pgsql");
        if p.join("bin").is_dir() {
            return Ok(p);
        }
        tried.push(p);
    }

    let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("pgsql");
    if dev.join("bin").is_dir() {
        return Ok(dev);
    }
    tried.push(dev);

    Err(DbError::BinariesMissing(tried))
}

/// Name of an executable in the bundled `bin` directory.
pub fn exe(pg_root: &Path, name: &str) -> PathBuf {
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    pg_root.join("bin").join(file)
}

/// Per-machine application data.
///
/// Deliberately `%PROGRAMDATA%` and not `%LOCALAPPDATA%`: the installer is
/// `perMachine`, and a per-user directory would give every Windows account its own
/// invisible database with its own sales.
pub fn app_data_root() -> Result<PathBuf, DbError> {
    let base = if cfg!(windows) {
        std::env::var_os("PROGRAMDATA")
            .map(PathBuf::from)
            .ok_or(DbError::NoDataDir)?
    } else if cfg!(target_os = "macos") {
        PathBuf::from(std::env::var_os("HOME").ok_or(DbError::NoDataDir)?)
            .join("Library")
            .join("Application Support")
    } else {
        PathBuf::from(std::env::var_os("HOME").ok_or(DbError::NoDataDir)?).join(".local/share")
    };
    Ok(base.join("GreenPlusPOS"))
}

pub fn data_dir(root: &Path) -> PathBuf {
    root.join("pgdata")
}

pub fn config_file(root: &Path) -> PathBuf {
    root.join("config.json")
}

pub fn log_file(root: &Path) -> PathBuf {
    root.join("postgres.log")
}
