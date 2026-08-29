import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CURRENCY } from "../shop";
import { Discount, DiscountKind, discountAmount, lkr } from "../types";

/**
 * Percentage-or-amount discount entry, used for a single line and for the whole
 * bill.
 *
 * It shows what the discount is worth in money as you type, because "10%" and
 * "10 rupees" are one keystroke apart and the difference only becomes obvious
 * once it is priced. Clearing the field removes the discount rather than
 * recording a zero one.
 */
export default function DiscountControl({
  value,
  base,
  onChange,
  onDone,
  autoFocus = false,
  label,
}: {
  value?: Discount;
  /** What the discount comes off, for the live preview and the cap. */
  base: number;
  onChange: (d?: Discount) => void;
  onDone?: () => void;
  autoFocus?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("discountControl.defaultLabel");
  const [kind, setKind] = useState<DiscountKind>(value?.kind ?? "percent");
  const [raw, setRaw] = useState(value ? String(value.value) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.select();
  }, [autoFocus]);

  const push = (nextKind: DiscountKind, nextRaw: string) => {
    setKind(nextKind);
    setRaw(nextRaw);
    const n = Number(nextRaw);
    onChange(nextRaw.trim() === "" || !Number.isFinite(n) || n <= 0 ? undefined : { kind: nextKind, value: n });
  };

  const n = Number(raw) || 0;
  // Shares the same clamping/rounding the backend applies (via discountAmount),
  // so the cashier sees the capped figure here rather than a surprise later.
  const amount = discountAmount(base, { kind, value: n });
  const overCap = kind === "percent" ? n > 100 : n > base;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
          {(["percent", "fixed"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => push(k, raw)}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                kind === k ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
              }`}
            >
              {k === "percent" ? "%" : CURRENCY}
            </button>
          ))}
        </div>
        <input
          ref={inputRef}
          className="w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-sm text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500"
          type="number"
          step="0.01"
          min="0"
          max={kind === "percent" ? 100 : undefined}
          placeholder={
            kind === "percent"
              ? t("discountControl.percentPlaceholder", { label: resolvedLabel })
              : t("discountControl.amountPlaceholder", { label: resolvedLabel })
          }
          value={raw}
          onChange={(e) => push(kind, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              onDone?.();
            }
          }}
          aria-label={`${resolvedLabel} value`}
        />
        {value && (
          <button
            type="button"
            className="px-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-amber-600"
            onClick={() => push(kind, "")}
            aria-label={t("discountControl.removeAria", { label: resolvedLabel })}
          >
            {t("common.clear")}
          </button>
        )}
      </div>
      {value && (
        <p className={`text-[11px] ${overCap ? "text-amber-600" : "text-slate-500 dark:text-slate-400"}`}>
          −{lkr(amount)}
          {overCap &&
            ` · ${kind === "percent" ? t("discountControl.cappedAtPercent") : t("discountControl.cappedAt", { amount: lkr(base) })}`}
        </p>
      )}
    </div>
  );
}
