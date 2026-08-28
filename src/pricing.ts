import { PriceTier, ProductDetail, ProductUnit } from "./api";

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
  kind: TierKind
): number {
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
