//! Raw ESC/POS printing to a Windows spooler queue.
//!
//! Discovery goes through PowerShell because the `Get-Printer` output is stable
//! across Windows versions; the actual write has to go through winspool with the
//! RAW datatype, which is the only way to stop the driver from re-rendering our
//! ESC/POS bytes as a page image.

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

#[cfg(not(windows))]
mod imp {
    use super::Printers;

    pub fn list() -> Result<Printers, String> {
        Ok(Printers { names: Vec::new(), default: None })
    }

    pub fn send(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("raw receipt printing is only implemented on Windows".into())
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
