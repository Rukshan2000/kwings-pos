import { useEffect, useRef, useState } from "react";

export type SearchableOption = { id: number; label: string; sublabel?: string };

/** A text-searchable substitute for a plain <select>, for lists too long to
    scan by eye (e.g. picking a product out of hundreds). */
export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  noResultsLabel,
}: {
  options: SearchableOption[];
  value: number | null;
  onChange: (id: number) => void;
  placeholder: string;
  noResultsLabel: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.id === value) ?? null;
  const filtered = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const pick = (id: number) => {
    onChange(id);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="relative" ref={rootRef}>
      <input
        className="field"
        value={open ? query : selected?.label ?? ""}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
          setHighlight(0);
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[highlight]) pick(filtered[highlight].id);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
          }
        }}
      />
      {open && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {filtered.map((o, i) => (
            <li key={o.id}>
              <button
                type="button"
                className={`block w-full px-3 py-1.5 text-left text-sm ${
                  i === highlight ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-50"
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o.id)}
              >
                {o.label}
                {o.sublabel && <span className="ml-1.5 text-xs text-slate-400">{o.sublabel}</span>}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="px-3 py-1.5 text-sm text-slate-400">{noResultsLabel}</li>}
        </ul>
      )}
    </div>
  );
}
