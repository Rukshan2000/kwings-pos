import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emitTo } from "@tauri-apps/api/event";
import { api, DiscountIn, Product, ProductDetail } from "../api";
import Receipt from "../components/Receipt";
import DiscountControl from "../components/DiscountControl";
import PaymentDialog, { Payment } from "../components/PaymentDialog";
import LineDialog from "../components/LineDialog";
import SearchableSelect from "../components/SearchableSelect";
import AddCustomerDialog from "../components/AddCustomerDialog";
import PricePickerDialog from "../components/PricePickerDialog";
import { CUSTOMER_DISPLAY_EVENT } from "./CustomerDisplay";
import { SellableUnit, TierKind, priceChoices, pricedByTier, sellableUnits, unitPrice } from "../pricing";
import { printBill } from "../printer";
import { getShopSettings, pick } from "../shop";
import {
  Bill,
  CustomerDisplayPayload,
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
  /** Set once the cashier has picked a price from more than one on offer — see
      `unitPrice`'s `manualBasePrice`. Absent for every ordinary product. */
  manualBasePrice?: number;
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
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const shop = getShopSettings();
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
  // A product fetched and waiting on the cashier to pick a price before it can
  // be added — set only when the product actually has more than one.
  const [pricePick, setPricePick] = useState<{
    product: Product;
    detail: ProductDetail;
    units: SellableUnit[];
  } | null>(null);
  const [payments, setPayments] = useState<Payment[]>([{ method: "cash", amount: "" }]);
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [showAddCustomer, setShowAddCustomer] = useState(false);
  const [heldSaleId, setHeldSaleId] = useState<number | null>(null);
  const [showHeld, setShowHeld] = useState(false);
  const [showPayment, setShowPayment] = useState(false);
  const [status, setStatus] = useState("");
  const [statusError, setStatusError] = useState(false);
  // Set right after a sale completes so the customer display can show a
  // "thank you" screen instead of snapping straight back to an empty cart;
  // cleared a few seconds later.
  const [thankYouInvoice, setThankYouInvoice] = useState<string | null>(null);
  const [printPrompt, setPrintPrompt] = useState<{ bill: Bill; invoice: string } | null>(null);
  const [printing, setPrinting] = useState(false);
  const [completedInvoice, setCompletedInvoice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const shopName = pick(shop.name, i18n.language as "en" | "si" | "ta");

  const allProducts = useQuery({ queryKey: ["products", ""], queryFn: () => api.products() });
  const stock = useQuery({ queryKey: ["stock-levels", false], queryFn: () => api.stockLevels(false) });
  const held = useQuery({ queryKey: ["held-sales"], queryFn: api.listHeldSales });
  const customers = useQuery({ queryKey: ["customers"], queryFn: api.customers });
  const selectedCustomer = customers.data?.find((c) => c.id === customerId) ?? null;

  const addCustomer = useMutation({
    mutationFn: ({ name, phone }: { name: string; phone: string | null }) => api.createCustomer(name, phone),
    onSuccess: (customer) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      setCustomerId(customer.id);
      setShowAddCustomer(false);
    },
  });

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

  // The shop's own color for a category, keyed off any product carrying it —
  // falls back to the fixed cycling palette when the category has none set.
  const categoryHexByName = useMemo(() => {
    const m = new Map<string, string>();
    allProducts.data?.forEach((p) => {
      const cat = p.category_name ?? "Other";
      if (p.category_color && !m.has(cat)) m.set(cat, p.category_color);
    });
    return m;
  }, [allProducts.data]);

  const categoryColorClass = (name: string) =>
    categoryHexByName.has(name) ? "" : CATEGORY_COLORS[categories.indexOf(name) % CATEGORY_COLORS.length];
  const categoryColorStyle = (name: string): CSSProperties | undefined => {
    const hex = categoryHexByName.get(name);
    return hex ? { borderLeftColor: hex } : undefined;
  };

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

  // Pushes the live cart to the customer-facing display window on every
  // change. `emitTo` is a no-op if that window isn't open, and throws outside
  // a Tauri context (e.g. the browser print-dialog dev fallback) — either way
  // there's nothing to do about it here.
  useEffect(() => {
    const payload: CustomerDisplayPayload = thankYouInvoice
      ? { items: [], shopName, completedInvoice: thankYouInvoice }
      : { items: cart, billDiscount, shopName };
    emitTo("customer", CUSTOMER_DISPLAY_EVENT, payload).catch(() => {});
  }, [cart, billDiscount, shopName, thankYouInvoice]);

  /// Re-prices a line from its own tiers, or its manually chosen price if it
  /// has one. Called on every quantity or unit change, because a quantity
  /// break that stops applying has to stop applying.
  const repriced = (line: CartLine, qty: number, unit: SellableUnit, kind: TierKind): CartLine => ({
    ...line,
    qty,
    unitId: unit.unitId,
    price: unitPrice(line.detail, unit, qty, kind, line.manualBasePrice),
  });

  const addLine = (p: Product, detail: ProductDetail, units: SellableUnit[], manualBasePrice?: number) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.productId === p.id);
      if (existing) {
        const unit = existing.units.find((u) => u.unitId === existing.unitId) ?? existing.units[0];
        return prev.map((l) => (l.id === existing.id ? repriced(l, l.qty + 1, unit, tierKind) : l));
      }
      return [
        ...prev,
        {
          id: uid(),
          productId: p.id,
          unitId: units[0].unitId,
          name: p.name,
          qty: 1,
          price: unitPrice(detail, units[0], 1, tierKind, manualBasePrice),
          detail,
          units,
          manualBasePrice,
        },
      ];
    });
  };

  const addProduct = async (p: Product) => {
    // Once it is already in the cart, tapping the tile again just bumps the
    // quantity at whatever price that line is already using — re-prompting on
    // every tap would make repeat items unusable.
    const existing = cart.find((l) => l.productId === p.id);
    if (existing) {
      addLine(p, existing.detail, existing.units, existing.manualBasePrice);
      return;
    }

    // The grid's product rows carry no units, tiers or price options, so the
    // first add of a product fetches them. Cached by react-query, so a second
    // add of the same product does not hit the database again.
    const detail = await qc.fetchQuery({
      queryKey: ["product", p.id],
      queryFn: () => api.product(p.id),
    });
    const units = sellableUnits(detail);
    const choices = priceChoices(detail);

    if (choices.length > 1) {
      setPricePick({ product: p, detail, units });
      return;
    }
    addLine(p, detail, units);
  };

  // Barcode-scanner wedge: a scan arrives as rapid keystrokes ending in Enter.
  // Matched against the already-loaded product list rather than a fresh query,
  // since the grid keeps the full catalogue in memory anyway.
  const add = (p: Product) => {
    addProduct(p).catch((e) => {
      setStatus(t("pos.couldNotAdd", { name: p.name, error: e instanceof Error ? e.message : String(e) }));
      setStatusError(true);
    });
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
    setCustomerId(null);
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
    mutationFn: () => api.holdSale(customerId, toLines(), toDiscountIn(billDiscount), heldSaleId),
    onSuccess: () => {
      resetCart();
      qc.invalidateQueries({ queryKey: ["held-sales"] });
      setStatus(t("pos.saleHeld"));
      setStatusError(false);
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
        lines.map(({ line: l, detail }) => {
          const unitPriceNum = Number(l.unit_price);
          // The held sale doesn't record which price option (if any) produced
          // this price, so infer it: if it doesn't match the tier-derived
          // price, it must have been a manually chosen option — otherwise a
          // later quantity/unit change would silently reprice off the tier.
          const units = sellableUnits(detail);
          const unit = units.find((u) => u.unitId === l.unit_id) ?? units[0];
          const tierPrice = unitPrice(detail, unit, Number(l.quantity), tierKind);
          const manualBasePrice = Math.abs(unitPriceNum - tierPrice) > 0.005 ? unitPriceNum : undefined;
          return {
            id: uid(),
            productId: l.product_id,
            unitId: l.unit_id,
            name: l.name,
            qty: Number(l.quantity),
            // The held price, not a re-derived one: whatever it was sold at when
            // the cart was parked is what the customer was quoted.
            price: unitPriceNum,
            detail,
            units,
            manualBasePrice,
            discount:
              l.discount_kind && l.discount_value !== null
                ? { kind: l.discount_kind, value: Number(l.discount_value) }
                : undefined,
          };
        })
      );
      setBillDiscount(
        sale.bill_discount
          ? { kind: sale.bill_discount.kind, value: Number(sale.bill_discount.value) }
          : undefined
      );
      setCustomerId(sale.customer_id ?? null);
      setHeldSaleId(sale.id);
      setPayments([{ method: "cash", amount: "" }]);
      setShowPayment(false);
      setShowHeld(false);
      setStatus(t("pos.resumedHeldSale", { id: sale.id }));
      setStatusError(false);
    },
    onError: (e) => {
      setStatus(t("pos.couldNotResume", { error: e instanceof Error ? e.message : String(e) }));
      setStatusError(true);
    },
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
      setStatus(t("pos.discardedHeldSale", { id }));
      setStatusError(false);
    },
    onError: (e) => {
      setStatus(t("pos.couldNotDiscard", { error: e instanceof Error ? e.message : String(e) }));
      setStatusError(true);
    },
  });

  const checkout = useMutation({
    mutationFn: async () =>
      api.completeSale({
        held_sale_id: heldSaleId,
        customer_id: customerId,
        lines: toLines(),
        payments: payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: p.amount })),
        bill_discount: toDiscountIn(billDiscount),
      }),
    onSuccess: async (result) => {
      const invoice = result.invoice_number ?? String(result.id);
      const bill: Bill = {
        billNumber: invoice,
        date: new Date(),
        items: cart,
        billDiscount,
      };
      setThankYouInvoice(invoice);
      setTimeout(() => setThankYouInvoice(null), 6000);
      setPrintPrompt({ bill, invoice });
      resetCart();
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
      qc.invalidateQueries({ queryKey: ["held-sales"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => {
      setStatus(t("pos.checkoutFailed", { error: e instanceof Error ? e.message : String(e) }));
      setStatusError(true);
    },
  });

  const previewBill: Bill = {
    billNumber: heldSaleId ? `HELD-${heldSaleId}` : "—",
    date: new Date(),
    items: cart,
    billDiscount,
  };

  const confirmPrint = async () => {
    if (!printPrompt) return;
    const { bill, invoice } = printPrompt;
    setPrinting(true);
    try {
      await printBill(bill);
      setStatus(t("pos.printed", { invoice }));
      setStatusError(false);
    } catch (e) {
      setStatus(t("pos.saleSavedButPrintFailed", { invoice, error: e instanceof Error ? e.message : String(e) }));
      setStatusError(true);
    } finally {
      setPrinting(false);
      setPrintPrompt(null);
      setCompletedInvoice(invoice);
      setTimeout(() => setCompletedInvoice(null), 2200);
    }
  };

  const declinePrint = () => {
    if (!printPrompt) return;
    const { invoice } = printPrompt;
    setStatus(t("pos.saleCompletedNoBill", { invoice }));
    setStatusError(false);
    setPrintPrompt(null);
    setCompletedInvoice(invoice);
    setTimeout(() => setCompletedInvoice(null), 2200);
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
            <h1 className="text-xl font-semibold text-slate-800">{t("pos.newSale")}</h1>
            <p className="text-sm text-slate-500">{shopName}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => api.openCustomerDisplay().catch(() => {})}
            >
              {t("pos.customerDisplay")}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setShowHeld((v) => !v)}>
              {t("pos.heldSales")}{held.data && held.data.length > 0 ? ` (${held.data.length})` : ""}
            </button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="min-w-0 max-w-xs flex-1">
            <SearchableSelect
              options={(customers.data ?? []).map((c) => ({ id: c.id, label: c.name, sublabel: c.phone ?? undefined }))}
              value={customerId}
              onChange={setCustomerId}
              placeholder={t("pos.customerPlaceholder")}
              noResultsLabel={t("pos.noCustomersFound")}
            />
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50"
            onClick={() => setShowAddCustomer(true)}
          >
            {t("pos.addCustomer")}
          </button>
          {selectedCustomer && (
            <>
              <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-500">
                {t("pos.pointsBalance", { points: selectedCustomer.loyalty_points })}
              </span>
              <button
                type="button"
                className="shrink-0 text-xs text-slate-400 hover:text-slate-700"
                onClick={() => setCustomerId(null)}
              >
                {t("pos.clearCustomer")}
              </button>
            </>
          )}
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
                        {resume.isPending && resume.variables === h.id ? t("common.loading") : t("pos.resume")}
                      </button>
                      {confirmDiscard === h.id ? (
                        <>
                          <button
                            type="button"
                            className="rounded-lg bg-amber-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-40"
                            disabled={discard.isPending}
                            onClick={() => discard.mutate(h.id)}
                          >
                            {discard.isPending ? t("pos.discarding") : t("common.confirm")}
                          </button>
                          <button
                            type="button"
                            className="px-1.5 text-xs text-slate-400 hover:text-slate-600"
                            onClick={() => setConfirmDiscard(null)}
                          >
                            {t("common.cancel")}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="px-1.5 text-xs text-slate-400 hover:text-amber-600"
                          onClick={() => setConfirmDiscard(h.id)}
                          aria-label={t("pos.discardAria", { id: h.id })}
                        >
                          {t("pos.discard")}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">{t("pos.noHeldSales")}</p>
            )}
          </div>
        )}

        <input
          ref={searchRef}
          className="field py-3"
          placeholder={t("pos.searchPlaceholder")}
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
            {t("pos.allProducts")}
          </button>
          {categories.map((c) => {
            const hex = categoryHexByName.get(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => setActiveCategory(c)}
                style={
                  hex
                    ? activeCategory === c
                      ? { backgroundColor: hex, borderColor: hex }
                      : { borderColor: hex, color: hex }
                    : undefined
                }
                className={`rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                  hex
                    ? "bg-white"
                    : activeCategory === c
                      ? "bg-slate-900 text-white border-slate-900"
                      : "bg-white border-slate-200 text-slate-600 hover:bg-slate-50"
                } ${activeCategory === c && hex ? "text-white" : ""}`}
              >
                {c}
              </button>
            );
          })}
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
                style={categoryColorStyle(cat)}
                className={`relative flex flex-col overflow-hidden rounded-lg border border-l-4 bg-white p-2 text-left transition-all duration-150
                  ${categoryColorClass(cat)}
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
                {/* Warns before the popup does — several prices exist and
                    adding this will ask which one. */}
                {p.has_price_options && !inCart && (
                  <span
                    className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-amber-500"
                    title={t("pos.sellsAtMoreThanOnePrice")}
                  />
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
                      {outOfStock ? t("pos.outOfStock") : `${onHand} ${p.base_unit_code}`}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {ordered.length === 0 && (
          <p className="py-10 text-center text-sm text-slate-400">{t("pos.noProductsMatch")}</p>
        )}
      </div>

      {/* Full height so the order stays one column from header to buttons: the
          card is pinned below the nav and the item list is the only part that
          scrolls, which keeps the totals and Complete Sale always in view. */}
      <div className="card flex flex-col overflow-hidden xl:sticky xl:top-20 xl:h-[calc(100vh-7rem)]">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-sm font-semibold text-slate-700">{t("pos.order", { count: cart.length })}</h2>
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
                  {t(`pos.${k}`)}
                </button>
              ))}
            </div>
            {cart.length > 0 && (
              <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={resetCart}>
                {t("pos.clearCart")}
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {cart.length === 0 && <p className="py-8 text-center text-sm text-slate-400">{t("pos.noItemsYet")}</p>}
          {cart.map((l) => {
            const off = lineDiscount(l);
            return (
              <div key={l.id} className="rounded-xl border border-slate-200/80 bg-slate-50 p-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-1 shrink-0 rounded-full bg-brand-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">{l.name}</p>
                    <p className="text-xs text-slate-500">
                      {lkr(l.price)} {t("pos.perUnit", { unit: l.units.find((u) => u.unitId === l.unitId)?.code })}
                      {l.manualBasePrice !== undefined ? (
                        <span className="ml-1 text-amber-600">
                          · {priceChoices(l.detail).find((c) => c.price === l.manualBasePrice)?.label ?? t("pos.chosenPrice")}
                        </span>
                      ) : (
                        pricedByTier(
                          l.detail,
                          l.units.find((u) => u.unitId === l.unitId) ?? l.units[0],
                          l.qty,
                          tierKind
                        ) && <span className="ml-1 text-brand-600">· {t("pos.tierPrice", { tier: t(`pos.${tierKind}`) })}</span>
                      )}
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
                    {off > 0 ? `−${money(off)}` : t("pos.discountThisItem")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5 border-t border-slate-200 px-5 py-4 text-sm">
          <div className="flex justify-between text-slate-500">
            <span>{t("pos.subtotal")}</span>
            <span>{lkr(subtotal)}</span>
          </div>

          {savings > 0 && (
            <div className="flex justify-between text-emerald-600">
              <span>{t("pos.discount")}</span>
              <span>−{lkr(savings)}</span>
            </div>
          )}

          <div className="pt-1">
            {billDiscount ? (
              <DiscountControl
                value={billDiscount}
                base={subtotal - (savings - billOff)}
                label={t("pos.billDiscount")}
                onChange={setBillDiscount}
              />
            ) : (
              <button
                type="button"
                className="text-xs text-slate-500 underline-offset-2 hover:text-brand-700 hover:underline disabled:opacity-40 disabled:no-underline"
                disabled={!cart.length}
                onClick={() => setBillDiscount({ kind: "percent", value: 0 })}
              >
                {t("pos.addBillDiscount")}
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-4">
          <span className="text-sm font-medium text-slate-600">{t("pos.toPay")}</span>
          <span className="text-xl font-semibold text-slate-900">{lkr(toPay)}</span>
        </div>

        {status && (
          <p className={`px-5 pb-2 text-xs ${statusError ? "text-amber-600" : "text-slate-500"}`}>
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
            {t("pos.hold")}
          </button>
          <button
            type="button"
            className="btn-primary flex-1 py-3"
            disabled={!cart.length || checkout.isPending}
            onClick={() => setShowPayment(true)}
          >
            {checkout.isPending ? t("pos.processing") : t("pos.charge")}
          </button>
        </div>
      </div>

      </div>

      <PricePickerDialog
        open={pricePick !== null}
        productName={pricePick?.product.name ?? ""}
        choices={pricePick ? priceChoices(pricePick.detail) : []}
        onPick={(price) => {
          if (!pricePick) return;
          const base = priceChoices(pricePick.detail)[0].price;
          addLine(pricePick.product, pricePick.detail, pricePick.units, price === base ? undefined : price);
          setPricePick(null);
        }}
        onClose={() => setPricePick(null)}
      />

      {(() => {
        const line = cart.find((l) => l.id === lineOptions);
        if (!line) return null;
        const choices = priceChoices(line.detail);
        return (
          <LineDialog
            open
            productName={line.name}
            units={line.units}
            selected={line.unitId}
            priceFor={(u) => unitPrice(line.detail, u, line.qty, tierKind, line.manualBasePrice)}
            onPick={(unitId) => setLineUnit(line.id, unitId)}
            priceChoices={choices.length > 1 ? choices : undefined}
            selectedPrice={line.manualBasePrice ?? choices[0].price}
            onPriceChoice={(price) =>
              setCart((prev) =>
                prev.map((l) =>
                  l.id === line.id
                    ? repriced(
                        { ...l, manualBasePrice: price === choices[0].price ? undefined : price },
                        l.qty,
                        l.units.find((u) => u.unitId === l.unitId) ?? l.units[0],
                        tierKind
                      )
                    : l
                )
              )
            }
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
        pending={checkout.isPending}
      />

      <AddCustomerDialog
        open={showAddCustomer}
        pending={addCustomer.isPending}
        error={addCustomer.isError ? (addCustomer.error instanceof Error ? addCustomer.error.message : String(addCustomer.error)) : null}
        onClose={() => setShowAddCustomer(false)}
        onCreate={(name, phone) => addCustomer.mutate({ name, phone })}
      />

      <div className="preview hidden print:block">
        <Receipt bill={printPrompt?.bill ?? previewBill} />
      </div>

      {printPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={t("pos.printBillQuestion")}
        >
          <div className="card w-full max-w-sm p-5 text-center">
            <p className="text-sm text-slate-500">{t("pos.printBillInvoice", { invoice: printPrompt.invoice })}</p>
            <h2 className="mt-1 text-base font-semibold text-slate-800">{t("pos.printBillQuestion")}</h2>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                className="btn-secondary flex-1 py-2.5"
                disabled={printing}
                onClick={declinePrint}
              >
                {t("pos.printBillNo")}
              </button>
              <button
                type="button"
                className="btn-primary flex-1 py-2.5"
                disabled={printing}
                onClick={confirmPrint}
              >
                {printing ? t("pos.processing") : t("pos.printBillYes")}
              </button>
            </div>
          </div>
        </div>
      )}

      {completedInvoice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="status"
          aria-live="polite"
        >
          <div className="card w-full max-w-sm p-6 text-center">
            <svg viewBox="0 0 52 52" className="mx-auto h-16 w-16">
              <circle
                className="check-circle"
                cx="26"
                cy="26"
                r="24"
                fill="none"
                stroke="#22c55e"
                strokeWidth="3"
              />
              <path
                className="check-mark"
                fill="none"
                stroke="#22c55e"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 27l7 7 15-15"
              />
            </svg>
            <h2 className="mt-3 text-base font-semibold text-slate-800">{t("pos.saleCompleted")}</h2>
            <p className="mt-1 text-sm text-slate-500">{t("pos.printBillInvoice", { invoice: completedInvoice })}</p>
          </div>
        </div>
      )}
    </div>
  );
}
