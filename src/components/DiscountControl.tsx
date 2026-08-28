import { useEffect, useRef, useState } from "react";
import { SHOP } from "../shop";
import { Discount, DiscountKind, lkr } from "../types";

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
  label = "Discount",
}: {
  value?: Discount;
  /** What the discount comes off, for the live preview and the cap. */
  base: number;
  onChange: (d?: Discount) => void;
  onDone?: () => void;
  autoFocus?: boolean;
  label?: string;
}) {
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
  // Mirrors the clamping the backend applies, so the cashier sees the capped
  // figure here rather than a surprise on the receipt.
  const amount = kind === "percent"
    ? Math.min((base * Math.min(Math.max(n, 0), 100)) / 100, base)
    : Math.min(Math.max(n, 0), base);
  const overCap = kind === "percent" ? n > 100 : n > base;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-lg border border-slate-700">
          {(["percent", "fixed"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => push(k, raw)}
              className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                kind === k ? "bg-brand-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {k === "percent" ? "%" : SHOP.currency}
            </button>
          ))}
        </div>
        <input
          ref={inputRef}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
          type="number"
          step="0.01"
          min="0"
          max={kind === "percent" ? 100 : undefined}
          placeholder={kind === "percent" ? `${label} %` : `${label} amount`}
          value={raw}
          onChange={(e) => push(kind, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") {
              e.preventDefault();
              onDone?.();
            }
          }}
          aria-label={`${label} value`}
        />
        {value && (
          <button
            type="button"
            className="px-1.5 text-xs text-slate-400 hover:text-amber-400"
            onClick={() => push(kind, "")}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            Clear
          </button>
        )}
      </div>
      {value && (
        <p className={`text-[11px] ${overCap ? "text-amber-400" : "text-slate-400"}`}>
          −{lkr(amount)}
          {overCap && ` · capped at ${kind === "percent" ? "100%" : lkr(base)}`}
        </p>
      )}
    </div>
  );
}
