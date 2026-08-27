//! Spawns `initdb` and `postgres` under a token with BUILTIN\Administrators
//! disabled and every privilege dropped.
//!
//! PostgreSQL's backend refuses to run under any Windows account that is a
//! member of the Administrators group — elevated or not — as a hard-coded
//! security check with no configuration flag to disable it (this is
//! documented upstream Postgres behavior). That is true of the default
//! account on plenty of small shop PCs, and it is true of every GitHub
//! Actions Windows runner — confirmed live: `PgServer::start` failed there
//! with exactly this message before this module existed. The app cannot
//! assume the operator's Windows account happens to be a non-admin one, so it
//! cannot simply hand these two processes to `std::process::Command` and hope.
//!
//! `std::process::Command` has no way to launch under an alternate token, so
//! this bypasses it entirely — but only for these two spawns. Every other
//! child process in this app (`pg_ctl`, `psql`, `pg_dump`, `pg_isready`) has
//! no such restriction and keeps using `Command` normally.
//!
//! This entire module could not be compiled or exercised on the machine that
//! wrote it — there is no Windows target available. Every symbol and feature
//! gate used here was individually verified against the actual windows-rs
//! 0.58.0 source before writing this, and the one piece that is pure,
//! platform-independent logic (command-line quoting) is unit-tested in
//! `winquote.rs`. The rest is a first-real-run risk, same as every other
//! Windows-only module in this crate before its first green CI run.

use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::path::Path;

use windows::core::PWSTR;
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::{
    AllocateAndInitializeSid, CreateRestrictedToken, FreeSid, DISABLE_MAX_PRIVILEGE,
    SECURITY_NT_AUTHORITY, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY,
    TOKEN_DUPLICATE, TOKEN_QUERY, PSID,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess, OpenProcessToken,
    TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

use crate::db::winquote::build_command_line;
use crate::db::DbError;

// BUILTIN\Administrators: SECURITY_BUILTIN_DOMAIN_RID + DOMAIN_ALIAS_RID_ADMINS.
// Stable, documented Windows constants (winnt.h) — not something that varies
// by locale, domain, or OS version.
const SECURITY_BUILTIN_DOMAIN_RID: u32 = 32;
const DOMAIN_ALIAS_RID_ADMINS: u32 = 544;

const INFINITE: u32 = 0xFFFF_FFFF;

fn win_err(context: &str) -> DbError {
    DbError::Job(format!("{context}: {}", windows::core::Error::from_win32()))
}

struct Sid(PSID);

impl Drop for Sid {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                FreeSid(self.0);
            }
        }
    }
}

fn administrators_sid() -> Result<Sid, DbError> {
    let mut sid = PSID::default();
    unsafe {
        AllocateAndInitializeSid(
            &SECURITY_NT_AUTHORITY,
            2,
            SECURITY_BUILTIN_DOMAIN_RID,
            DOMAIN_ALIAS_RID_ADMINS,
            0,
            0,
            0,
            0,
            0,
            0,
            &mut sid,
        )
        .map_err(|e| DbError::Job(format!("AllocateAndInitializeSid: {e}")))?;
    }
    Ok(Sid(sid))
}

/// A primary token that is a copy of this process's own token, with the
/// Administrators group disabled and every privilege dropped. Used only to
/// launch `initdb`/`postgres`, never for anything else this app does.
struct RestrictedToken(HANDLE);

impl Drop for RestrictedToken {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn make_restricted_token() -> Result<RestrictedToken, DbError> {
    let admins = administrators_sid()?;

    let mut process_token = HANDLE::default();
    unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT,
            &mut process_token,
        )
        .map_err(|e| DbError::Job(format!("OpenProcessToken: {e}")))?;
    }
    // OpenProcessToken gave us a handle we own; make sure it is always closed,
    // including on an early return below.
    let process_token = scopeguard(process_token);

    let disable = [SID_AND_ATTRIBUTES {
        Sid: admins.0,
        Attributes: 0,
    }];

    let mut restricted = HANDLE::default();
    unsafe {
        CreateRestrictedToken(
            process_token.0,
            DISABLE_MAX_PRIVILEGE,
            Some(&disable),
            None,
            None,
            &mut restricted,
        )
        .map_err(|e| DbError::Job(format!("CreateRestrictedToken: {e}")))?;
    }

    Ok(RestrictedToken(restricted))
}

/// Closes a HANDLE when dropped. A tiny local RAII helper rather than pulling
/// in a crate for one use site.
struct HandleGuard(HANDLE);
fn scopeguard(h: HANDLE) -> HandleGuard {
    HandleGuard(h)
}
impl std::ops::Deref for HandleGuard {
    type Target = HANDLE;
    fn deref(&self) -> &HANDLE {
        &self.0
    }
}
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

fn to_wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Marks a Rust-owned file handle inheritable. Handles created by `std::fs`
/// are non-inheritable by default (Rust's own choice, matching close-on-exec
/// semantics on Unix) — without this, the child process would not actually
/// receive a usable stdout/stderr handle even with `bInheritHandles = TRUE`.
fn make_inheritable(file: &File) -> Result<HANDLE, DbError> {
    let handle = HANDLE(file.as_raw_handle() as _);
    unsafe {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)
            .map_err(|e| DbError::Job(format!("SetHandleInformation: {e}")))?;
    }
    Ok(handle)
}

/// A process spawned under the restricted token. Deliberately minimal — only
/// what `PgServer` actually needs: something to assign to the Job Object,
/// something to poll, and something to wait for or terminate.
pub struct RestrictedProcess {
    process: HANDLE,
}

// The handle is only ever touched from whichever thread owns the PgServer.
unsafe impl Send for RestrictedProcess {}

impl RestrictedProcess {
    pub fn raw_handle(&self) -> HANDLE {
        self.process
    }

    /// Non-blocking check: `Some(exit_code)` once the process has exited.
    pub fn try_wait(&self) -> Result<Option<u32>, DbError> {
        match unsafe { WaitForSingleObject(self.process, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0u32;
                unsafe {
                    GetExitCodeProcess(self.process, &mut code)
                        .map_err(|e| DbError::Job(format!("GetExitCodeProcess: {e}")))?;
                }
                Ok(Some(code))
            }
            _ => Err(win_err("WaitForSingleObject")),
        }
    }

    /// Blocks until the process exits or the timeout elapses, returning
    /// whether it actually exited.
    pub fn wait_timeout(&self, timeout: std::time::Duration) -> bool {
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(INFINITE);
        matches!(unsafe { WaitForSingleObject(self.process, ms) }, WAIT_OBJECT_0)
    }

    pub fn kill(&self) {
        unsafe {
            let _ = TerminateProcess(self.process, 1);
        }
    }
}

impl Drop for RestrictedProcess {
    fn drop(&mut self) {
        if !self.process.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.process);
            }
        }
    }
}

/// Launches `exe args...` under a freshly restricted copy of this process's
/// token (Administrators disabled, all privileges dropped), with `cwd` as its
/// working directory and stdout/stderr redirected to `log`. Stdin is given a
/// null handle — none of `initdb`/`postgres` read from it at startup, and the
/// alternative (wiring up a real console/NUL handle) is complexity this app
/// has no use for.
pub fn spawn_restricted(
    exe: &Path,
    args: &[String],
    cwd: &Path,
    log: &File,
) -> Result<RestrictedProcess, DbError> {
    let token = make_restricted_token()?;
    let log_handle = make_inheritable(log)?;

    let mut cmdline = to_wide(&build_command_line(&exe.display().to_string(), args));
    let mut cwd_wide = to_wide(&cwd.display().to_string());

    let mut startup = STARTUPINFOW::default();
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = HANDLE::default();
    startup.hStdOutput = log_handle;
    startup.hStdError = log_handle;

    let mut info = PROCESS_INFORMATION::default();

    unsafe {
        CreateProcessAsUserW(
            token.0,
            windows::core::PCWSTR::null(),
            PWSTR(cmdline.as_mut_ptr()),
            None,
            None,
            true,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            None,
            windows::core::PCWSTR(cwd_wide.as_mut_ptr()),
            &startup,
            &mut info,
        )
        .map_err(|e| DbError::Job(format!("CreateProcessAsUserW ({}): {e}", exe.display())))?;

        // We never need the primary thread handle for anything; leaking it
        // would leak a kernel handle for the life of the app.
        let _ = CloseHandle(info.hThread);
    }

    Ok(RestrictedProcess {
        process: info.hProcess,
    })
}
