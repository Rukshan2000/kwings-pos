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
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5 items-start">
      <div className="card p-6">
        <div className="mb-4 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-400"
              checked={lowOnly}
              onChange={(e) => setLowOnly(e.target.checked)}
            />
            Low stock only
          </label>
          <span className="text-sm text-slate-500">
            Stock valuation: <b className="text-slate-800">{valuation.data ?? "…"}</b>
          </span>
        </div>

        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
                <th className="px-2 py-2.5">Product</th>
                <th className="px-2 py-2.5">SKU</th>
                <th className="px-2 py-2.5">On hand</th>
                <th className="px-2 py-2.5">Unit</th>
                <th className="px-2 py-2.5">Low-stock at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {levels.data?.map((l) => {
                // 0 is the shop opting out of the warning, not a threshold an
                // out-of-stock item permanently sits on.
                const low = Number(l.low_stock_at) > 0 && Number(l.on_hand) <= Number(l.low_stock_at);
                return (
                  <tr
                    key={l.product_id}
                    onClick={() => setSelected(l.product_id)}
                    className={`cursor-pointer transition-colors ${
                      selected === l.product_id ? "bg-brand-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <td className="px-2 py-2.5 text-slate-800">{l.product_name}</td>
                    <td className="px-2 py-2.5 text-slate-500">{l.sku ?? "—"}</td>
                    <td className={`px-2 py-2.5 font-medium ${low ? "text-amber-600" : "text-slate-800"}`}>
                      {l.on_hand}
                    </td>
                    <td className="px-2 py-2.5 text-slate-500">{l.base_unit_code}</td>
                    <td className="px-2 py-2.5 text-slate-500">
                      {Number(l.low_stock_at) > 0 ? l.low_stock_at : "—"}
                    </td>
                  </tr>
                );
              })}
              {levels.data?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-10 text-center text-slate-400">Nothing to show.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="card p-6">
          <h2 className="mb-4 text-sm font-semibold text-brand-700">
            {selected ? "Adjust stock" : "Select a product"}
          </h2>
          {selected && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                apply.mutate();
              }}
            >
              <select className="select" value={mode} onChange={(e) => setMode(e.target.value as "opening" | "adjustment")}>
                <option value="adjustment">Stock adjustment (in/out)</option>
                <option value="opening">Opening stock (once only)</option>
              </select>
              <input
                className="field"
                type="number" step="0.001"
                placeholder={mode === "adjustment" ? "Signed quantity, e.g. -2 or 5" : "Quantity"}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                required
              />
              {mode === "adjustment" && (
                <input
                  className="field"
                  placeholder="Reason *"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required
                />
              )}
              {error && <p className="text-sm text-amber-600">{error}</p>}
              <button type="submit" className="btn-primary w-full" disabled={apply.isPending}>
                {apply.isPending ? "Saving…" : "Apply"}
              </button>
            </form>
          )}
        </div>

        {selected && (
          <div className="card p-6">
            <h2 className="mb-4 text-sm font-semibold text-brand-700">Movement history</h2>
            <ul className="space-y-2 text-sm text-slate-600 max-h-80 overflow-y-auto">
              {movements.data?.map((m) => (
                <li key={m.id} className="border-b border-slate-100 pb-2">
                  <span className="text-slate-400">{new Date(m.created_at).toLocaleString()}</span> · {m.reason} ·{" "}
                  <b className={Number(m.quantity) > 0 ? "text-emerald-600" : "text-amber-600"}>
                    {Number(m.quantity) > 0 ? `+${m.quantity}` : m.quantity}
                  </b>
                  {m.note && ` — ${m.note}`}
                  {m.created_by_name && <span className="text-slate-400"> ({m.created_by_name})</span>}
                </li>
              ))}
              {movements.data?.length === 0 && <li className="text-slate-400">No movements yet.</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
