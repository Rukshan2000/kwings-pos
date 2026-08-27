import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

export default function Inventory() {
  const qc = useQueryClient();
  const [lowOnly, setLowOnly] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"opening" | "adjustment">("adjustment");
  const [error, setError] = useState("");

  const levels = useQuery({
    queryKey: ["stock-levels", lowOnly],
    queryFn: () => api.stockLevels(lowOnly),
  });
  const valuation = useQuery({ queryKey: ["stock-valuation"], queryFn: api.stockValuation });
  const movements = useQuery({
    queryKey: ["stock-movements", selected],
    queryFn: () => api.stockMovements(selected!),
    enabled: selected !== null,
  });

  const apply = useMutation({
    mutationFn: async () => {
      if (!selected || !qty) return;
      if (mode === "opening") {
        await api.recordOpeningStock({ product_id: selected, quantity: qty, unit_cost: "0" });
      } else {
        await api.adjustStock({ product_id: selected, quantity: qty, reason_note: note });
      }
    },
    onSuccess: () => {
      setQty("");
      setNote("");
      setError("");
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
      qc.invalidateQueries({ queryKey: ["stock-movements", selected] });
      qc.invalidateQueries({ queryKey: ["stock-valuation"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="products">
      <div className="products-list">
        <div className="products-search" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            Low stock only
          </label>
          <span className="hint" style={{ margin: 0 }}>
            Stock valuation: {valuation.data ?? "…"}
          </span>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>SKU</th>
              <th>On hand</th>
              <th>Unit</th>
              <th>Low-stock at</th>
            </tr>
          </thead>
          <tbody>
            {levels.data?.map((l) => {
              const low = l.low_stock_at !== null && Number(l.on_hand) <= Number(l.low_stock_at);
              return (
                <tr
                  key={l.product_id}
                  className={selected === l.product_id ? "row-selected" : ""}
                  onClick={() => setSelected(l.product_id)}
                >
                  <td>{l.product_name}</td>
                  <td>{l.sku ?? "—"}</td>
                  <td className={low ? "warn" : undefined}>{l.on_hand}</td>
                  <td>{l.base_unit_code}</td>
                  <td>{l.low_stock_at ?? "—"}</td>
                </tr>
              );
            })}
            {levels.data?.length === 0 && (
              <tr><td colSpan={5} className="empty">Nothing to show.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="products-side">
        <div className="pane">
          <h2>{selected ? "Adjust stock" : "Select a product"}</h2>
          {selected && (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                apply.mutate();
              }}
            >
              <select value={mode} onChange={(e) => setMode(e.target.value as "opening" | "adjustment")}>
                <option value="adjustment">Stock adjustment (in/out)</option>
                <option value="opening">Opening stock (once only)</option>
              </select>
              <input
                type="number" step="0.001"
                placeholder={mode === "adjustment" ? "Signed quantity, e.g. -2 or 5" : "Quantity"}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                required
              />
              {mode === "adjustment" && (
                <input
                  placeholder="Reason *"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required
                />
              )}
              {error && <p className="warn">{error}</p>}
              <button type="submit" className="primary" disabled={apply.isPending}>
                {apply.isPending ? "Saving…" : "Apply"}
              </button>
            </form>
          )}
        </div>

        {selected && (
          <div className="pane">
            <h2>Movement history</h2>
            <ul className="plain-list">
              {movements.data?.map((m) => (
                <li key={m.id}>
                  {new Date(m.created_at).toLocaleString()} · {m.reason} ·{" "}
                  <b>{Number(m.quantity) > 0 ? `+${m.quantity}` : m.quantity}</b>
                  {m.note && ` — ${m.note}`}
                  {m.created_by_name && <span className="hint"> ({m.created_by_name})</span>}
                </li>
              ))}
              {movements.data?.length === 0 && <li className="hint">No movements yet.</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
