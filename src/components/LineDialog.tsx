import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SellableUnit } from "../pricing";
import { Discount, lkr } from "../types";
import DiscountControl from "./DiscountControl";

/**
 * Everything about one cart line that is not its quantity: what unit it sells
 * by, and what comes off it.
 *
 * Both were controls sitting inside the line itself, in a 380px card — a select
 * and a discount editor competing with the name, the stepper and the total. In
 * a dialog each gets room to say what it is doing: a unit shows what it costs at
 * this quantity, and a discount shows what it takes off.
 */
export default function LineDialog({
  open,
  productName,
  units,
  selected,
  priceFor,
  onPick,
  priceChoices,
  selectedPrice,
  onPriceChoice,
  discount,
  discountBase,
  onDiscount,
  onClose,
}: {
  open: boolean;
  productName: string;
  units: SellableUnit[];
  selected: number;
  /** What one of that unit costs at the line's current quantity. */
  priceFor: (unit: SellableUnit) => number;
  onPick: (unitId: number) => void;
  /** Present only when the product sells at more than one price — absent for
      every ordinary product, and the section does not render. */
  priceChoices?: { label: string; price: number }[];
  selectedPrice?: number;
  onPriceChoice?: (price: number) => void;
  discount?: Discount;
  /** The line's gross, which the discount comes off and is capped at. */
  discountBase: number;
  onDiscount: (d?: Discount) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("lineDialog.aria", { name: productName })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-sm p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-slate-700">{productName}</h2>
          <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        {units.length > 1 && (
          <>
            <p className="mt-3 text-xs font-medium text-slate-500">{t("lineDialog.sellBy")}</p>
            <div className="mt-1.5 space-y-1.5">
              {units.map((u) => {
                const active = u.unitId === selected;
                return (
                  <button
                    key={u.unitId}
                    type="button"
                    onClick={() => onPick(u.unitId)}
                    className={`flex w-full items-baseline justify-between rounded-xl border px-3.5 py-3 text-left transition-colors ${
                      active
                        ? "border-brand-400 bg-brand-50"
                        : "border-slate-200 bg-white hover:bg-slate-50"
                    }`}
                  >
                    <span className="text-sm font-medium text-slate-800">
                      {u.code}
                      {u.factor !== 1 && (
                        <span className="ml-1.5 text-xs font-normal text-slate-400">
                          {t("lineDialog.baseSuffix", { factor: u.factor })}
                        </span>
                      )}
                    </span>
                    <span className={`text-sm font-semibold ${active ? "text-brand-700" : "text-slate-700"}`}>
                      {lkr(priceFor(u))}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {priceChoices && priceChoices.length > 1 && (
          <>
            <p className="mt-3 text-xs font-medium text-slate-500">{t("lineDialog.price")}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {priceChoices.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => onPriceChoice?.(c.price)}
                  className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    selectedPrice === c.price
                      ? "border-brand-400 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {c.label} · {lkr(c.price)}
                </button>
              ))}
            </div>
          </>
        )}

        <p className="mt-4 text-xs font-medium text-slate-500">{t("lineDialog.itemDiscount")}</p>
        <div className="mt-1.5">
          <DiscountControl
            value={discount}
            base={discountBase}
            autoFocus={units.length === 1}
            label={t("lineDialog.itemDiscountLabel")}
            onChange={onDiscount}
            onDone={onClose}
          />
        </div>

        <button type="button" className="btn-primary mt-5 w-full py-2.5" onClick={onClose}>
          {t("lineDialog.done")}
        </button>
      </div>
    </div>
  );
}
