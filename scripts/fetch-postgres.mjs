// Downloads the portable PostgreSQL binaries that get bundled as a Tauri resource.
//
// They are deliberately NOT committed: ~54 MB compressed per platform would bloat
// every clone forever. CI caches the download instead. Run this once after cloning,
// and any time PG_VERSION changes.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PG_VERSION = "17.11.0";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "src-tauri", "resources", "pgsql");
const CACHE = path.join(ROOT, ".pg-cache");

const TARGETS = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

// Everything the app actually invokes. Anything else in the archive is dead weight
// on the installer.
const KEEP_BIN = [
  "postgres", "initdb", "pg_ctl", "pg_dump", "pg_restore", "psql", "pg_isready",
];

const target = () => {
  const key = `${process.platform}-${process.arch}`;
  const t = TARGETS[key];
  if (!t) throw new Error(`No PostgreSQL binaries published for ${key}`);
  return t;
};

async function download(url, dest) {
  process.stdout.write(`  fetching ${path.basename(url)} … `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  process.stdout.write(`${(fs.statSync(dest).size / 1e6).toFixed(0)} MB\n`);
}

async function main() {
  const t = target();
  const name = `postgresql-${PG_VERSION}-${t}.tar.gz`;
  const base = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${PG_VERSION}`;

  const stamp = path.join(DEST, ".version");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8").trim() === `${PG_VERSION}-${t}`) {
    console.log(`PostgreSQL ${PG_VERSION} (${t}) already present.`);
    return;
  }

  fs.mkdirSync(CACHE, { recursive: true });
  const archive = path.join(CACHE, name);

  // Downloaded independently: a cache can plausibly restore the large archive
  // without its tiny checksum sidecar (or vice versa), and re-verifying against
  // a missing file should mean "fetch it", not "crash".
  if (!fs.existsSync(archive)) {
    await download(`${base}/${name}`, archive);
  }
  if (!fs.existsSync(`${archive}.sha256`)) {
    await download(`${base}/${name}.sha256`, `${archive}.sha256`);
  }

  // The published .sha256 file's format differs per platform: macOS/Linux ships
  // plain `shasum` output ("hash  filename"), Windows ships raw `CertUtil
  // -hashfile` output (three lines: a label, the hash on its own line, then a
  // trailing status line, no filename). Rather than assume either layout,
  // search the whole file for the one thing both formats actually contain: a
  // bare 64-character hex string.
  const sha256Text = fs.readFileSync(`${archive}.sha256`, "utf8");
  const match = sha256Text.match(/\b[0-9a-fA-F]{64}\b/);
  if (!match) {
    throw new Error(`could not find a SHA-256 hash in ${archive}.sha256:\n${sha256Text}`);
  }
  const want = match[0].toLowerCase();
  const got = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (want !== got) {
    fs.rmSync(archive, { force: true });
    throw new Error(`checksum mismatch for ${name}\n  expected ${want}\n  got      ${got}`);
  }
  console.log("  checksum ok");

  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", DEST, "--strip-components=1"], {
    stdio: "inherit",
  });

  trim(DEST);
  fs.writeFileSync(stamp, `${PG_VERSION}-${t}\n`);

  const mb = du(DEST) / 1e6;
  console.log(`PostgreSQL ${PG_VERSION} ready in src-tauri/resources/pgsql (${mb.toFixed(0)} MB)`);
}

/** Strip everything the POS never calls — headers, docs, locales, dev tooling. */
function trim(root) {
  for (const dir of ["include", "doc", "symbols", "pgAdmin 4"]) {
    fs.rmSync(path.join(root, dir), { recursive: true, force: true });
  }

  const bin = path.join(root, "bin");
  if (fs.existsSync(bin)) {
    for (const f of fs.readdirSync(bin)) {
      const stem = f.replace(/\.exe$/i, "");
      // Keep .dll/.so runtime deps; drop unused executables.
      if (/\.(dll|so|dylib)$/i.test(f)) continue;
      if (!KEEP_BIN.includes(stem)) fs.rmSync(path.join(bin, f), { force: true });
    }
  }

  // initdb needs share/, but not every locale on earth.
  const locale = path.join(root, "share", "locale");
  fs.rmSync(locale, { recursive: true, force: true });
}

function du(p) {
  const s = fs.statSync(p);
  if (!s.isDirectory()) return s.size;
  return fs.readdirSync(p).reduce((n, f) => n + du(path.join(p, f)), 0);
}

main().catch((e) => {
  console.error(`\nfetch-postgres failed: ${e.message}`);
  process.exit(1);
});
