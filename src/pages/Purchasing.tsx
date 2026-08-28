import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { lkr } from "../types";

type Line = { product_id: number; unit_id: number; quantity: string; unit_cost: string };

export default function Purchasing() {
  const qc = useQueryClient();
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [productId, setProductId] = useState("");
  const [unitId, setUnitId] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState("");
  const [selectedPurchase, setSelectedPurchase] = useState<number | null>(null);

  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: api.suppliers });
  const products = useQuery({ queryKey: ["products", ""], queryFn: () => api.products() });
  const units = useQuery({ queryKey: ["units"], queryFn: api.units });
  const purchases = useQuery({ queryKey: ["purchases"], queryFn: api.purchases });
  const detail = useQuery({
    queryKey: ["purchase", selectedPurchase],
    queryFn: () => api.purchase(selectedPurchase!),
    enabled: selectedPurchase !== null,
  });

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
      setLines([]);
      setInvoiceNumber("");
      setError("");
      qc.invalidateQueries({ queryKey: ["purchases"] });
      setSelectedPurchase(p.id);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const receive = useMutation({
    mutationFn: (id: number) => api.receivePurchase(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchases"] });
      qc.invalidateQueries({ queryKey: ["purchase", selectedPurchase] });
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
    },
  });

  const statusPill = (status: string) => {
    const styles: Record<string, string> = {
      draft: "bg-slate-100 text-slate-600",
      received: "bg-emerald-100 text-emerald-700",
      cancelled: "bg-amber-100 text-amber-600",
    };
    return (
      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[status] ?? styles.draft}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5 items-start">
      <div className="card p-6">
        <h2 className="mb-4 text-sm font-semibold text-brand-700">Purchases</h2>
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
                <th className="px-2 py-2.5">Supplier</th>
                <th className="px-2 py-2.5">Invoice</th>
                <th className="px-2 py-2.5">Status</th>
                <th className="px-2 py-2.5">Total</th>
                <th className="px-2 py-2.5">Paid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {purchases.data?.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedPurchase(p.id)}
                  className={`cursor-pointer transition-colors ${
                    selectedPurchase === p.id ? "bg-brand-50" : "hover:bg-slate-50"
                  }`}
                >
                  <td className="px-2 py-2.5 text-slate-800">{p.supplier_name}</td>
                  <td className="px-2 py-2.5 text-slate-500">{p.invoice_number ?? "—"}</td>
                  <td className="px-2 py-2.5">{statusPill(p.status)}</td>
                  <td className="px-2 py-2.5 text-slate-800">{lkr(Number(p.total))}</td>
                  <td className="px-2 py-2.5 text-slate-500">{lkr(Number(p.paid))}</td>
                </tr>
              ))}
              {purchases.data?.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-10 text-center text-slate-400">No purchases yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {detail.data && (
          <div className="mt-5 rounded-xl border border-slate-200 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-800">Purchase #{detail.data.id}</h3>
              {statusPill(detail.data.status)}
            </div>
            <ul className="mb-3 space-y-1 text-sm text-slate-600">
              {detail.data.lines.map((l) => (
                <li key={l.id}>
                  {l.product_name}: {l.quantity} {l.unit_code} @ {lkr(Number(l.unit_cost))} = {lkr(Number(l.line_total))}
                </li>
              ))}
            </ul>
            {detail.data.status === "draft" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => receive.mutate(detail.data.id)}
                disabled={receive.isPending}
              >
                {receive.isPending ? "Receiving…" : "Mark received (adds to stock)"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-5">
        <div className="card p-6">
          <h2 className="mb-4 text-sm font-semibold text-brand-700">New Purchase</h2>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            <select className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Supplier…</option>
              {suppliers.data?.map((s) => (
                <option key={s.id} value={s.id}>{s.name} (owed {lkr(Number(s.outstanding))})</option>
              ))}
            </select>
            {suppliers.data?.length === 0 && (
              <p className="col-span-full text-xs text-slate-400">
                No suppliers yet — add one under{" "}
                <Link className="text-brand-600 hover:underline" to="/master-entries">
                  Master Entries
                </Link>
                .
              </p>
            )}
            <input
              className="field"
              placeholder="Invoice number"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />

            <h3 className="label pt-1">Lines</h3>
            <ul className="space-y-1 text-sm text-slate-600">
              {lines.map((l, i) => {
                const p = products.data?.find((x) => x.id === l.product_id);
                const u = units.data?.find((x) => x.id === l.unit_id);
                return <li key={i}>{p?.name ?? l.product_id}: {l.quantity} {u?.code} @ {lkr(Number(l.unit_cost))}</li>;
              })}
            </ul>
            <select className="field" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Product…</option>
              {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <select className="field" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">Unit…</option>
                {units.data?.map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}
              </select>
              <input
                className="field"
                type="number" step="0.001"
                placeholder="Qty"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <input
                className="field"
                type="number" step="0.01"
                placeholder="Unit cost"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
              <button type="button" className="btn-secondary" onClick={addLine}>Add line</button>
            </div>

            <p className="text-sm text-slate-500">Total: <b className="text-slate-800">{total.toFixed(2)}</b></p>
            {error && <p className="text-sm text-amber-600">{error}</p>}
            <button
              type="submit"
              className="btn-primary w-full"
              disabled={!supplierId || lines.length === 0 || submit.isPending}
            >
              {submit.isPending ? "Saving…" : "Create purchase (draft)"}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
