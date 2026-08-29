import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * A quick way for the cashier to register a walk-in customer without leaving
 * the till — name and phone are all the loyalty program needs, so this stays
 * a two-field popup rather than sending the cashier to Master Entries.
 */
export default function AddCustomerDialog({
  open,
  pending,
  error,
  onClose,
  onCreate,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (name: string, phone: string | null) => void;
}) {
  const { t } = useTranslation();
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) nameRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, pending, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("pos.addCustomerTitle")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div className="card w-full max-w-sm p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{t("pos.addCustomerTitle")}</h2>
          <button
            type="button"
            className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-40"
            onClick={onClose}
            disabled={pending}
          >
            {t("common.close")}
          </button>
        </div>

        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pending) return;
            const form = e.currentTarget;
            const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
            if (!value("name")) return;
            onCreate(value("name"), value("phone") || null);
          }}
        >
          <input
            ref={nameRef}
            className="field"
            name="name"
            placeholder={t("pos.customerNamePlaceholder")}
            aria-label={t("pos.customerNamePlaceholder")}
          />
          <input
            className="field"
            name="phone"
            placeholder={t("pos.customerPhonePlaceholder")}
            aria-label={t("pos.customerPhonePlaceholder")}
          />

          {error && <p className="text-xs text-amber-600">{error}</p>}

          <button type="submit" className="btn-primary w-full py-2.5" disabled={pending}>
            {pending ? t("pos.addingCustomer") : t("pos.addCustomer")}
          </button>
        </form>
      </div>
    </div>
  );
}
