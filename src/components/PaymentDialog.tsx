import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { lkr } from "../types";

export type Payment = { method: string; amount: string };

// Short labels: these sit five-across in a dialog, and "Bank transfer" on two
// lines makes every button in the row taller for no gain.
const METHODS = [
  { value: "cash", key: "cash" },
  { value: "card", key: "card" },
  { value: "bank_transfer", key: "bank_transfer" },
  { value: "credit", key: "credit" },
  { value: "loyalty_points", key: "loyalty_points" },
] as const;

/**
 * Payment entry, in a dialog rather than inline in the order card.
 *
 * Split payments grow the form by a row each, which on the till pushed the cart
 * out of view exactly when the cashier wants to check it against what is on the
 * counter. Taking payment is also its own step — the cart is settled by the time
 * this opens — so it gets the screen to itself and the card keeps its space.
 */
export default function PaymentDialog({
  open,
  total,
  payments,
  onChange,
  onClose,
  onConfirm,
  pending,
}: {
  open: boolean;
  total: number;
  payments: Payment[];
  onChange: (p: Payment[]) => void;
  onClose: () => void;
  onConfirm: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const firstAmount = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) firstAmount.current?.focus();
  }, [open]);

  // Escape closes, but never mid-checkout: the sale is already being written.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, onClose]);

  if (!open) return null;

  const paid = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const outstanding = Math.max(total - paid, 0);
  const change = Math.max(paid - total, 0);

  const set = (i: number, patch: Partial<Payment>) =>
    onChange(payments.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("paymentDialog.takePayment")}
      onMouseDown={(e) => {
        // Only a click that both starts and ends on the backdrop closes it —
        // a drag that happens to end here should not discard the form.
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div className="card w-full max-w-md p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-700">{t("paymentDialog.takePayment")}</h2>
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-slate-700 disabled:opacity-40"
            onClick={onClose}
            disabled={pending}
          >
            {t("common.close")}
          </button>
        </div>

        <div className="mt-4 rounded-xl bg-slate-50 px-4 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-slate-500">{t("paymentDialog.toPay")}</span>
            <span className="text-2xl font-semibold text-slate-900">{lkr(total)}</span>
          </div>
        </div>

        <form
          className="mt-4 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!pending) onConfirm();
          }}
        >
          {payments.map((p, i) => (
            <div className="rounded-xl border border-slate-200 p-2.5" key={i}>
              {/* Buttons rather than a select: on a touch screen a dropdown is
                  two taps and a small target, and the method is chosen on every
                  single sale. All four stay visible so the choice is one tap. */}
              <div
                className="grid grid-cols-5 gap-1.5"
                role="radiogroup"
                aria-label={t("paymentDialog.methodAria", { n: i + 1 })}
              >
                {METHODS.map((m) => {
                  const active = p.method === m.value;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => set(i, { method: m.value })}
                      className={`rounded-lg px-1 py-2.5 text-xs font-medium leading-tight transition-colors ${
                        active
                          ? "bg-brand-600 text-white shadow-sm"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {t(`paymentDialog.methods.${m.key}`)}
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex gap-2">
                <input
                  ref={i === 0 ? firstAmount : undefined}
                  className="field"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={t("paymentDialog.amountPlaceholder")}
                  aria-label={t("paymentDialog.amountAria", { n: i + 1 })}
                  value={p.amount}
                  onChange={(e) => set(i, { amount: e.target.value })}
                />
                {payments.length > 1 && (
                  <button
                    type="button"
                    className="px-2 text-slate-400 hover:text-amber-600"
                    onClick={() => onChange(payments.filter((_, j) => j !== i))}
                    aria-label={t("paymentDialog.removeAria", { n: i + 1 })}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              className="text-xs text-slate-500 hover:text-brand-700"
              onClick={() => onChange([...payments, { method: "cash", amount: "" }])}
            >
              {t("paymentDialog.splitPayment")}
            </button>
            {outstanding > 0 && (
              <button
                type="button"
                className="text-xs text-slate-500 hover:text-brand-700"
                // Fills the last row with what is still owed — the common case
                // is one method covering the whole bill.
                onClick={() =>
                  set(payments.length - 1, {
                    amount: (
                      (Number(payments[payments.length - 1].amount) || 0) + outstanding
                    ).toFixed(2),
                  })
                }
              >
                {t("paymentDialog.payTheRest")}
              </button>
            )}
          </div>

          <dl className="space-y-1 border-t border-slate-200 pt-3 text-sm">
            <div className="flex justify-between text-slate-500">
              <dt>{t("paymentDialog.paid")}</dt>
              <dd>{lkr(paid)}</dd>
            </div>
            {outstanding > 0 && (
              <div className="flex justify-between font-medium text-amber-600">
                <dt>{t("paymentDialog.onCredit")}</dt>
                <dd>{lkr(outstanding)}</dd>
              </div>
            )}
            {change > 0 && (
              <div className="flex justify-between font-medium text-emerald-600">
                <dt>{t("paymentDialog.change")}</dt>
                <dd>{lkr(change)}</dd>
              </div>
            )}
          </dl>

          <button type="submit" className="btn-primary mt-2 w-full py-3" disabled={pending}>
            {pending ? t("paymentDialog.processing") : t("paymentDialog.completeSale")}
          </button>
        </form>
      </div>
    </div>
  );
}
