fn main() {
    tauri_build::build();

    #[cfg(target_os = "macos")]
    refresh_copied_macho_resources();
}

/// Re-materialises every Mach-O file `tauri_build` just copied into the target
/// directory so macOS will actually let us `exec` it.
///
/// `tauri_build::build()` copies resources with `std::fs::copy`, which truncates
/// and rewrites the destination *in place*. On macOS, overwriting the bytes of an
/// executable the kernel has already validated leaves a stale code-signature entry
/// on that vnode: the next `exec` fails with `load code signature error 2` and the
/// process dies of SIGKILL before it prints anything. That is what turned every
/// rebuild into `postgres --version failed (signal: 9)` with no error output.
///
/// Copying to a sibling and renaming over the destination gives each file a fresh
/// inode with no cached verdict, which is what the kernel needs to read the
/// (ad-hoc) signature the bundled PostgreSQL binaries ship with. Only Mach-O files
/// are touched; `share/` is data and does not need it.
#[cfg(target_os = "macos")]
fn refresh_copied_macho_resources() {
    use std::path::{Path, PathBuf};

    // Same derivation `tauri_build` uses to find the target dir from OUT_DIR
    // (`target/<profile>/build/<pkg>-<hash>/out`).
    let Some(out_dir) = std::env::var_os("OUT_DIR").map(PathBuf::from) else {
        return;
    };
    let Some(target_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    let resources = target_dir.join("resources");
    if !resources.is_dir() {
        return;
    }

    fn is_macho(path: &Path) -> bool {
        use std::io::Read;
        let mut magic = [0u8; 4];
        match std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)) {
            Ok(()) => matches!(
                u32::from_be_bytes(magic),
                // 64/32-bit Mach-O, either endianness, plus fat archives.
                0xfeed_facf | 0xcffa_edfe | 0xfeed_face | 0xcefa_edfe | 0xcafe_babe | 0xbeba_feca
            ),
            Err(_) => false,
        }
    }

    fn refresh(path: &Path) {
        let tmp = path.with_extension("tauri-refresh-tmp");
        if std::fs::copy(path, &tmp).is_ok() && std::fs::rename(&tmp, path).is_ok() {
            return;
        }
        let _ = std::fs::remove_file(&tmp);
        println!("cargo:warning=could not refresh bundled binary {}", path.display());
    }

    fn walk(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&path),
                Ok(t) if t.is_file() && is_macho(&path) => refresh(&path),
                _ => {}
            }
        }
    }

    walk(&resources);
}
