//! Raw ESC/POS printing to whatever the OS's print spooler calls the receipt
//! printer.
//!
//! On Windows, discovery goes through PowerShell (`Get-Printer` output is
//! stable across Windows versions) and the write goes through winspool with
//! the RAW datatype — the only way to stop the driver from re-rendering our
//! ESC/POS bytes as a page image.
//!
//! On macOS and Linux, both discovery and the write go through CUPS's `lp`/
//! `lpstat` command-line tools (`lp -o raw`), which is CUPS's own equivalent
//! of the Windows RAW datatype — it skips the driver's page-rendering filter
//! and sends the bytes straight through.

use serde::Serialize;

#[derive(Serialize)]
pub struct Printers {
    pub names: Vec<String>,
    pub default: Option<String>,
}

#[cfg(windows)]
mod imp {
    use super::Printers;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn powershell(script: &str) -> Result<String, String> {
        let out = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("failed to run powershell: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    fn lines(s: &str) -> Vec<String> {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }

    pub fn list() -> Result<Printers, String> {
        let names = lines(&powershell("Get-Printer | Select-Object -ExpandProperty Name")?);
        let default = lines(&powershell(
            "(Get-CimInstance -ClassName Win32_Printer -Filter 'Default = True').Name",
        )?)
        .into_iter()
        .next();
        Ok(Printers { names, default })
    }

    pub fn send(printer: &str, data: &[u8]) -> Result<(), String> {
        use windows::core::{PCWSTR, PWSTR};
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Graphics::Printing::{
            ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
            StartPagePrinter, WritePrinter, DOC_INFO_1W,
        };

        if data.is_empty() {
            return Err("nothing to print".into());
        }

        let mut name: Vec<u16> = printer.encode_utf16().chain(std::iter::once(0)).collect();
        let mut doc: Vec<u16> = "POS Receipt".encode_utf16().chain(std::iter::once(0)).collect();
        let mut raw: Vec<u16> = "RAW".encode_utf16().chain(std::iter::once(0)).collect();

        unsafe {
            let mut handle = HANDLE::default();
            // Return type differs across windows-rs releases; the handle itself is
            // the reliable success signal.
            let _ = OpenPrinterW(PCWSTR(name.as_ptr()), &mut handle, None);
            if handle.is_invalid() {
                return Err(format!(
                    "cannot open printer \"{printer}\" — check the name and that it is online"
                ));
            }

            let info = DOC_INFO_1W {
                pDocName: PWSTR(doc.as_mut_ptr()),
                pOutputFile: PWSTR::null(),
                pDatatype: PWSTR(raw.as_mut_ptr()),
            };

            let _ = StartDocPrinterW(handle, 1, &info);
            let _ = StartPagePrinter(handle);

            let mut written: u32 = 0;
            let _ = WritePrinter(
                handle,
                data.as_ptr() as *const core::ffi::c_void,
                data.len() as u32,
                &mut written,
            );

            let _ = EndPagePrinter(handle);
            let _ = EndDocPrinter(handle);
            let _ = ClosePrinter(handle);

            // Keeps `name` alive across the calls above.
            name.clear();

            if written as usize != data.len() {
                return Err(format!(
                    "printer accepted only {written} of {} bytes",
                    data.len()
                ));
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
mod imp {
    use super::Printers;
    use std::io::Write;
    use std::process::{Command, Stdio};

    fn lines(s: &str) -> Vec<String> {
        s.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    }

    pub fn list() -> Result<Printers, String> {
        // `lpstat -p` exits non-zero (and prints nothing useful) when CUPS has
        // no printers configured, or isn't running — that is "no printers",
        // not an error the cashier needs to see.
        let names = Command::new("lpstat")
            .arg("-p")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| {
                // Lines look like: "printer EPSON_TM_T88V is idle.  enabled since ..."
                lines(&String::from_utf8_lossy(&out.stdout))
                    .into_iter()
                    .filter_map(|l| {
                        let mut parts = l.split_whitespace();
                        (parts.next() == Some("printer"))
                            .then(|| parts.next())
                            .flatten()
                            .map(str::to_string)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let default = Command::new("lpstat")
            .arg("-d")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| {
                // "system default destination: EPSON_TM_T88V"
                String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .rsplit(": ")
                    .next()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            });

        Ok(Printers { names, default })
    }

    pub fn send(printer: &str, data: &[u8]) -> Result<(), String> {
        if data.is_empty() {
            return Err("nothing to print".into());
        }

        let mut child = Command::new("lp")
            .args(["-d", printer, "-o", "raw"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to run lp: {e}"))?;

        child
            .stdin
            .take()
            .ok_or_else(|| "failed to open lp's stdin".to_string())?
            .write_all(data)
            .map_err(|e| format!("failed to write to lp: {e}"))?;

        let out = child
            .wait_with_output()
            .map_err(|e| format!("lp did not run: {e}"))?;
        if !out.status.success() {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if msg.is_empty() {
                format!("lp exited with {}", out.status)
            } else {
                msg
            });
        }
        Ok(())
    }
}

#[cfg(not(any(windows, unix)))]
mod imp {
    use super::Printers;

    pub fn list() -> Result<Printers, String> {
        Ok(Printers { names: Vec::new(), default: None })
    }

    pub fn send(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("raw receipt printing is not supported on this platform".into())
    }
}

#[tauri::command]
pub fn list_printers() -> Result<Printers, String> {
    imp::list()
}

#[tauri::command]
pub fn print_raw(printer: String, data: Vec<u8>) -> Result<(), String> {
    imp::send(&printer, &data)
}
