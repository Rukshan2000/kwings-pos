import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../api";
import SearchableSelect from "../components/SearchableSelect";
import Pagination, { paginate } from "../components/Pagination";
import { lkr } from "../types";

type Line = { product_id: number; unit_id: number; quantity: string; unit_cost: string };

function StatusPill({ status }: { status: string }) {
  const { t } = useTranslation();
  const styles: Record<string, string> = {
    draft: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
    received: "bg-emerald-100 text-emerald-700",
    cancelled: "bg-amber-100 text-amber-600",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? styles.draft}`}>
      {t(`purchasing.status_${status}`, status)}
    </span>
  );
}

export default function Purchasing() {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPurchase, setSelectedPurchase] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const purchases = useQuery({ queryKey: ["purchases"], queryFn: api.purchases });
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return purchases.data ?? [];
    return (purchases.data ?? []).filter(
      (p) =>
        p.supplier_name.toLowerCase().includes(q) ||
        (p.invoice_number ?? "").toLowerCase().includes(q) ||
        (p.product_names ?? "").toLowerCase().includes(q)
    );
  }, [purchases.data, search]);
  const { pageItems, totalPages, safePage } = paginate(filtered, page, 15);

  return (
    <div className="w-full">
      <div className="card p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-brand-700">{t("purchasing.purchases")}</h2>
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
            <button type="button" className="btn-primary shrink-0" onClick={() => setDialogOpen(true)}>
              {t("purchasing.newPurchase")}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <th className="px-2 py-2.5">{t("purchasing.date")}</th>
                <th className="px-2 py-2.5">{t("purchasing.supplier")}</th>
                <th className="px-2 py-2.5">{t("purchasing.invoice")}</th>
                <th className="px-2 py-2.5">{t("purchasing.status")}</th>
                <th className="px-2 py-2.5">{t("purchasing.products")}</th>
                <th className="px-2 py-2.5">{t("purchasing.items")}</th>
                <th className="px-2 py-2.5">{t("purchasing.total")}</th>
                <th className="px-2 py-2.5">{t("purchasing.paid")}</th>
                <th className="px-2 py-2.5">{t("purchasing.outstanding")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {pageItems.map((p) => {
                const outstanding = Number(p.total) - Number(p.paid);
                return (
                  <tr
                    key={p.id}
                    onClick={() => setSelectedPurchase(p.id)}
                    className={`cursor-pointer transition-colors ${
                      selectedPurchase === p.id ? "bg-brand-50" : "hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{new Date(p.created_at).toLocaleDateString()}</td>
                    <td className="px-2 py-2.5 text-slate-800 dark:text-slate-100">{p.supplier_name}</td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{p.invoice_number ?? "—"}</td>
                    <td className="px-2 py-2.5"><StatusPill status={p.status} /></td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400 max-w-xs truncate" title={p.product_names}>
                      {p.product_names || "—"}
                    </td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{p.line_count}</td>
                    <td className="px-2 py-2.5 text-slate-800 dark:text-slate-100">{lkr(Number(p.total))}</td>
                    <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{lkr(Number(p.paid))}</td>
                    <td className={`px-2 py-2.5 font-medium ${outstanding > 0 ? "text-amber-600" : "text-slate-800 dark:text-slate-100"}`}>
                      {lkr(outstanding)}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="px-2 py-10 text-center text-slate-400 dark:text-slate-500">{t("purchasing.noPurchasesYet")}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination page={safePage} totalPages={totalPages} totalItems={filtered.length} pageSize={15} onPageChange={setPage} />
      </div>

      <NewPurchaseDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(id) => setSelectedPurchase(id)}
      />

      <PurchaseDetailDialog purchaseId={selectedPurchase} onClose={() => setSelectedPurchase(null)} />
    </div>
  );
}

function PurchaseDetailDialog({ purchaseId, onClose }: { purchaseId: number | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [error, setError] = useState("");

  const detail = useQuery({
    queryKey: ["purchase", purchaseId],
    queryFn: () => api.purchase(purchaseId!),
    enabled: purchaseId !== null,
  });

  const outstanding = detail.data ? Number(detail.data.total) - Number(detail.data.paid) : 0;

  useEffect(() => {
    if (detail.data) setAmount(outstanding > 0 ? outstanding.toFixed(2) : "");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.data?.id, detail.data?.paid]);

  useEffect(() => {
    if (purchaseId === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [purchaseId, onClose]);

  const receive = useMutation({
    mutationFn: (id: number) => api.receivePurchase(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["purchase", purchaseId] });
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
    },
  });

  const settle = useMutation({
    mutationFn: () => api.recordPurchasePayment(purchaseId!, amount, method),
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["purchase", purchaseId] });
      qc.invalidateQueries({ queryKey: ["suppliers"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (purchaseId === null) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("purchasing.purchaseNumber", { id: purchaseId })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-brand-700">
            {t("purchasing.purchaseNumber", { id: purchaseId })}
          </h2>
          <div className="flex items-center gap-3">
            {detail.data && <StatusPill status={detail.data.status} />}
            <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" onClick={onClose}>
              {t("common.close")}
            </button>
          </div>
        </div>

        {detail.data && (
          <>
            <p className="mb-1 text-sm text-slate-500 dark:text-slate-400">{detail.data.supplier_name}</p>
            <p className={`text-xs text-slate-400 dark:text-slate-500 ${detail.data.received_at ? "mb-1" : "mb-3"}`}>
              {t("purchasing.purchaseDate")} {new Date(detail.data.created_at).toLocaleString()}
            </p>
            {detail.data.received_at && (
              <p className="mb-3 text-xs text-slate-400 dark:text-slate-500">
                {t("purchasing.receivedDate")} {new Date(detail.data.received_at).toLocaleString()}
              </p>
            )}
            <ul className="mb-4 space-y-1 text-sm text-slate-600 dark:text-slate-300">
              {detail.data.lines.map((l) => (
                <li key={l.id}>
                  {l.product_name}: {l.quantity} {l.unit_code} @ {lkr(Number(l.unit_cost))} = {lkr(Number(l.line_total))}
                </li>
              ))}
            </ul>

            <div className="mb-4 space-y-1 rounded-lg bg-slate-50 dark:bg-slate-800 p-3 text-sm">
              <p className="flex justify-between text-slate-600 dark:text-slate-300">
                <span>{t("purchasing.total")}</span>
                <span className="text-slate-800 dark:text-slate-100">{lkr(Number(detail.data.total))}</span>
              </p>
              <p className="flex justify-between text-slate-600 dark:text-slate-300">
                <span>{t("purchasing.paid")}</span>
                <span className="text-slate-800 dark:text-slate-100">{lkr(Number(detail.data.paid))}</span>
              </p>
              <p className="flex justify-between font-medium">
                <span className={outstanding > 0 ? "text-amber-600" : "text-slate-600 dark:text-slate-300"}>
                  {t("purchasing.outstanding")}
                </span>
                <span className={outstanding > 0 ? "text-amber-600" : "text-slate-800 dark:text-slate-100"}>{lkr(outstanding)}</span>
              </p>
            </div>

            {detail.data.payments.length > 0 && (
              <div className="mb-4">
                <h3 className="label mb-1.5">{t("purchasing.paymentHistory")}</h3>
                <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
                  {detail.data.payments.map((pmt) => (
                    <li key={pmt.id} className="flex justify-between">
                      <span className="text-slate-400 dark:text-slate-500">{new Date(pmt.paid_at).toLocaleString()}</span>
                      <span>
                        {lkr(Number(pmt.amount))} · <span className="capitalize">{pmt.method.replace("_", " ")}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {detail.data.status === "draft" && (
              <button
                type="button"
                className="btn-primary w-full mb-4"
                onClick={() => receive.mutate(detail.data!.id)}
                disabled={receive.isPending}
              >
                {receive.isPending ? t("purchasing.receiving") : t("purchasing.markReceived")}
              </button>
            )}

            {detail.data.status === "received" && outstanding > 0 && (
              <form
                className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  settle.mutate();
                }}
              >
                <h3 className="label">{t("purchasing.settleOutstanding")}</h3>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="label mb-1 block">{t("purchasing.paymentAmount")}</span>
                    <input
                      className="field"
                      type="number" step="0.01" min="0.01" max={outstanding}
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      required
                    />
                  </label>
                  <label className="block">
                    <span className="label mb-1 block">{t("purchasing.paymentMethod")}</span>
                    <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
                      <option value="cash">{t("purchasing.methodCash")}</option>
                      <option value="card">{t("purchasing.methodCard")}</option>
                      <option value="bank_transfer">{t("purchasing.methodBankTransfer")}</option>
                    </select>
                  </label>
                </div>
                {error && <p className="text-sm text-amber-600">{error}</p>}
                <button type="submit" className="btn-primary w-full" disabled={settle.isPending}>
                  {settle.isPending ? t("common.saving") : t("purchasing.recordPayment")}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NewPurchaseDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [productId, setProductId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState("");

  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: api.suppliers, enabled: open });
  const products = useQuery({ queryKey: ["products", ""], queryFn: () => api.products(), enabled: open });
  const units = useQuery({ queryKey: ["units"], queryFn: api.units, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const reset = () => {
    setSupplierId("");
    setInvoiceNumber("");
    setLines([]);
    setProductId("");
    setUnitId("");
    setQty("");
    setCost("");
    setError("");
  };

  const addLine = () => {
    if (!productId || !unitId || !qty || !cost) return;
    setLines([...lines, { product_id: Number(productId), unit_id: Number(unitId), quantity: qty, unit_cost: cost }]);
    setQty("");
    setCost("");
  };

  const total = lines.reduce((s, l) => s + Number(l.quantity) * Number(l.unit_cost), 0);

  const submit = useMutation({
    mutationFn: () =>
      api.createPurchase({ supplier_id: Number(supplierId), invoice_number: invoiceNumber || null, lines }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      reset();
      onClose();
      onCreated(p.id);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("purchasing.newPurchase")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-brand-700">{t("purchasing.newPurchase")}</h2>
          <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit.mutate();
          }}
        >
          <label className="block">
            <span className="label mb-1 block">{t("purchasing.supplierLabel")}</span>
            <select className="select" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">{t("purchasing.supplierPlaceholder")}</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>{t("purchasing.supplierOwed", { name: s.name, amount: lkr(Number(s.outstanding)) })}</option>
              ))}
            </select>
            {suppliers.data?.length === 0 && (
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                <Trans
                  i18nKey="purchasing.noSuppliersYet"
                  components={{
                    link: <Link className="text-brand-600 hover:underline" to="/master-entries" />,
                  }}
                />
              </p>
            )}
          </label>

          <label className="block">
            <span className="label mb-1 block">{t("purchasing.invoiceNumberLabel")}</span>
            <input
              className="field"
              placeholder={t("purchasing.invoiceNumberPlaceholder")}
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />
          </label>

          <h3 className="label pt-1">{t("purchasing.lines")}</h3>
          {lines.length > 0 && (
            <ul className="space-y-1 text-sm text-slate-600 dark:text-slate-300">
              {lines.map((l, i) => {
                const p = products.data?.find((x) => x.id === l.product_id);
                const u = units.data?.find((x) => x.id === l.unit_id);
                return <li key={i}>{p?.name ?? l.product_id}: {l.quantity} {u?.code} @ {lkr(Number(l.unit_cost))}</li>;
              })}
            </ul>
          )}

          <label className="block">
            <span className="label mb-1 block">{t("purchasing.productLabel")}</span>
            <SearchableSelect
              options={(products.data ?? []).map((p) => ({ id: p.id, label: p.name, sublabel: p.sku ?? undefined }))}
              value={productId ? Number(productId) : null}
              onChange={(id) => setProductId(String(id))}
              placeholder={t("purchasing.productPlaceholder")}
              noResultsLabel={t("purchasing.noProductsFound")}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label mb-1 block">{t("purchasing.unitLabel")}</span>
              <select className="select" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">{t("purchasing.unitPlaceholder")}</option>
                {units.data?.map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label mb-1 block">{t("purchasing.qtyLabel")}</span>
              <input
                className="field"
                type="number" step="0.001"
                placeholder={t("purchasing.qtyPlaceholder")}
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </label>
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <label className="block">
              <span className="label mb-1 block">{t("purchasing.unitCostLabel")}</span>
              <input
                className="field"
                type="number" step="0.01"
                placeholder={t("purchasing.unitCostPlaceholder")}
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
            </label>
            <button type="button" className="btn-secondary" onClick={addLine}>{t("purchasing.addLine")}</button>
          </div>

          <p className="text-sm text-slate-500 dark:text-slate-400">{t("purchasing.totalLabel")} <b className="text-slate-800 dark:text-slate-100">{total.toFixed(2)}</b></p>
          {error && <p className="text-sm text-amber-600">{error}</p>}
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={!supplierId || lines.length === 0 || submit.isPending}
          >
            {submit.isPending ? t("common.saving") : t("purchasing.createPurchaseDraft")}
          </button>
        </form>
      </div>
    </div>
  );
}
