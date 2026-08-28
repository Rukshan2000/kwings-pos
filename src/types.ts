import { SHOP } from "./shop";

export type DiscountKind = "percent" | "fixed";

/** What the cashier typed, not what it comes to. */
export type Discount = { kind: DiscountKind; value: number };

export type Item = {
  id: string;
  name: string;
  qty: number;
  price: number;
  discount?: Discount;
};

export type Bill = {
  billNumber: string;
  date: Date;
  items: Item[];
  /** A discount off the whole bill, on top of any per-line ones. */
  billDiscount?: Discount;
};

/**
 * These mirror `domain::money::bill_totals` in the Rust backend, which stays the
 * authoritative one: the server recomputes every total from the cashier's typed
 * kind/value and stores that, so a tampered or stale client cannot bank a
 * discount the rules would not allow. What is here exists so the till can show
 * a running total without a round trip on every keystroke.
 *
 * Amounts are rounded to whole cents at the same points the backend rounds, so
 * the two agree on ordinary money. They can differ by a cent on an exact
 * half-cent tie, where Postgres and Rust round to even and JavaScript rounds up
 * — the printed receipt uses the server's figures, not these.
 */
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Amount taken off `base`, clamped so it can never exceed it or go negative. */
export const discountAmount = (base: number, d?: Discount): number => {
  if (!d || !Number.isFinite(d.value)) return 0;
  const raw = d.kind === "percent" ? (base * clamp(d.value, 0, 100)) / 100 : Math.max(d.value, 0);
  return round2(Math.min(raw, Math.max(base, 0)));
};

export const lineGross = (i: Item) => round2(i.qty * i.price);
export const lineDiscount = (i: Item) => discountAmount(lineGross(i), i.discount);
export const lineTotal = (i: Item) => lineGross(i) - lineDiscount(i);

/** Gross, before any discount. */
export const subtotal = (items: Item[]) => round2(items.reduce((s, i) => s + lineGross(i), 0));
export const lineDiscountTotal = (items: Item[]) =>
  round2(items.reduce((s, i) => s + lineDiscount(i), 0));

/**
 * The bill discount applies to what is left after line discounts — a percentage
 * off "the bill" has to mean the amount actually due, or two discounts could
 * between them come to more than the customer owes.
 */
export const billDiscountAmount = (items: Item[], d?: Discount) =>
  discountAmount(subtotal(items) - lineDiscountTotal(items), d);

export const discountTotal = (items: Item[], d?: Discount) =>
  round2(lineDiscountTotal(items) + billDiscountAmount(items, d));

export const grandTotal = (items: Item[], d?: Discount) =>
  round2(subtotal(items) - discountTotal(items, d));

export const money = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Every price the shop shows or prints carries its currency. */
export const lkr = (n: number) => `${SHOP.currency} ${money(n)}`;

/** "10%" or "LKR 250.00", for showing what was applied. */
export const describeDiscount = (d: Discount) =>
  d.kind === "percent" ? `${round2(d.value)}%` : lkr(d.value);
