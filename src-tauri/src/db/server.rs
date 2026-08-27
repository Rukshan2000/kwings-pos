use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::db::config::{DbConfig, DB_NAME, DB_USER};
use crate::db::{paths, DbError};

const READY_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

/// A running PostgreSQL server owned by this process.
pub struct PgServer {
    pub root: PathBuf,
    pub pg_root: PathBuf,
    pub config: DbConfig,
    child: Option<Child>,
    #[cfg(windows)]
    _job: job::Job,
}

impl PgServer {
    /// Initialises the cluster if needed, starts the server, and waits until it
    /// accepts connections.
    pub fn start(root: PathBuf, pg_root: PathBuf) -> Result<Self, DbError> {
        std::fs::create_dir_all(&root)?;

        let version = binary_version(&pg_root)?;
        let mut config = DbConfig::load_or_create(&root, &version)?;
        let data = paths::data_dir(&root);

        if config.pg_version != version {
            return Err(DbError::VersionMismatch {
                cluster: config.pg_version.clone(),
                binaries: version,
            });
        }

        if !data.join("PG_VERSION").exists() {
            // A half-finished initdb leaves an unusable directory behind; clear it
            // rather than trying to repair it.
            if data.exists() {
                std::fs::remove_dir_all(&data)?;
            }
            init_cluster(&pg_root, &data, &config.password)?;
        }

        clear_stale_pidfile(&pg_root, &data)?;

        // The port may have been taken by something else while we were shut down.
        if !port_free(config.port) {
            config.port = pick_free_port()?;
            config.save(&root)?;
        }

        #[cfg(windows)]
        let job = job::Job::new()?;

        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(paths::log_file(&root))?;

        let mut cmd = Command::new(paths::exe(&pg_root, "postgres"));
        cmd.arg("-D")
            .arg(&data)
            .arg("-p")
            .arg(config.port.to_string())
            // Loopback only. This database is never exposed to the network.
            .arg("-c")
            .arg("listen_addresses=127.0.0.1")
            .arg("-c")
            .arg("logging_collector=off")
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log))
            .stdin(Stdio::null());
        no_window(&mut cmd);

        let child = cmd.spawn().map_err(DbError::Spawn)?;

        #[cfg(windows)]
        job.assign(&child)?;

        let mut server = PgServer {
            root,
            pg_root,
            config,
            child: Some(child),
            #[cfg(windows)]
            _job: job,
        };

        server.wait_until_ready()?;
        server.ensure_database()?;
        Ok(server)
    }

    fn wait_until_ready(&mut self) -> Result<(), DbError> {
        let deadline = Instant::now() + READY_TIMEOUT;
        let is_ready = paths::exe(&self.pg_root, "pg_isready");

        loop {
            // A server that died on startup will never become ready; fail loudly
            // with the log rather than spinning until the timeout.
            if let Some(child) = self.child.as_mut() {
                if let Some(status) = child.try_wait()? {
                    return Err(DbError::Exited {
                        status: status.to_string(),
                        log: self.tail_log(),
                    });
                }
            }

            let mut cmd = Command::new(&is_ready);
            cmd.arg("-h")
                .arg("127.0.0.1")
                .arg("-p")
                .arg(self.config.port.to_string())
                .arg("-U")
                .arg(DB_USER)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            no_window(&mut cmd);

            if matches!(cmd.status(), Ok(s) if s.success()) {
                return Ok(());
            }

            if Instant::now() >= deadline {
                return Err(DbError::StartTimeout(self.tail_log()));
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// `initdb` only creates the `postgres` maintenance database.
    fn ensure_database(&self) -> Result<(), DbError> {
        let exists = self
            .psql(
                "postgres",
                &format!("SELECT 1 FROM pg_database WHERE datname = '{DB_NAME}'"),
            )?
            .trim()
            .is_empty();

        if exists {
            self.psql("postgres", &format!("CREATE DATABASE {DB_NAME}"))?;
        }
        Ok(())
    }

    pub fn psql(&self, database: &str, sql: &str) -> Result<String, DbError> {
        let mut cmd = Command::new(paths::exe(&self.pg_root, "psql"));
        cmd.arg("-h")
            .arg("127.0.0.1")
            .arg("-p")
            .arg(self.config.port.to_string())
            .arg("-U")
            .arg(DB_USER)
            .arg("-d")
            .arg(database)
            .arg("-tAqc")
            .arg(sql)
            .env("PGPASSWORD", &self.config.password);
        no_window(&mut cmd);

        let out = cmd.output().map_err(DbError::Spawn)?;
        if !out.status.success() {
            return Err(DbError::Psql(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// Graceful shutdown. The Job Object is the backstop for the case where this
    /// never runs, but a clean `fast` stop avoids recovery work on next start.
    pub fn stop(&mut self) -> Result<(), DbError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };

        let mut cmd = Command::new(paths::exe(&self.pg_root, "pg_ctl"));
        cmd.arg("stop")
            .arg("-D")
            .arg(paths::data_dir(&self.root))
            .arg("-m")
            .arg("fast")
            .arg("-w")
            .arg("-t")
            .arg(STOP_TIMEOUT.as_secs().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        no_window(&mut cmd);
        let _ = cmd.status();

        let deadline = Instant::now() + STOP_TIMEOUT;
        loop {
            match child.try_wait()? {
                Some(_) => return Ok(()),
                None if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(());
                }
                None => std::thread::sleep(Duration::from_millis(100)),
            }
        }
    }

    fn tail_log(&self) -> String {
        std::fs::read_to_string(paths::log_file(&self.root))
            .map(|s| s.lines().rev().take(20).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

impl Drop for PgServer {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn init_cluster(pg_root: &Path, data: &Path, password: &str) -> Result<(), DbError> {
    std::fs::create_dir_all(data.parent().unwrap_or(data))?;

    // initdb reads the superuser password from a file rather than argv, which keeps
    // it out of the process list.
    let pwfile = data.with_extension("initpw");
    std::fs::write(&pwfile, password)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&pwfile, std::fs::Permissions::from_mode(0o600))?;
    }

    let mut cmd = Command::new(paths::exe(pg_root, "initdb"));
    cmd.arg("-D")
        .arg(data)
        .arg("-U")
        .arg(DB_USER)
        .arg("--pwfile")
        .arg(&pwfile)
        .arg("--auth-host=scram-sha-256")
        .arg("--auth-local=scram-sha-256")
        .arg("-E")
        .arg("UTF8")
        .arg("--locale=C");
    no_window(&mut cmd);

    let out = cmd.output().map_err(DbError::Spawn);
    let _ = std::fs::remove_file(&pwfile);
    let out = out?;

    if !out.status.success() {
        return Err(DbError::InitDb(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    Ok(())
}

/// A `postmaster.pid` left by a killed server blocks startup.
///
/// Deciding whether it is stale by probing the port is wrong: a bind can fail for
/// reasons that have nothing to do with PostgreSQL (privileged port, permissions),
/// which would misreport a dead server as running. `pg_ctl status` checks the
/// recorded PID against the process table, which is the actual question.
fn clear_stale_pidfile(pg_root: &Path, data: &Path) -> Result<(), DbError> {
    let pidfile = data.join("postmaster.pid");
    if !pidfile.exists() {
        return Ok(());
    }

    let mut cmd = Command::new(paths::exe(pg_root, "pg_ctl"));
    cmd.arg("status")
        .arg("-D")
        .arg(data)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    no_window(&mut cmd);

    // 0 = running, 3 = not running, 4 = unusable data directory.
    if matches!(cmd.status().map_err(DbError::Spawn)?.code(), Some(0)) {
        let port = std::fs::read_to_string(&pidfile)
            .ok()
            .and_then(|t| t.lines().nth(3).and_then(|l| l.trim().parse().ok()))
            .unwrap_or(0);
        return Err(DbError::AlreadyRunning(port));
    }

    std::fs::remove_file(&pidfile)?;
    Ok(())
}

fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

fn pick_free_port() -> Result<u16, DbError> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?
        .local_addr()?
        .port())
}

fn binary_version(pg_root: &Path) -> Result<String, DbError> {
    let mut cmd = Command::new(paths::exe(pg_root, "postgres"));
    cmd.arg("--version");
    no_window(&mut cmd);

    let out = cmd.output().map_err(DbError::Spawn)?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.split_whitespace()
        .last()
        .map(|v| v.to_string())
        .ok_or_else(|| DbError::InitDb("could not read postgres --version".into()))
}

/// Keep console windows from flashing up in front of the cashier.
fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Ties the PostgreSQL process to this one at the OS level.
///
/// Parent/child alone does not do this on Windows: if the app is killed, the
/// server survives as an orphan holding the data directory lock. A Job Object with
/// `KILL_ON_JOB_CLOSE` makes the kernel clean up when our last handle closes,
/// including on a crash.
#[cfg(windows)]
mod job {
    use std::process::Child;

    use crate::db::DbError;

    pub struct Job(windows::Win32::Foundation::HANDLE);

    // The handle is only closed on drop, from whichever thread owns the server.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Result<Self, DbError> {
            use windows::Win32::System::JobObjects::{
                CreateJobObjectW, SetInformationJobObject,
                JobObjectExtendedLimitInformation,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            };

            unsafe {
                let handle = CreateJobObjectW(None, windows::core::PCWSTR::null())
                    .map_err(|e| DbError::Job(format!("CreateJobObject: {e}")))?;

                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|e| DbError::Job(format!("SetInformationJobObject: {e}")))?;

                Ok(Job(handle))
            }
        }

        pub fn assign(&self, child: &Child) -> Result<(), DbError> {
            use std::os::windows::io::AsRawHandle;
            use windows::Win32::Foundation::HANDLE;
            use windows::Win32::System::JobObjects::AssignProcessToJobObject;

            unsafe {
                AssignProcessToJobObject(self.0, HANDLE(child.as_raw_handle() as _))
                    .map_err(|e| DbError::Job(format!("AssignProcessToJobObject: {e}")))
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.0);
            }
        }
    }
}
