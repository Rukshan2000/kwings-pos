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
      <div className={embedded ? "pane" : "modal"} onClick={(e) => e.stopPropagation()}>
        <h2>Printer Settings</h2>

        {!isDesktop() && (
          <p className="warn">
            Running in a browser. Raw printing needs the desktop app — the browser
            print dialog is used instead.
          </p>
        )}

        <label>Receipt printer</label>
        <select value={printer} onChange={(e) => setPrinter(e.target.value)}>
          <option value="">
            {sysDefault ? `Windows default (${sysDefault})` : "Windows default"}
          </option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>

        {loading && <p className="hint">Looking for printers…</p>}
        {!loading && !names.length && isDesktop() && (
          <p className="warn">No printers found. Install the printer in Windows first.</p>
        )}
        {error && <p className="warn">{error}</p>}

        <label className="check">
          <input
            type="checkbox"
            checked={drawer}
            onChange={(e) => setDrawer(e.target.checked)}
          />
          Open cash drawer after printing
        </label>

        <p className="hint">
          Receipts are sent as raw ESC/POS at 80&nbsp;mm (48 columns), so nothing
          depends on the driver's paper settings.
        </p>

        <hr className="modal-rule" />

        <h3>Database</h3>
        {dbState.kind === "ready" ? (
          <p className="hint">
            PostgreSQL {dbState.health.serverVersion} on port {dbState.health.port} ·{" "}
            {dbState.health.migrations} migration
            {dbState.health.migrations === 1 ? "" : "s"} applied
            {dbState.health.dataDir && (
              <>
                <br />
                {dbState.health.dataDir}
              </>
            )}
          </p>
        ) : dbState.kind === "starting" ? (
          <p className="hint">Starting…</p>
        ) : dbState.kind === "browser" ? (
          <p className="hint">Not available in the browser.</p>
        ) : (
          <p className="warn">{dbState.message}</p>
        )}

        <button
          type="button"
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
        {backup && <p className={backup.startsWith("Backup failed") ? "warn" : "hint"}>{backup}</p>}

        <div className="modal-actions">
          <button type="button" onClick={load}>
            Refresh
          </button>
          <button type="button" className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
  );

  if (embedded) return body;
  return (
    <div className="modal-back" onClick={onClose}>
      {body}
    </div>
  );
}
