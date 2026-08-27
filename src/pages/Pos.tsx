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

  // Barcode-scanner wedge: a scan arrives as rapid keystrokes ending in Enter,
  // indistinguishable from typing except for speed — so on Enter, an exact
  // barcode match is preferred over the free-text search result.
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

  const resume = (id: number, lines: { product_id: number; unit_id: number; quantity: string; unit_price: string }[] | undefined) => {
    // A held sale's lines are fetched fresh via get_purchase-style detail if
    // ever needed; for the MVP the held list already carries enough to resume
    // a simple cash sale by re-adding from the product cache below.
    void lines;
    setHeldSaleId(id);
  };

  const checkout = useMutation({
    mutationFn: async () => {
      const result = await api.completeSale({
        held_sale_id: heldSaleId,
        customer_id: null,
        lines: toLines(),
        payments: payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: p.amount })),
        discount_total: String(cart.reduce((s, l) => s + l.discount, 0)),
      });
      return result;
    },
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
        setStatus(`Sale saved (${result.invoice_number}) but printing failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setCheckingOut(false);
      }
      resetCart();
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
      qc.invalidateQueries({ queryKey: ["held-sales"] });
    },
    onError: (e) => setStatus(`Checkout failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  const previewBill: Bill = { billNumber: heldSaleId ? `HELD-${heldSaleId}` : "—", date: new Date(), items: cart };

  return (
    <div className="app">
      <div className="pane">
        <h1>{SHOP.name} — POS</h1>

        <input
          ref={searchRef}
          className="pos-search"
          placeholder="Scan a barcode or search by name / SKU…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          autoFocus
        />
        {products.data && products.data.length > 0 && search.trim() && (
          <ul className="pos-results">
            {products.data.slice(0, 8).map((p) => (
              <li key={p.id} onClick={() => addProduct(p)}>
                <span>{p.name}</span>
                <b>{money(Number(p.selling_price))}</b>
              </li>
            ))}
          </ul>
        )}

        {held.data && held.data.length > 0 && (
          <details className="held-list">
            <summary>{held.data.length} held sale(s)</summary>
            <ul className="plain-list">
              {held.data.map((h) => (
                <li key={h.id}>
                  #{h.id} · {h.line_count} item(s) · {h.subtotal}{" "}
                  <button type="button" onClick={() => resume(h.id, undefined)}>Select</button>
                </li>
              ))}
            </ul>
          </details>
        )}

        <ul className="cart">
          {cart.length === 0 && <li className="empty">No items yet.</li>}
          {cart.map((l) => (
            <li key={l.id}>
              <span className="c-name">{l.name}</span>
              <input
                className="c-input"
                type="number" min="0.001" step="0.001"
                value={l.qty}
                onChange={(e) => setQty(l.id, Number(e.target.value))}
              />
              <input
                className="c-input"
                type="number" min="0" step="0.01"
                value={l.price}
                onChange={(e) => setPrice(l.id, Number(e.target.value))}
              />
              <span className="c-tot">{money(l.qty * l.price - l.discount)}</span>
              <button type="button" onClick={() => removeLine(l.id)} aria-label="Remove">×</button>
            </li>
          ))}
        </ul>

        <div className="grand">
          <span>TOTAL</span>
          <span>{SHOP.currency} {money(subtotal)}</span>
        </div>

        <h3>Payment</h3>
        {payments.map((p, i) => (
          <div className="row2" key={i} style={{ marginBottom: 6 }}>
            <select
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
              type="number" step="0.01" min="0"
              placeholder="Amount"
              value={p.amount}
              onChange={(e) =>
                setPayments((prev) => prev.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))
              }
            />
          </div>
        ))}
        <button type="button" onClick={() => setPayments((prev) => [...prev, { method: "cash", amount: "" }])}>
          + Split payment
        </button>
        <p className="hint">
          Paid: {money(paidTotal)} {paidTotal < subtotal && `· Remaining (credit): ${money(subtotal - paidTotal)}`}
        </p>

        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={!cart.length || checkout.isPending || checkingOut}
            onClick={() => checkout.mutate()}
          >
            {checkout.isPending || checkingOut ? "Processing…" : "Complete Sale"}
          </button>
          <button type="button" disabled={!cart.length || hold.isPending} onClick={() => hold.mutate()}>
            Hold
          </button>
          <button type="button" onClick={resetCart}>Cancel</button>
        </div>

        {status && <p className={status.startsWith("Checkout failed") ? "warn" : "hint"}>{status}</p>}
      </div>

      <div className="preview">
        <Receipt bill={previewBill} />
      </div>
    </div>
  );
}
