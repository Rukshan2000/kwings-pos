import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { api, DiscountIn, Product, ProductDetail } from "../api";
import Receipt from "../components/Receipt";
import DiscountControl from "../components/DiscountControl";
import PaymentDialog, { Payment } from "../components/PaymentDialog";
import LineDialog from "../components/LineDialog";
import { SellableUnit, TierKind, pricedByTier, sellableUnits, unitPrice } from "../pricing";
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

type CartLine = Item & {
  productId: number;
  unitId: number;
  /** The product's units and tiers, kept on the line so re-pricing after a
      quantity or unit change needs no round trip. */
  detail: ProductDetail;
  units: SellableUnit[];
};

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
  const [confirmDiscard, setConfirmDiscard] = useState<number | null>(null);
  // Retail or wholesale for the whole bill: a customer is one or the other, and
  // setting it per line would be a tap on every item.
  const [tierKind, setTierKind] = useState<TierKind>("retail");
  // Which cart line's options dialog is open, if any.
  const [lineOptions, setLineOptions] = useState<string | null>(null);
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

  // One flat grid, still ordered by category so a category's products stay
  // together and its colour band reads as a group. The headings are gone: the
  // filter buttons above already say which category you are looking at, and a
  // heading per group costs a row of products every time.
  const ordered = useMemo(
    () =>
      [...visible].sort((a, b) => {
        const cat = (a.category_name ?? "Other").localeCompare(b.category_name ?? "Other");
        return cat !== 0 ? cat : a.name.localeCompare(b.name);
      }),
    [visible]
  );

  // Bags and the like. Ordered by the shop's own sort_order so Small/Medium/
  // Large read in that order rather than alphabetically, which would lead with
  // Large.
  const quickAdds = useMemo(
    () =>
      (allProducts.data ?? [])
        .filter((p) => p.quick_add)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [allProducts.data]
  );

  const subtotal = useMemo(() => grossSubtotal(cart), [cart]);
  const savings = useMemo(() => discountTotal(cart, billDiscount), [cart, billDiscount]);
  const billOff = useMemo(() => billDiscountAmount(cart, billDiscount), [cart, billDiscount]);
  const toPay = useMemo(() => grandTotal(cart, billDiscount), [cart, billDiscount]);

  /// Re-prices a line from its own tiers. Called on every quantity or unit
  /// change, because a quantity break that stops applying has to stop applying.
  const repriced = (line: CartLine, qty: number, unit: SellableUnit, kind: TierKind): CartLine => ({
    ...line,
    qty,
    unitId: unit.unitId,
    price: unitPrice(line.detail, unit, qty, kind),
  });

  const addProduct = async (p: Product) => {
    const existing = cart.find((l) => l.productId === p.id);
    if (existing) {
      const unit = existing.units.find((u) => u.unitId === existing.unitId) ?? existing.units[0];
      setCart((prev) =>
        prev.map((l) => (l.id === existing.id ? repriced(l, l.qty + 1, unit, tierKind) : l))
      );
      return;
    }

    // The grid's product rows carry no units or tiers, so the first add of a
    // product fetches them. Cached by react-query, so a second add of the same
    // product does not hit the database again.
    const detail = await qc.fetchQuery({
      queryKey: ["product", p.id],
      queryFn: () => api.product(p.id),
    });
    const units = sellableUnits(detail);

    setCart((prev) => [
      ...prev,
      {
        id: uid(),
        productId: p.id,
        unitId: units[0].unitId,
        name: p.name,
        qty: 1,
        price: unitPrice(detail, units[0], 1, tierKind),
        detail,
        units,
      },
    ]);
  };

  // Barcode-scanner wedge: a scan arrives as rapid keystrokes ending in Enter.
  // Matched against the already-loaded product list rather than a fresh query,
  // since the grid keeps the full catalogue in memory anyway.
  const add = (p: Product) => {
    addProduct(p).catch((e) =>
      setStatus(`Could not add ${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    );
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || !search.trim()) return;
    e.preventDefault();
    const q = search.trim();
    const list = allProducts.data ?? [];
    const exact = list.find((p) => p.barcode === q);
    if (exact) {
      add(exact);
      setSearch("");
    } else if (visible.length === 1) {
      add(visible[0]);
      setSearch("");
    }
  };

  const setQty = (id: string, qty: number) =>
    setCart((prev) =>
      qty <= 0
        ? prev.filter((l) => l.id !== id)
        : prev.map((l) =>
            l.id === id
              ? repriced(l, qty, l.units.find((u) => u.unitId === l.unitId) ?? l.units[0], tierKind)
              : l
          )
    );

  const setLineUnit = (id: string, unitId: number) =>
    setCart((prev) =>
      prev.map((l) =>
        l.id === id ? repriced(l, l.qty, l.units.find((u) => u.unitId === unitId) ?? l.units[0], tierKind) : l
      )
    );
  const removeLine = (id: string) => setCart((prev) => prev.filter((l) => l.id !== id));
  const setLineDiscount = (id: string, discount?: Discount) =>
    setCart((prev) => prev.map((l) => (l.id === id ? { ...l, discount } : l)));

  const resetCart = () => {
    setCart([]);
    setBillDiscount(undefined);
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
    mutationFn: () => api.holdSale(null, toLines(), toDiscountIn(billDiscount), heldSaleId),
    onSuccess: () => {
      resetCart();
      qc.invalidateQueries({ queryKey: ["held-sales"] });
      setStatus("Sale held.");
    },
  });

  // Resuming has to rebuild the cart, not just remember the id: without this the
  // button set `heldSaleId` against an empty cart, so nothing appeared on screen
  // and "Complete Sale" stayed disabled.
  const resume = useMutation({
    mutationFn: async (id: number) => {
      const sale = await api.heldSale(id);
      // A resumed line needs its product's units and tiers the same way a
      // freshly added one does, or changing its quantity could not re-price it.
      const lines = await Promise.all(
        sale.lines.map(async (l) => ({
          line: l,
          detail: await qc.fetchQuery({
            queryKey: ["product", l.product_id],
            queryFn: () => api.product(l.product_id),
          }),
        }))
      );
      return { sale, lines };
    },
    onSuccess: ({ sale, lines }) => {
      setCart(
        lines.map(({ line: l, detail }) => ({
          id: uid(),
          productId: l.product_id,
          unitId: l.unit_id,
          name: l.name,
          qty: Number(l.quantity),
          // The held price, not a re-derived one: whatever it was sold at when
          // the cart was parked is what the customer was quoted.
          price: Number(l.unit_price),
          detail,
          units: sellableUnits(detail),
          discount:
            l.discount_kind && l.discount_value !== null
              ? { kind: l.discount_kind, value: Number(l.discount_value) }
              : undefined,
        }))
      );
      setBillDiscount(
        sale.bill_discount
          ? { kind: sale.bill_discount.kind, value: Number(sale.bill_discount.value) }
          : undefined
      );
      setHeldSaleId(sale.id);
      setPayments([{ method: "cash", amount: "" }]);
      setShowPayment(false);
      setShowHeld(false);
      setStatus(`Resumed held sale #${sale.id}.`);
    },
    onError: (e) => setStatus(`Could not resume: ${e instanceof Error ? e.message : String(e)}`),
  });

  // Discarding is deliberately two clicks: a held cart is someone's parked
  // shopping, and there is no undo once its lines are gone.
  const discard = useMutation({
    mutationFn: (id: number) => api.cancelHeldSale(id),
    onSuccess: (_r, id) => {
      setConfirmDiscard(null);
      // If the cart on screen came from this sale, it no longer has a home to
      // go back to — clear it rather than leave it pointing at a cancelled id.
      if (heldSaleId === id) resetCart();
      qc.invalidateQueries({ queryKey: ["held-sales"] });
      setStatus(`Discarded held sale #${id}.`);
    },
    onError: (e) => setStatus(`Could not discard: ${e instanceof Error ? e.message : String(e)}`),
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
                    <span className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className="btn-secondary !py-1 !px-2.5 text-xs disabled:opacity-40"
                        disabled={resume.isPending}
                        onClick={() => resume.mutate(h.id)}
                      >
                        {resume.isPending && resume.variables === h.id ? "Loading…" : "Resume"}
                      </button>
                      {confirmDiscard === h.id ? (
                        <>
                          <button
                            type="button"
                            className="rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-40"
                            disabled={discard.isPending}
                            onClick={() => discard.mutate(h.id)}
                          >
                            {discard.isPending ? "Discarding…" : "Confirm"}
                          </button>
                          <button
                            type="button"
                            className="px-1.5 text-xs text-slate-400 hover:text-slate-600"
                            onClick={() => setConfirmDiscard(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="px-1.5 text-xs text-slate-400 hover:text-amber-600"
                          onClick={() => setConfirmDiscard(h.id)}
                          aria-label={`Discard held sale ${h.id}`}
                        >
                          Discard
                        </button>
                      )}
                    </span>
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

        {/* Dense on purpose: fitting more products on screen saves more taps
            than a larger button does. The card earns its visibility from
            contrast — the category band, a ring when in the cart, amber when
            out of stock — rather than from size. */}
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6 gap-2">
          {ordered.map((p) => {
            // The coloured band is the only category cue left now that
            // the headings are gone.
            const cat = p.category_name ?? "Other";
            const onHand = onHandByProduct.get(p.id);
            const outOfStock = onHand !== undefined && onHand <= 0;
            const inCart = cart.find((l) => l.productId === p.id);
            return (
              <button
                key={p.id}
                type="button"
                disabled={outOfStock}
                onClick={() => add(p)}
                className={`relative flex flex-col overflow-hidden rounded-lg border border-l-4 bg-white p-2 text-left transition-all duration-150
                  ${categoryColor(cat)}
                  ${
                    outOfStock
                      ? "border-slate-200 opacity-60 cursor-not-allowed"
                      : inCart
                        ? "border-brand-300 shadow-card ring-1 ring-brand-200"
                        : "border-slate-200 shadow-sm hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-card"
                  }`}
              >
                {inCart && (
                  <span className="absolute right-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold text-white">
                    {inCart.qty}
                  </span>
                )}

                {/* Two lines of name, then price and stock share the last
                    line — the whole card is three lines tall. */}
                <p className="min-h-[2rem] pr-4 text-xs font-medium leading-tight text-slate-800 line-clamp-2">
                  {p.name}
                </p>

                <div className="mt-1 flex items-baseline justify-between gap-1">
                  <span className="text-sm font-bold leading-none text-slate-900">
                    {lkr(Number(p.selling_price))}
                  </span>
                  {onHand !== undefined && (
                    <span
                      className={`shrink-0 rounded px-1 text-[10px] font-medium leading-4 ${
                        outOfStock ? "bg-amber-50 text-amber-700" : "text-slate-400"
                      }`}
                    >
                      {outOfStock ? "None" : `${onHand} ${p.base_unit_code}`}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {ordered.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">No products match.</p>
        )}
      </div>

      {/* Full height so the order stays one column from header to buttons: the
          card is pinned below the nav and the item list is the only part that
          scrolls, which keeps the totals and Complete Sale always in view. */}
      <div className="card flex flex-col overflow-hidden xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)]">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-sm font-semibold text-slate-700">Order ({cart.length})</h2>
          <div className="flex items-center gap-2">
            {/* One switch for the bill: a customer is retail or wholesale, and
                setting it per line would be a tap on every item. Flipping it
                re-prices everything already in the cart. */}
            <div className="flex overflow-hidden rounded-lg border border-slate-200">
              {(["retail", "wholesale"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setTierKind(k);
                    setCart((prev) =>
                      prev.map((l) =>
                        repriced(l, l.qty, l.units.find((u) => u.unitId === l.unitId) ?? l.units[0], k)
                      )
                    );
                  }}
                  className={`px-2 py-1 text-[11px] font-medium capitalize transition-colors ${
                    tierKind === k ? "bg-brand-600 text-white" : "bg-white text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
            {cart.length > 0 && (
              <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={resetCart}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {cart.length === 0 && <p className="py-8 text-center text-sm text-slate-400">No items yet.</p>}
          {cart.map((l) => {
            const off = lineDiscount(l);
            return (
              <div key={l.id} className="rounded-xl border border-slate-200/80 bg-slate-50 p-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-1 shrink-0 rounded-full bg-brand-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{l.name}</p>
                    <p className="text-xs text-slate-500">
                      {lkr(l.price)} per {l.units.find((u) => u.unitId === l.unitId)?.code}
                      {pricedByTier(
                        l.detail,
                        l.units.find((u) => u.unitId === l.unitId) ?? l.units[0],
                        l.qty,
                        tierKind
                      ) && <span className="ml-1 text-brand-600">· {tierKind} price</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setQty(l.id, l.qty - 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-sm text-slate-800">{l.qty}</span>
                    <button
                      type="button"
                      onClick={() => setQty(l.id, l.qty + 1)}
                      className="flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                    >
                      +
                    </button>
                  </div>
                  <div className="w-20 text-right">
                    {off > 0 && (
                      <div className="text-[11px] text-slate-400 line-through">{money(l.qty * l.price)}</div>
                    )}
                    <span className="text-sm font-semibold text-slate-900">{money(lineTotal(l))}</span>
                  </div>
                  <button type="button" onClick={() => removeLine(l.id)} className="text-slate-400 hover:text-amber-600">
                    ×
                  </button>
                </div>

                {/* Both open the same dialog. Neither control belongs in a
                    380px line beside a name, a stepper and a total. */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
                  {l.units.length > 1 && (
                    <button
                      type="button"
                      className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
                      onClick={() => setLineOptions(l.id)}
                    >
                      {l.units.find((u) => u.unitId === l.unitId)?.code} ▾
                    </button>
                  )}
                  <button
                    type="button"
                    className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
                      off > 0
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                    }`}
                    onClick={() => setLineOptions(l.id)}
                  >
                    {off > 0 ? `−${money(off)}` : "+ Discount"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5 border-t border-slate-200 px-5 py-4 text-sm">
          <div className="flex justify-between text-slate-500">
            <span>Subtotal</span>
            <span>{lkr(subtotal)}</span>
          </div>

          {savings > 0 && (
            <div className="flex justify-between text-emerald-600">
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
                className="text-xs text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline disabled:opacity-40 disabled:no-underline"
                disabled={!cart.length}
                onClick={() => setBillDiscount({ kind: "percent", value: 0 })}
              >
                + Discount the whole bill
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4">
          <span className="text-sm font-medium text-slate-600">To pay</span>
          <span className="text-xl font-semibold text-slate-900">{lkr(toPay)}</span>
        </div>

        {status && (
          <p className={`px-5 pb-2 text-xs ${status.startsWith("Checkout failed") ? "text-amber-600" : "text-slate-500"}`}>
            {status}
          </p>
        )}

        {quickAdds.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-5 pb-1">
            {quickAdds.map((p) => {
              const inCart = cart.find((l) => l.productId === p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => add(p)}
                  title={`${p.name} · ${lkr(Number(p.selling_price))}`}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    inCart
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  + {p.name}
                  {inCart && <span className="ml-1 font-semibold">×{inCart.qty}</span>}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex gap-2 px-5 pb-5 pt-2">
          <button
            type="button"
            className="rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            disabled={!cart.length || hold.isPending}
            onClick={() => hold.mutate()}
          >
            Hold
          </button>
          <button
            type="button"
            className="btn-primary flex-1 py-3"
            disabled={!cart.length || checkout.isPending || checkingOut}
            onClick={() => setShowPayment(true)}
          >
            {checkout.isPending || checkingOut ? "Processing…" : "Charge"}
          </button>
        </div>
      </div>

      </div>

      {(() => {
        const line = cart.find((l) => l.id === lineOptions);
        if (!line) return null;
        return (
          <LineDialog
            open
            productName={line.name}
            units={line.units}
            selected={line.unitId}
            priceFor={(u) => unitPrice(line.detail, u, line.qty, tierKind)}
            onPick={(unitId) => setLineUnit(line.id, unitId)}
            discount={line.discount}
            discountBase={line.qty * line.price}
            onDiscount={(d) => setLineDiscount(line.id, d)}
            onClose={() => setLineOptions(null)}
          />
        );
      })()}

      <PaymentDialog
        open={showPayment}
        total={toPay}
        payments={payments}
        onChange={setPayments}
        onClose={() => setShowPayment(false)}
        onConfirm={() => checkout.mutate()}
        pending={checkout.isPending || checkingOut}
      />

      <div className="preview hidden print:block">
        <Receipt bill={previewBill} />
      </div>
    </div>
  );
}
