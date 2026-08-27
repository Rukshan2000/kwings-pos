import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

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
  const [newSupplierName, setNewSupplierName] = useState("");

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
      api.createPurchase({
        supplier_id: Number(supplierId),
        invoice_number: invoiceNumber || null,
        lines,
      }),
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

  return (
    <div className="products">
      <div className="products-list">
        <h2>Purchases</h2>
        <table className="table">
          <thead>
            <tr><th>Supplier</th><th>Invoice</th><th>Status</th><th>Total</th><th>Paid</th></tr>
          </thead>
          <tbody>
            {purchases.data?.map((p) => (
              <tr
                key={p.id}
                className={selectedPurchase === p.id ? "row-selected" : ""}
                onClick={() => setSelectedPurchase(p.id)}
              >
                <td>{p.supplier_name}</td>
                <td>{p.invoice_number ?? "—"}</td>
                <td>{p.status}</td>
                <td>{p.total}</td>
                <td>{p.paid}</td>
              </tr>
            ))}
            {purchases.data?.length === 0 && <tr><td colSpan={5} className="empty">No purchases yet.</td></tr>}
          </tbody>
        </table>

        {detail.data && (
          <div className="pane" style={{ marginTop: 16 }}>
            <h2>Purchase #{detail.data.id} — {detail.data.status}</h2>
            <ul className="plain-list">
              {detail.data.lines.map((l) => (
                <li key={l.id}>{l.product_name}: {l.quantity} {l.unit_code} @ {l.unit_cost} = {l.line_total}</li>
              ))}
            </ul>
            {detail.data.status === "draft" && (
              <button type="button" className="primary" onClick={() => receive.mutate(detail.data.id)} disabled={receive.isPending}>
                {receive.isPending ? "Receiving…" : "Mark received (adds to stock)"}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="products-side">
        <div className="pane">
          <h2>New Purchase</h2>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Supplier…</option>
              {suppliers.data?.map((s) => <option key={s.id} value={s.id}>{s.name} (owed {s.outstanding})</option>)}
            </select>
            <input placeholder="Invoice number" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />

            <h3>Lines</h3>
            <ul className="plain-list">
              {lines.map((l, i) => {
                const p = products.data?.find((x) => x.id === l.product_id);
                const u = units.data?.find((x) => x.id === l.unit_id);
                return <li key={i}>{p?.name ?? l.product_id}: {l.quantity} {u?.code} @ {l.unit_cost}</li>;
              })}
            </ul>
            <select value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">Product…</option>
              {products.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <div className="row2">
              <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">Unit…</option>
                {units.data?.map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}
              </select>
              <input type="number" step="0.001" placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="row2">
              <input type="number" step="0.01" placeholder="Unit cost" value={cost} onChange={(e) => setCost(e.target.value)} />
              <button type="button" onClick={addLine}>Add line</button>
            </div>

            <p className="hint">Total: {total.toFixed(2)}</p>
            {error && <p className="warn">{error}</p>}
            <button type="submit" className="primary" disabled={!supplierId || lines.length === 0 || submit.isPending}>
              {submit.isPending ? "Saving…" : "Create purchase (draft)"}
            </button>
          </form>
        </div>

        <div className="pane">
          <h2>New Supplier</h2>
          <form
            className="row2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!newSupplierName.trim()) return;
              await api.createSupplier({ name: newSupplierName.trim(), phone: null, address: null });
              setNewSupplierName("");
              qc.invalidateQueries({ queryKey: ["suppliers"] });
            }}
          >
            <input placeholder="Name" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} />
            <button type="submit">Add</button>
          </form>
        </div>
      </div>
    </div>
  );
}
