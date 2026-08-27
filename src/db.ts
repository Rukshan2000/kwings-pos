import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isDesktop } from "./printer";

export type DbHealth = {
  connected: boolean;
  serverVersion: string;
  port: number;
  database: string;
  dataDir: string | null;
  migrations: number;
  latestMigration: string | null;
};

type RawHealth = {
  connected: boolean;
  server_version: string;
  port: number;
  database: string;
  data_dir: string | null;
  migrations: number;
  latest_migration: string | null;
};

export type DbState =
  | { kind: "browser" }
  | { kind: "starting" }
  | { kind: "ready"; health: DbHealth }
  | { kind: "error"; message: string };

export const dbHealth = async (): Promise<DbHealth> => {
  const r = await invoke<RawHealth>("db_health");
  return {
    connected: r.connected,
    serverVersion: r.server_version,
    port: r.port,
    database: r.database,
    dataDir: r.data_dir,
    migrations: r.migrations,
    latestMigration: r.latest_migration,
  };
};

export const backupNow = () => invoke<string>("backup_now");

const POLL_INTERVAL_MS = 400;

/**
 * Watches the bootstrap. The first launch runs initdb and can take a while, so the
 * UI reports progress rather than appearing hung.
 *
 * Polls `db_status` on an interval rather than relying solely on the `db-ready`
 * event. `listen()` only resolves once the backend confirms the listener is
 * registered, and the Rust side can emit before that registration completes —
 * on a fast machine it reliably does, since bootstrap can finish in well under a
 * second. A single one-shot poll has the same race the other way. Polling until
 * resolved is immune to both: the only failure mode left is genuinely never
 * becoming ready, which is exactly what should show as stuck.
 */
export function watchDb(onChange: (s: DbState) => void): () => void {
  if (!isDesktop()) {
    onChange({ kind: "browser" });
    return () => {};
  }

  let stopped = false;
  let resolved = false;
  onChange({ kind: "starting" });

  const ready = async () => {
    if (resolved || stopped) return;
    try {
      const health = await dbHealth();
      if (stopped) return;
      resolved = true;
      onChange({ kind: "ready", health });
    } catch (e) {
      if (stopped) return;
      onChange({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const fail = (message: string) => {
    if (resolved || stopped) return;
    resolved = true;
    onChange({ kind: "error", message });
  };

  const unlisten = Promise.all([
    listen("db-ready", () => ready()),
    listen<string>("db-error", (e) => fail(e.payload)),
  ]);

  const poll = async () => {
    while (!stopped && !resolved) {
      try {
        const s = await invoke<{ ready: boolean; error: string | null }>("db_status");
        if (s.ready) {
          await ready();
          return;
        }
        if (s.error) {
          fail(s.error);
          return;
        }
      } catch {
        // db_status itself failing (e.g. during a hot reload) is not a database
        // error — just keep polling rather than reporting a false failure.
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  };
  void poll();

  return () => {
    stopped = true;
    unlisten.then((fns) => fns.forEach((f) => f()));
  };
}
