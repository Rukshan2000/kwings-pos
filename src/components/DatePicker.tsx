import { useEffect, useRef, useState } from "react";

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function toIso(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseIso(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export default function DatePicker({
  value,
  onChange,
  min,
  max,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseIso(value);
  const [viewMonth, setViewMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const rootRef = useRef<HTMLDivElement>(null);

  const minDate = min ? parseIso(min) : null;
  const maxDate = max ? parseIso(max) : null;
  const today = new Date();

  useEffect(() => {
    if (open) setViewMonth(new Date(selected.getFullYear(), selected.getMonth(), 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const isDisabled = (d: Date) => (minDate && d < minDate) || (maxDate && d > maxDate);

  const firstOfMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const daysInMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0).getDate();
  // Monday-first offset: JS getDay() is 0=Sunday.
  const leadingBlanks = (firstOfMonth.getDay() + 6) % 7;
  const cells: (Date | null)[] = [
    ...Array(leadingBlanks).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(viewMonth.getFullYear(), viewMonth.getMonth(), i + 1)),
  ];

  const pick = (d: Date) => {
    if (isDisabled(d)) return;
    onChange(toIso(d));
    setOpen(false);
  };

  return (
    <div className={`relative inline-block ${className ?? ""}`} ref={rootRef}>
      <button
        type="button"
        className="field !w-auto inline-flex items-center gap-2 !py-1.5"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" className="text-slate-400 dark:text-slate-500 shrink-0">
          <rect x="3" y="4.5" width="14" height="12.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M3 8h14M6.5 2.5v3M13.5 2.5v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {selected.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1.5 w-72 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
            >
              ‹
            </button>
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700"
              onClick={() => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-y-1 text-center">
            {WEEKDAYS.map((w) => (
              <span key={w} className="text-[11px] font-medium text-slate-400 dark:text-slate-500">{w}</span>
            ))}
            {cells.map((d, i) =>
              d ? (
                <button
                  key={i}
                  type="button"
                  disabled={!!isDisabled(d)}
                  onClick={() => pick(d)}
                  className={`mx-auto flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors ${
                    sameDay(d, selected)
                      ? "bg-brand-600 text-white font-semibold"
                      : sameDay(d, today)
                        ? "text-brand-700 font-semibold ring-1 ring-inset ring-brand-200"
                        : "text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700"
                  } ${isDisabled(d) ? "cursor-not-allowed opacity-30 hover:bg-transparent" : ""}`}
                >
                  {d.getDate()}
                </button>
              ) : (
                <span key={i} />
              )
            )}
          </div>

          <div className="mt-2 flex justify-between border-t border-slate-100 dark:border-slate-800 pt-2">
            <button
              type="button"
              className="text-xs font-medium text-brand-600 hover:underline disabled:text-slate-300 disabled:no-underline"
              disabled={!!isDisabled(today)}
              onClick={() => pick(today)}
            >
              Today
            </button>
            <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
