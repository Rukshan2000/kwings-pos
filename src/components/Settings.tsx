import { useEffect, useState } from "react";
import {
  isDesktop,
  listPrinters,
  savedDrawer,
  savedPrinter,
  setSavedDrawer,
  setSavedPrinter,
} from "../printer";

export default function Settings({ onClose }: { onClose: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [sysDefault, setSysDefault] = useState<string | null>(null);
  const [printer, setPrinter] = useState(savedPrinter);
  const [drawer, setDrawer] = useState(savedDrawer);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
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

        <div className="modal-actions">
          <button type="button" onClick={load}>
            Refresh
          </button>
          <button type="button" className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
