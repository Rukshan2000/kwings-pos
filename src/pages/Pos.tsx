import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api, Product } from "../api";
import Receipt from "../components/Receipt";
import { printBill } from "../printer";
import { SHOP } from "../shop";
import { Bill, Item, money } from "../types";

type CartLine = Item & { productId: number; unitId: number; discount: number };
type Payment = { method: string; amount: string };

const uid = () => Math.random().toString(36).slice(2, 10);

export default function Pos() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [payments, setPayments] = useState<Payment[]>([{ method: "cash", amount: "" }]);
  const [heldSaleId, setHeldSaleId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const products = useQuery({
    queryKey: ["products", search],
    queryFn: () => api.products(search || undefined),
    enabled: search.trim().length > 0,
  });
  const held = useQuery({ queryKey: ["held-sales"], queryFn: api.listHeldSales });

  const subtotal = useMemo(
    () => cart.reduce((s, l) => s + l.qty * l.price - l.discount, 0),
    [cart]
  );
  const paidTotal = useMemo(
    () => payments.reduce((s, p) => s + (Number(p.amount) || 0), 0),
    [payments]
  );

  const addProduct = (p: Product) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) {
        return prev.map((l) => (l.productId === p.id ? { ...l, qty: l.qty + 1 } : l));
      }
      return [
        ...prev,
        {
          id: uid(),
          productId: p.id,
          unitId: p.base_unit_id,
          name: p.name,
          qty: 1,
          price: Number(p.selling_price),
          discount: 0,
        },
      ];
    });
    setSearch("");
    searchRef.current?.focus();
  };

  const onSearchKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !search.trim()) return;
    e.preventDefault();
    const list = await api.products(search.trim());
    const exact = list.find((p) => p.barcode === search.trim());
    if (exact) addProduct(exact);
    else if (list.length === 1) addProduct(list[0]);
  };

  const setQty = (id: string, qty: number) =>
    setCart((prev) => prev.map((l) => (l.id === id ? { ...l, qty: Math.max(0.001, qty) } : l)));
  const setPrice = (id: string, price: number) =>
    setCart((prev) => prev.map((l) => (l.id === id ? { ...l, price: Math.max(0, price) } : l)));
  const removeLine = (id: string) => setCart((prev) => prev.filter((l) => l.id !== id));

  const resetCart = () => {
    setCart([]);
    setPayments([{ method: "cash", amount: "" }]);
    setHeldSaleId(null);
  };

  const toLines = () =>
    cart.map((l) => ({
      product_id: l.productId,
      unit_id: l.unitId,
      quantity: String(l.qty),
      unit_price: String(l.price),
      discount_amount: String(l.discount),
    }));

  const hold = useMutation({
    mutationFn: () => api.holdSale(null, toLines()),
    onSuccess: () => {
      resetCart();
      qc.invalidateQueries({ queryKey: ["held-sales"] });
      setStatus("Sale held.");
    },
  });

  const resume = (id: number) => setHeldSaleId(id);

  const checkout = useMutation({
    mutationFn: async () =>
      api.completeSale({
        held_sale_id: heldSaleId,
        customer_id: null,
        lines: toLines(),
        payments: payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: p.amount })),
        discount_total: String(cart.reduce((s, l) => s + l.discount, 0)),
      }),
    onSuccess: async (result) => {
      const bill: Bill = {
        billNumber: result.invoice_number ?? String(result.id),
        date: new Date(),
        items: cart,
      };
      setCheckingOut(true);
      try {
        await printBill(bill);
        setStatus(`Printed ${result.invoice_number}`);
      } catch (e) {
        setStatus(
          `Sale saved (${result.invoice_number}) but printing failed: ${e instanceof Error ? e.message : String(e)}`
        );
      } finally {
        setCheckingOut(false);
      }
      resetCart();
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
      qc.invalidateQueries({ queryKey: ["held-sales"] });
    },
    onError: (e) => setStatus(`Checkout failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const previewBill: Bill = {
    billNumber: heldSaleId ? `HELD-${heldSaleId}` : "—",
    date: new Date(),
    items: cart,
  };

  return (
    // "app"/"pane"/"preview" are print-layout hooks (receipt.css) — kept
    // alongside the Tailwind classes so printing a bill is unaffected by this
    // screen's visual restyle.
    <div className="app grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
      <div className="pane card p-6 space-y-5">
        <h1 className="text-lg font-semibold text-slate-800">{SHOP.name} — POS</h1>

        <div className="relative">
          <input
            ref={searchRef}
            className="field text-base py-3"
            placeholder="Scan a barcode or search by name / SKU…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
            autoFocus
          />
          {products.data && products.data.length > 0 && search.trim() && (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
              {products.data.slice(0, 8).map((p) => (
                <li
                  key={p.id}
                  onClick={() => addProduct(p)}
                  className="flex cursor-pointer items-center justify-between px-4 py-2.5 text-sm hover:bg-brand-50"
                >
                  <span className="text-slate-700">{p.name}</span>
                  <b className="text-slate-900">{money(Number(p.selling_price))}</b>
                </li>
              ))}
            </ul>
          )}
        </div>

        {held.data && held.data.length > 0 && (
          <details className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-brand-700">
              {held.data.length} held sale(s)
            </summary>
            <ul className="mt-2 space-y-1.5">
              {held.data.map((h) => (
                <li key={h.id} className="flex items-center justify-between">
                  <span className="text-slate-600">
                    #{h.id} · {h.line_count} item(s) · {h.subtotal}
                  </span>
                  <button type="button" className="btn-secondary !py-1 !px-2.5 text-xs" onClick={() => resume(h.id)}>
                    Select
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {cart.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-slate-400">No items yet.</li>
          )}
          {cart.map((l) => (
            <li key={l.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex-1 text-sm text-slate-700">{l.name}</span>
              <input
                className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-right text-sm"
                type="number"
                min="0.001"
                step="0.001"
                value={l.qty}
                onChange={(e) => setQty(l.id, Number(e.target.value))}
              />
              <input
                className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-sm"
                type="number"
                min="0"
                step="0.01"
                value={l.price}
                onChange={(e) => setPrice(l.id, Number(e.target.value))}
              />
              <span className="w-20 text-right text-sm font-medium text-slate-800">
                {money(l.qty * l.price - l.discount)}
              </span>
              <button
                type="button"
                onClick={() => removeLine(l.id)}
                aria-label="Remove"
                className="text-slate-400 hover:text-amber-500 transition-colors"
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center justify-between rounded-xl bg-slate-900 px-5 py-4 text-white">
          <span className="text-sm font-medium tracking-wide text-slate-300">TOTAL</span>
          <span className="text-xl font-semibold">
            {SHOP.currency} {money(subtotal)}
          </span>
        </div>

        <div>
          <h3 className="label mb-2">Payment</h3>
          <div className="space-y-2">
            {payments.map((p, i) => (
              <div className="grid grid-cols-2 gap-2" key={i}>
                <select
                  className="field"
                  value={p.method}
                  onChange={(e) =>
                    setPayments((prev) => prev.map((x, j) => (j === i ? { ...x, method: e.target.value } : x)))
                  }
                >
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="credit">Credit</option>
                </select>
                <input
                  className="field"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Amount"
                  value={p.amount}
                  onChange={(e) =>
                    setPayments((prev) => prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                  }
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            className="btn-secondary !py-1.5 !px-3 text-xs mt-2"
            onClick={() => setPayments((prev) => [...prev, { method: "cash", amount: "" }])}
          >
            + Split payment
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Paid: {money(paidTotal)}
            {paidTotal < subtotal && (
              <span className="text-amber-600"> · Remaining (credit): {money(subtotal - paidTotal)}</span>
            )}
          </p>
        </div>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={!cart.length || checkout.isPending || checkingOut}
            onClick={() => checkout.mutate()}
          >
            {checkout.isPending || checkingOut ? "Processing…" : "Complete Sale"}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={!cart.length || hold.isPending}
            onClick={() => hold.mutate()}
          >
            Hold
          </button>
          <button type="button" className="btn-secondary" onClick={resetCart}>
            Cancel
          </button>
        </div>

        {status && (
          <p className={`text-sm ${status.startsWith("Checkout failed") ? "text-amber-600" : "text-slate-500"}`}>
            {status}
          </p>
        )}
      </div>

      {/* No extra wrapper chrome here: printing shows only what "preview" contains
          (receipt.css), so anything added around Receipt would print too. */}
      <div className="preview flex justify-center">
        <Receipt bill={previewBill} />
      </div>
    </div>
  );
}
