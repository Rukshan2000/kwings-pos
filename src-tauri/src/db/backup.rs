use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::db::config::DB_NAME;
use crate::db::{paths, DbError};

/// Writes a compressed custom-format dump, which `pg_restore` can restore
/// selectively and which is far smaller than plain SQL.
pub fn dump(
    pg_root: &Path,
    data_root: &Path,
    port: u16,
    user: &str,
    password: &str,
    dest_dir: &Path,
) -> Result<PathBuf, DbError> {
    std::fs::create_dir_all(dest_dir)?;

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let dest = dest_dir.join(format!("pos-backup-{stamp}.dump"));

    let mut cmd = Command::new(paths::exe(pg_root, "pg_dump"));
    cmd.arg("-h")
        .arg("127.0.0.1")
        .arg("-p")
        .arg(port.to_string())
        .arg("-U")
        .arg(user)
        .arg("-d")
        .arg(DB_NAME)
        .arg("--format=custom")
        .arg("--compress=6")
        .arg("-f")
        .arg(&dest)
        .env("PGPASSWORD", password)
        .stdout(Stdio::null());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let out = cmd.output().map_err(DbError::Spawn)?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&dest);
        return Err(DbError::Backup(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }

    // An empty dump means pg_dump succeeded against nothing useful; treat it as a
    // failure rather than handing the shop a worthless backup file.
    if std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == 0 {
        let _ = std::fs::remove_file(&dest);
        return Err(DbError::Backup("produced an empty file".into()));
    }

    let _ = data_root;
    Ok(dest)
}
