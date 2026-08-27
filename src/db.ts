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

/**
 * Watches the bootstrap. The first launch runs initdb and can take a while, so the
 * UI reports progress rather than appearing hung.
 */
export function watchDb(onChange: (s: DbState) => void): () => void {
  if (!isDesktop()) {
    onChange({ kind: "browser" });
    return () => {};
  }

  let stopped = false;
  onChange({ kind: "starting" });

  const ready = async () => {
    try {
      onChange({ kind: "ready", health: await dbHealth() });
    } catch (e) {
      onChange({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const unlisten = Promise.all([
    listen("db-ready", () => !stopped && ready()),
    listen<string>("db-error", (e) => !stopped && onChange({ kind: "error", message: e.payload })),
  ]);

  // The event can land before this listener is attached, so poll once at startup.
  invoke<{ ready: boolean }>("db_status")
    .then((s) => {
      if (s.ready && !stopped) void ready();
    })
    .catch(() => {});

  return () => {
    stopped = true;
    unlisten.then((fns) => fns.forEach((f) => f()));
  };
}
