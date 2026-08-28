import { PriceOption, PriceTier, ProductDetail, ProductUnit } from "./api";

export type TierKind = "retail" | "wholesale";

/** A unit a product can be sold in, and what one of it is worth in base units. */
export type SellableUnit = {
  unitId: number;
  code: string;
  /** 1 for the base unit; 12 for a box of twelve pieces. */
  factor: number;
};

/**
 * The base unit first, then whatever alternates the product defines.
 *
 * The base unit is not a row in `product_unit` — it is `product.base_unit_id`
 * with an implied factor of 1 — so it has to be prepended rather than read.
 */
export function sellableUnits(detail: ProductDetail): SellableUnit[] {
  const base: SellableUnit = {
    unitId: detail.base_unit_id,
    code: detail.base_unit_code,
    factor: 1,
  };
  const alternates = detail.units
    .filter((u: ProductUnit) => u.unit_id !== detail.base_unit_id)
    .map((u) => ({ unitId: u.unit_id, code: u.unit_code, factor: Number(u.factor) }))
    .sort((a, b) => a.factor - b.factor);
  return [base, ...alternates];
}

/**
 * The prices a cashier can choose between for this product, in the base unit —
 * the product's own `selling_price` first, then each `price_option` in the
 * shop's own order. A product with no options yields just the one, so calling
 * code can treat "one price" and "several" the same way rather than branching.
 */
export function priceChoices(detail: ProductDetail): { label: string; price: number }[] {
  return [
    { label: "Regular", price: Number(detail.selling_price) },
    ...detail.price_options
      .slice()
      .sort((a: PriceOption, b: PriceOption) => a.sort_order - b.sort_order)
      .map((o) => ({ label: o.label, price: Number(o.price) })),
  ];
}

/**
 * What one `unit` costs at this quantity.
 *
 * Price tiers are quantity breaks: a row says "at 10 or more of this unit, the
 * price is X". The applicable tier is the highest `min_qty` at or below the
 * quantity being sold, so a cart of 12 takes the 10+ price rather than the 5+
 * one.
 *
 * When the requested kind has no tier that applies, retail is tried before
 * giving up — a shop that has set only retail breaks still expects them to hold
 * on a wholesale sale, rather than silently reverting to the list price. The
 * final fallback is the product's own `selling_price`, scaled by the unit's
 * factor: a box of twelve is twelve pieces unless a tier says otherwise.
 */
export function unitPrice(
  detail: ProductDetail,
  unit: SellableUnit,
  qty: number,
  kind: TierKind,
  /** A price the cashier picked from `priceChoices`, in the base unit. Set,
      this stands in for `selling_price` and skips tiers — a manually chosen
      price is a deliberate override, not something a quantity break should
      then second-guess. */
  manualBasePrice?: number
): number {
  if (manualBasePrice !== undefined) return manualBasePrice * unit.factor;

  const applicable = (k: TierKind) =>
    detail.price_tiers
      .filter((t: PriceTier) => t.unit_id === unit.unitId && t.kind === k && Number(t.min_qty) <= qty)
      .sort((a, b) => Number(b.min_qty) - Number(a.min_qty))[0];

  const tier = applicable(kind) ?? (kind === "wholesale" ? applicable("retail") : undefined);
  if (tier) return Number(tier.price);

  return Number(detail.selling_price) * unit.factor;
}

/** Whether a tier — rather than the list price — is what set this price. */
export function pricedByTier(
  detail: ProductDetail,
  unit: SellableUnit,
  qty: number,
  kind: TierKind
): boolean {
  const list = Number(detail.selling_price) * unit.factor;
  return unitPrice(detail, unit, qty, kind) !== list;
}
