import { useMemo, useState } from "react";
import Receipt from "./components/Receipt";
import { CATALOG, SHOP } from "./shop";
import { Bill, Item, money, subtotal } from "./types";

const newBillNumber = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999));
const uid = () => Math.random().toString(36).slice(2, 10);

export default function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [billNumber, setBillNumber] = useState(newBillNumber);
  const [date, setDate] = useState(() => new Date());

  const bill: Bill = useMemo(() => ({ billNumber, date, items }), [billNumber, date, items]);

  const add = (n: string, q: number, p: number) => {
    if (!n.trim() || q <= 0 || !isFinite(p)) return;
    setItems((prev) => [...prev, { id: uid(), name: n.trim(), qty: q, price: p }]);
  };

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    add(name, Number(qty), Number(price));
    setName("");
    setQty("1");
    setPrice("");
  };

  const remove = (id: string) => setItems((p) => p.filter((i) => i.id !== id));

  const newBill = () => {
    setItems([]);
    setBillNumber(newBillNumber());
    setDate(new Date());
  };

  const print = () => {
    setDate(new Date());
    // Let the re-render flush before the (blocking) print dialog opens.
    setTimeout(() => window.print(), 50);
  };

  return (
    <div className="app">
      <div className="pane">
        <h1>{SHOP.name} — POS</h1>

        <div className="quick">
          {CATALOG.map((c) => (
            <button key={c.name} type="button" onClick={() => add(c.name, 1, c.price)}>
              <span>{c.name}</span>
              <small>
                {SHOP.currency} {money(c.price)}
              </small>
            </button>
          ))}
        </div>

        <form className="form" onSubmit={onAdd}>
          <input
            placeholder="Item name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="number"
            min="1"
            step="1"
            placeholder="Qty"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          <input
            type="number"
            min="0"
            step="0.01"
            placeholder="Price"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>

        <ul className="cart">
          {items.length === 0 && <li className="empty">No items yet.</li>}
          {items.map((i) => (
            <li key={i.id}>
              <span className="c-name">{i.name}</span>
              <span className="c-qty">
                {i.qty} x {money(i.price)}
              </span>
              <span className="c-tot">{money(i.qty * i.price)}</span>
              <button type="button" onClick={() => remove(i.id)} aria-label="Remove">
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="grand">
          <span>TOTAL</span>
          <span>
            {SHOP.currency} {money(subtotal(items))}
          </span>
        </div>

        <div className="actions">
          <button type="button" className="primary" disabled={!items.length} onClick={print}>
            Print Bill
          </button>
          <button type="button" onClick={newBill}>
            New Bill
          </button>
        </div>
      </div>

      <div className="preview">
        <Receipt bill={bill} />
      </div>
    </div>
  );
}
