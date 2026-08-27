import { useEffect, useState } from "react";
import { backupNow, DbState } from "../db";
import {
  isDesktop,
  listPrinters,
  savedDrawer,
  savedPrinter,
  setSavedDrawer,
  setSavedPrinter,
} from "../printer";

export default function Settings({
  dbState,
  onClose,
  embedded,
}: {
  dbState: DbState;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [sysDefault, setSysDefault] = useState<string | null>(null);
  const [printer, setPrinter] = useState(savedPrinter);
  const [drawer, setDrawer] = useState(savedDrawer);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [backup, setBackup] = useState("");
  const [backingUp, setBackingUp] = useState(false);

  const load = () => {
    setLoading(true);
    setError("");
    listPrinters()
      .then((p) => {
        setNames(p.names);
        setSysDefault(p.default);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const save = () => {
    setSavedPrinter(printer);
    setSavedDrawer(drawer);
    onClose();
  };

  const body = (
    <div
      className={embedded ? "card p-6 space-y-5" : "card w-[440px] max-w-[92vw] p-6 space-y-5"}
      onClick={(e) => e.stopPropagation()}
    >
      <h2 className="text-base font-semibold text-brand-700">Printer Settings</h2>

      {!isDesktop() && (
        <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800">
          Running in a browser. Raw printing needs the desktop app — the browser print dialog is used instead.
        </p>
      )}

      <div>
        <label className="label mb-1.5 block">Receipt printer</label>
        <select className="field" value={printer} onChange={(e) => setPrinter(e.target.value)}>
          <option value="">{sysDefault ? `Windows default (${sysDefault})` : "Windows default"}</option>
          {names.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        {loading && <p className="mt-1.5 text-xs text-slate-400">Looking for printers…</p>}
        {!loading && !names.length && isDesktop() && (
          <p className="mt-1.5 text-xs text-amber-600">No printers found. Install the printer in Windows first.</p>
        )}
        {error && <p className="mt-1.5 text-xs text-amber-600">{error}</p>}
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
          checked={drawer}
          onChange={(e) => setDrawer(e.target.checked)}
        />
        Open cash drawer after printing
      </label>

      <p className="text-xs text-slate-500 leading-relaxed">
        Receipts are sent as raw ESC/POS at 80&nbsp;mm (48 columns), so nothing depends on the driver's paper settings.
      </p>

      <div className="border-t border-slate-100 pt-5">
        <h3 className="mb-2 text-sm font-semibold text-brand-700">Database</h3>
        {dbState.kind === "ready" ? (
          <p className="text-xs text-slate-500 leading-relaxed">
            PostgreSQL {dbState.health.serverVersion} on port {dbState.health.port} ·{" "}
            {dbState.health.migrations} migration{dbState.health.migrations === 1 ? "" : "s"} applied
            {dbState.health.dataDir && (
              <>
                <br />
                {dbState.health.dataDir}
              </>
            )}
          </p>
        ) : dbState.kind === "starting" ? (
          <p className="text-xs text-slate-400">Starting…</p>
        ) : dbState.kind === "browser" ? (
          <p className="text-xs text-slate-400">Not available in the browser.</p>
        ) : (
          <p className="text-xs text-amber-600">{dbState.message}</p>
        )}

        <button
          type="button"
          className="btn-secondary mt-3"
          disabled={dbState.kind !== "ready" || backingUp}
          onClick={async () => {
            setBackingUp(true);
            setBackup("");
            try {
              setBackup(`Saved to ${await backupNow()}`);
            } catch (e) {
              setBackup(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
            } finally {
              setBackingUp(false);
            }
          }}
        >
          {backingUp ? "Backing up…" : "Backup now"}
        </button>
        {backup && (
          <p className={`mt-1.5 text-xs ${backup.startsWith("Backup failed") ? "text-amber-600" : "text-slate-500"}`}>
            {backup}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-5">
        <button type="button" className="btn-secondary" onClick={load}>Refresh</button>
        <button type="button" className="btn-primary" onClick={save}>Save</button>
      </div>
    </div>
  );

  if (embedded) return body;
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40" onClick={onClose}>
      {body}
    </div>
  );
}
