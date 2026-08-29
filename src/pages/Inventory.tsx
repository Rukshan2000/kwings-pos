import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import Pagination, { paginate } from "../components/Pagination";

export default function Inventory() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [lowOnly, setLowOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
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
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return levels.data ?? [];
    return (levels.data ?? []).filter(
      (l) => l.product_name.toLowerCase().includes(q) || (l.sku ?? "").toLowerCase().includes(q)
    );
  }, [levels.data, search]);
  const { pageItems, totalPages, safePage } = paginate(filtered, page, 15);
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
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <input
              className="field w-56"
              placeholder={t("common.search")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-brand-600 focus:ring-brand-400"
                checked={lowOnly}
                onChange={(e) => {
                  setLowOnly(e.target.checked);
                  setPage(1);
                }}
              />
              {t("inventory.lowStockOnly")}
            </label>
          </div>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {t("inventory.stockValuation")} <b className="text-slate-800 dark:text-slate-100">{valuation.data ?? "…"}</b>
          </span>
        </div>

        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <th className="px-2 py-2.5">{t("inventory.product")}</th>
                <th className="px-2 py-2.5">{t("inventory.sku")}</th>
                <th className="px-2 py-2.5">{t("inventory.initialStockCol")}</th>
                <th className="px-2 py-2.5">{t("inventory.onHand")}</th>
                <th className="px-2 py-2.5">{t("inventory.unit")}</th>
                <th className="px-2 py-2.5">{t("inventory.lowStockAt")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {pageItems.map((l) => {
                // 0 is the shop opting out of the warning, not a threshold an
                // out-of-stock item permanently sits on.
                const low = Number(l.low_stock_at) > 0 && Number(l.on_hand) <= Number(l.low_stock_at);
                return (
                  <tr
                    key={l.product_id}
                    onClick={() => setSelected(l.product_id)}
                    className={`cursor-pointer transition-colors ${
                      selected === l.product_id ? "bg-brand-50" : "hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    <td className="px-2 py-2.5 text-slate-800 dark:text-slate-100">{l.product_name}</td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{l.sku ?? "—"}</td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{l.initial_stock}</td>
                    <td className={`px-2 py-2.5 font-medium ${low ? "text-amber-600" : "text-slate-800 dark:text-slate-100"}`}>
                      {l.on_hand}
                    </td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{l.base_unit_code}</td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">
                      {Number(l.low_stock_at) > 0 ? l.low_stock_at : "—"}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-10 text-center text-slate-400 dark:text-slate-500">{t("inventory.nothingToShow")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={safePage} totalPages={totalPages} totalItems={filtered.length} pageSize={15} onPageChange={setPage} />
      </div>

      <div className="flex flex-col gap-5">
        <div className="card p-6">
          <h2 className="mb-4 text-sm font-semibold text-brand-700">
            {selected ? t("inventory.adjustStock") : t("inventory.selectProduct")}
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
                <option value="adjustment">{t("inventory.stockAdjustment")}</option>
                <option value="opening">{t("inventory.openingStock")}</option>
              </select>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t("inventory.restockHint")}</p>
              <input
                className="field"
                type="number" step="0.001"
                placeholder={mode === "adjustment" ? t("inventory.signedQtyPlaceholder") : t("inventory.quantityPlaceholder")}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                required
              />
              {mode === "adjustment" && (
                <input
                  className="field"
                  placeholder={t("inventory.reasonPlaceholder")}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required
                />
              )}
              {error && <p className="text-sm text-amber-600">{error}</p>}
              <button type="submit" className="btn-primary w-full" disabled={apply.isPending}>
                {apply.isPending ? t("common.saving") : t("inventory.apply")}
              </button>
            </form>
          )}
        </div>

        {selected && (
          <div className="card p-6">
            <h2 className="mb-4 text-sm font-semibold text-brand-700">{t("inventory.movementHistory")}</h2>
            <ul className="space-y-2 text-sm text-slate-600 dark:text-slate-300 max-h-80 overflow-y-auto">
              {movements.data?.map((m) => (
                <li key={m.id} className="border-b border-slate-100 dark:border-slate-800 pb-2">
                  <span className="text-slate-400 dark:text-slate-500">{new Date(m.created_at).toLocaleString()}</span> · {m.reason} ·{" "}
                  <b className={Number(m.quantity) > 0 ? "text-emerald-600" : "text-amber-600"}>
                    {Number(m.quantity) > 0 ? `+${m.quantity}` : m.quantity}
                  </b>
                  {m.note && ` — ${m.note}`}
                  {m.created_by_name && <span className="text-slate-400 dark:text-slate-500"> ({m.created_by_name})</span>}
                </li>
              ))}
              {movements.data?.length === 0 && <li className="text-slate-400 dark:text-slate-500">{t("inventory.noMovementsYet")}</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
