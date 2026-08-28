import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api, DiscountIn, Product } from "../api";
import Receipt from "../components/Receipt";
import DiscountControl from "../components/DiscountControl";
import { printBill } from "../printer";
import { SHOP } from "../shop";
import {
  Bill,
  Discount,
  Item,
  billDiscountAmount,
  discountTotal,
  grandTotal,
  lineDiscount,
  lineTotal,
  lkr,
  money,
  subtotal as grossSubtotal,
} from "../types";

type CartLine = Item & { productId: number; unitId: number };
type Payment = { method: string; amount: string };

/** The wire form of a discount: kind plus the raw typed value, never an amount. */
const toDiscountIn = (d?: Discount): DiscountIn | null =>
  d ? { kind: d.kind, value: String(d.value) } : null;

const uid = () => Math.random().toString(36).slice(2, 10);

// A small fixed palette cycled by category, purely a visual grouping cue (the
// reference layout uses a colored accent bar per category card) — not tied to
// any stored data, so it stays stable across renders via the category's own
// position in the sorted list rather than a hash.
const CATEGORY_COLORS = [
  "border-l-brand-500",
  "border-l-sky-400",
  "border-l-amber-400",
  "border-l-emerald-400",
  "border-l-violet-400",
  "border-l-pink-400",
  "border-l-teal-400",
];

export default function Pos() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [billDiscount, setBillDiscount] = useState<Discount | undefined>();
  const [editingDiscount, setEditingDiscount] = useState<string | null>(null);
  const [payments, setPayments] = useState<Payment[]>([{ method: "cash", amount: "" }]);
  const [heldSaleId, setHeldSaleId] = useState<number | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [status, setStatus] = useState("");
  const [checkingOut, setCheckingOut] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const allProducts = useQuery({ queryKey: ["products", ""], queryFn: () => api.products() });
  const stock = useQuery({ queryKey: ["stock-levels", false], queryFn: () => api.stockLevels(false) });
  const held = useQuery({ queryKey: ["held-sales"], queryFn: api.listHeldSales });

  const onHandByProduct = useMemo(() => {
    const m = new Map<number, number>();
    stock.data?.forEach((s) => m.set(s.product_id, Number(s.on_hand)));
    return m;
  }, [stock.data]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    allProducts.data?.forEach((p) => set.add(p.category_name ?? "Other"));
    return Array.from(set).sort();
  }, [allProducts.data]);

  const categoryColor = (name: string) => CATEGORY_COLORS[categories.indexOf(name) % CATEGORY_COLORS.length];

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (allProducts.data ?? []).filter((p) => {
      const cat = p.category_name ?? "Other";
      if (activeCategory && cat !== activeCategory) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q) || p.barcode === search.trim();
    });
  }, [allProducts.data, activeCategory, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, Product[]>();
    for (const p of visible) {
      const cat = p.category_name ?? "Other";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(p);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  const subtotal = useMemo(() => grossSubtotal(cart), [cart]);
  const savings = useMemo(() => discountTotal(cart, billDiscount), [cart, billDiscount]);
  const billOff = useMemo(() => billDiscountAmount(cart, billDiscount), [cart, billDiscount]);
  const toPay = useMemo(() => grandTotal(cart, billDiscount), [cart, billDiscount]);
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
        },
      ];
    });
  };

  // Barcode-scanner wedge: a scan arrives as rapid keystrokes ending in Enter.
  // Matched against the already-loaded product list rather than a fresh query,
  // since the grid keeps the full catalogue in memory anyway.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !search.trim()) return;
    e.preventDefault();
    const q = search.trim();
    const list = allProducts.data ?? [];
    const exact = list.find((p) => p.barcode === q);
    if (exact) {
      addProduct(exact);
      setSearch("");
    } else if (visible.length === 1) {
      addProduct(visible[0]);
      setSearch("");
    }
  };

  const setQty = (id: string, qty: number) =>
    setCart((prev) =>
      qty <= 0 ? prev.filter((l) => l.id !== id) : prev.map((l) => (l.id === id ? { ...l, qty } : l))
    );
  const removeLine = (id: string) => setCart((prev) => prev.filter((l) => l.id !== id));
  const setLineDiscount = (id: string, discount?: Discount) =>
    setCart((prev) => prev.map((l) => (l.id === id ? { ...l, discount } : l)));

  const resetCart = () => {
    setCart([]);
    setBillDiscount(undefined);
    setEditingDiscount(null);
    setPayments([{ method: "cash", amount: "" }]);
    setHeldSaleId(null);
    setShowPayment(false);
  };

  const toLines = () =>
    cart.map((l) => ({
      product_id: l.productId,
      unit_id: l.unitId,
      quantity: String(l.qty),
      unit_price: String(l.price),
      discount: toDiscountIn(l.discount),
    }));

  const hold = useMutation({
    mutationFn: () => api.holdSale(null, toLines(), toDiscountIn(billDiscount)),
    onSuccess: () => {
      resetCart();
      qc.invalidateQueries({ queryKey: ["held-sales"] });
      setStatus("Sale held.");
    },
  });

  const checkout = useMutation({
    mutationFn: async () =>
      api.completeSale({
        held_sale_id: heldSaleId,
        customer_id: null,
        lines: toLines(),
        payments: payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: p.amount })),
        bill_discount: toDiscountIn(billDiscount),
      }),
    onSuccess: async (result) => {
      const bill: Bill = {
        billNumber: result.invoice_number ?? String(result.id),
        date: new Date(),
        items: cart,
        billDiscount,
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
    billDiscount,
  };

  return (
    // "app"/"pane"/"preview" are print-layout hooks (receipt.css): the receipt
    // is rendered off-screen ("hidden") and only becomes visible ("print:block")
    // inside the print media query, so nothing here shows a bill preview, but
    // the browser print-dialog fallback (dev-mode outside the desktop shell)
    // still has a receipt to print.
    <div className="app">
      <div className="pane grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5 items-start">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-slate-800">New Sale</h1>
            <p className="text-sm text-slate-500">{SHOP.name}</p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => setShowHeld((v) => !v)}>
            Held sales{held.data && held.data.length > 0 ? ` (${held.data.length})` : ""}
          </button>
        </div>

        {showHeld && (
          <div className="card p-4">
            {held.data && held.data.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {held.data.map((h) => (
                  <li key={h.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-slate-600">
                      #{h.id} · {h.line_count} item(s) · {lkr(Number(h.subtotal))}
                    </span>
                    <button
                      type="button"
                      className="btn-secondary !py-1 !px-2.5 text-xs"
                      onClick={() => {
                        setHeldSaleId(h.id);
                        setShowHeld(false);
                      }}
                    >
                      Resume
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No held sales.</p>
            )}
          </div>
        )}

        <input
          ref={searchRef}
          className="field py-3"
          placeholder="Scan a barcode or search by name / SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          autoFocus
        />

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveCategory(null)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              activeCategory === null ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
            }`}
          >
            All products
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setActiveCategory(c)}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                activeCategory === c ? "bg-slate-900 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="space-y-6">
          {grouped.map(([cat, items]) => (
            <div key={cat}>
              <h2 className="mb-2.5 text-sm font-semibold text-slate-700">{cat}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {items.map((p) => {
                  const onHand = onHandByProduct.get(p.id);
                  const outOfStock = onHand !== undefined && onHand <= 0;
                  const inCart = cart.find((l) => l.productId === p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      disabled={outOfStock}
                      onClick={() => addProduct(p)}
                      className={`relative overflow-hidden rounded-xl border-l-4 bg-white p-3.5 text-left shadow-sm transition-transform
                        ${categoryColor(cat)}
                        ${outOfStock ? "opacity-50 cursor-not-allowed" : "hover:-translate-y-0.5 hover:shadow-card"}`}
                    >
                      {inCart && (
                        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-[11px] font-semibold text-white">
                          {inCart.qty}
                        </span>
                      )}
                      <p className="text-sm font-medium text-slate-800 leading-snug line-clamp-2">{p.name}</p>
                      <div className="mt-1.5 flex items-baseline justify-between">
                        <span className="text-sm font-semibold text-slate-900">{lkr(Number(p.selling_price))}</span>
                        <span className="text-xs text-slate-400">
                          {outOfStock ? "Out of stock" : onHand !== undefined ? `${onHand} ${p.base_unit_code}` : ""}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {grouped.length === 0 && (
            <p className="py-10 text-center text-sm text-slate-400">No products match.</p>
          )}
        </div>
      </div>

      <div className="sticky top-20 flex flex-col rounded-2xl bg-slate-900 text-white shadow-card">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-sm font-semibold text-slate-200">Order ({cart.length})</h2>
          {cart.length > 0 && (
            <button type="button" className="text-xs text-slate-400 hover:text-white" onClick={resetCart}>
              Clear
            </button>
          )}
        </div>

        <div className="max-h-[42vh] overflow-y-auto px-5 py-3 space-y-2">
          {cart.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No items yet.</p>}
          {cart.map((l) => {
            const off = lineDiscount(l);
            return (
              <div key={l.id} className="rounded-xl bg-slate-800/70 p-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-1 shrink-0 rounded-full bg-brand-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-slate-100">{l.name}</p>
                    <p className="text-xs text-slate-400">{lkr(l.price)} each</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setQty(l.id, l.qty - 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-700 text-slate-200 hover:bg-slate-600"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm">{l.qty}</span>
                    <button
                      type="button"
                      onClick={() => setQty(l.id, l.qty + 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-700 text-slate-200 hover:bg-slate-600"
                    >
                      +
                    </button>
                  </div>
                  <div className="w-20 text-right">
                    {off > 0 && (
                      <div className="text-[11px] text-slate-500 line-through">{money(l.qty * l.price)}</div>
                    )}
                    <span className="text-sm font-semibold">{money(lineTotal(l))}</span>
                  </div>
                  <button type="button" onClick={() => removeLine(l.id)} className="text-slate-500 hover:text-amber-400">
                    ×
                  </button>
                </div>

                <div className="mt-2 pl-4">
                  {editingDiscount === l.id || l.discount ? (
                    <DiscountControl
                      value={l.discount}
                      base={l.qty * l.price}
                      autoFocus={editingDiscount === l.id}
                      label="Line discount"
                      onChange={(d) => setLineDiscount(l.id, d)}
                      onDone={() => setEditingDiscount(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      className="text-[11px] text-slate-400 underline-offset-2 hover:text-white hover:underline"
                      onClick={() => setEditingDiscount(l.id)}
                    >
                      + Discount this item
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5 border-t border-slate-800 px-5 py-4 text-sm">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span>{lkr(subtotal)}</span>
          </div>

          {savings > 0 && (
            <div className="flex justify-between text-emerald-400">
              <span>Discount</span>
              <span>−{lkr(savings)}</span>
            </div>
          )}

          <div className="pt-1">
            {billDiscount ? (
              <DiscountControl
                value={billDiscount}
                base={subtotal - (savings - billOff)}
                label="Bill discount"
                onChange={setBillDiscount}
              />
            ) : (
              <button
                type="button"
                className="text-xs text-slate-400 underline-offset-2 hover:text-white hover:underline disabled:opacity-40 disabled:no-underline"
                disabled={!cart.length}
                onClick={() => setBillDiscount({ kind: "percent", value: 0 })}
              >
                + Discount the whole bill
              </button>
            )}
          </div>

          {showPayment && (
            <div className="flex justify-between text-slate-400">
              <span>Paid</span>
              <span>
                {lkr(paidTotal)}
                {paidTotal < toPay && <span className="text-amber-400"> · credit {lkr(toPay - paidTotal)}</span>}
              </span>
            </div>
          )}
        </div>

        {showPayment && (
          <div className="space-y-2 border-t border-slate-800 px-5 py-4">
            {payments.map((p, i) => (
              <div className="grid grid-cols-2 gap-2" key={i}>
                <select
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-sm text-slate-100"
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
                  className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-sm text-slate-100 placeholder:text-slate-500"
                  type="number" step="0.01" min="0"
                  placeholder="Amount"
                  value={p.amount}
                  onChange={(e) =>
                    setPayments((prev) => prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
                  }
                />
              </div>
            ))}
            <button
              type="button"
              className="text-xs text-slate-400 hover:text-white"
              onClick={() => setPayments((prev) => [...prev, { method: "cash", amount: "" }])}
            >
              + Split payment
            </button>
          </div>
        )}

        <div className="flex items-center justify-between border-t border-slate-800 px-5 py-4">
          <span className="text-sm font-medium text-slate-300">To pay</span>
          <span className="text-xl font-semibold">{lkr(toPay)}</span>
        </div>

        {status && (
          <p className={`px-5 pb-2 text-xs ${status.startsWith("Checkout failed") ? "text-amber-400" : "text-slate-400"}`}>
            {status}
          </p>
        )}

        <div className="flex gap-2 px-5 pb-5">
          <button
            type="button"
            className="rounded-xl bg-slate-800 px-3.5 py-3 text-sm font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            disabled={!cart.length || hold.isPending}
            onClick={() => hold.mutate()}
          >
            Hold
          </button>
          {!showPayment ? (
            <button
              type="button"
              className="btn-primary flex-1 py-3"
              disabled={!cart.length}
              onClick={() => setShowPayment(true)}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary flex-1 py-3"
              disabled={!cart.length || checkout.isPending || checkingOut}
              onClick={() => checkout.mutate()}
            >
              {checkout.isPending || checkingOut ? "Processing…" : "Complete Sale"}
            </button>
          )}
        </div>
      </div>

      </div>

      <div className="preview hidden print:block">
        <Receipt bill={previewBill} />
      </div>
    </div>
  );
}
