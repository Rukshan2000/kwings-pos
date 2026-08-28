import { useEffect } from "react";
import { SellableUnit } from "../pricing";
import { lkr } from "../types";

/**
 * Picking the unit a line is sold in.
 *
 * A dialog rather than a select in the cart line: the order card is narrow, a
 * dropdown there is a small target on a touch screen, and the choice is worth
 * seeing priced — "box (12) — LKR 240.00" says more than "box" does.
 */
export default function UnitDialog({
  open,
  productName,
  units,
  selected,
  priceFor,
  onPick,
  onClose,
}: {
  open: boolean;
  productName: string;
  units: SellableUnit[];
  selected: number;
  /** What one of that unit costs at the line's current quantity. */
  priceFor: (unit: SellableUnit) => number;
  onPick: (unitId: number) => void;
  onClose: () => void;
}) {
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
      aria-label={`Unit for ${productName}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-sm p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="min-w-0 truncate text-sm font-semibold text-slate-700">{productName}</h2>
          <button type="button" className="text-xs text-slate-400 hover:text-slate-700" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-400">Sell this line by:</p>

        <div className="mt-3 space-y-1.5">
          {units.map((u) => {
            const active = u.unitId === selected;
            return (
              <button
                key={u.unitId}
                type="button"
                onClick={() => {
                  onPick(u.unitId);
                  onClose();
                }}
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
                      = {u.factor} base
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
      </div>
    </div>
  );
}
