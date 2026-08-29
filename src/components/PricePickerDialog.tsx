import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { lkr } from "../types";

/**
 * Which price a product is added to the cart at, when it has more than one.
 *
 * Shown once, at the moment a product is first added — market chilli powder is
 * still one product with one entry in the catalogue, it just has two prices,
 * and the cashier has to say which one applies to this sale. A product with
 * only its regular price never triggers this; it goes straight into the cart
 * the way it always did.
 */
export default function PricePickerDialog({
  open,
  productName,
  choices,
  onPick,
  onClose,
}: {
  open: boolean;
  productName: string;
  choices: { label: string; price: number }[];
  onPick: (price: number) => void;
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
      aria-label={t("pricePicker.aria", { name: productName })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-sm p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-slate-700 dark:text-slate-200">{productName}</h2>
          <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t("pricePicker.hint")}</p>

        <div className="mt-3 space-y-1.5">
          {choices.map((c, i) => (
            <button
              key={i}
              type="button"
              autoFocus={i === 0}
              onClick={() => onPick(c.price)}
              className="flex w-full items-center justify-between rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-3 text-left transition-colors hover:border-brand-300 hover:bg-brand-50"
            >
              <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{c.label}</span>
              <span className="text-base font-semibold text-slate-900 dark:text-slate-50">{lkr(c.price)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
