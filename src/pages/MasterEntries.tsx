import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { lkr } from "../types";

type Tab = "units" | "categories" | "brands" | "suppliers";

const TABS: { id: Tab; label: string; hint: string }[] = [
  {
    id: "units",
    label: "Units",
    hint: "How stock is counted and sold — pieces, kilograms, bottles, or anything else the shop uses.",
  },
  { id: "categories", label: "Categories", hint: "How products are grouped on the till's product grid." },
  { id: "brands", label: "Brands", hint: "Who makes the product." },
  {
    id: "suppliers",
    label: "Suppliers",
    hint: "Who stock is bought from. Purchases are raised against these, and what is still owed is tracked per supplier.",
  },
];

/**
 * The shop's own vocabulary: the units it sells by, the categories and brands it
 * files products under, and the suppliers it buys from.
 *
 * One tab at a time rather than four panels side by side. Each of these is a
 * form plus a list that grows without limit, and four of them on one screen
 * meant four short scrolling boxes competing for the same space — the page was
 * busiest exactly where it should have been calmest.
 */
export default function MasterEntries() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("units");
  const [status, setStatus] = useState("");

  const units = useQuery({ queryKey: ["units"], queryFn: api.units });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const brands = useQuery({ queryKey: ["brands"], queryFn: api.brands });
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: api.suppliers });

  const counts: Record<Tab, number | undefined> = {
    units: units.data?.length,
    categories: categories.data?.length,
    brands: brands.data?.length,
    suppliers: suppliers.data?.length,
  };

  // The three write paths differ only in what they call and what they refresh.
  const added = (key: string, what: string) => ({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [key] });
      setStatus(`${what} added.`);
    },
    onError: (e: unknown) => setStatus(e instanceof Error ? e.message : String(e)),
  });

  const addUnit = useMutation({
    mutationFn: ({ code, name }: { code: string; name: string }) => api.createUnit(code, name),
    ...added("units", "Unit"),
  });
  const addCategory = useMutation({
    mutationFn: (name: string) => api.createCategory(name),
    ...added("categories", "Category"),
  });
  const addBrand = useMutation({
    mutationFn: (name: string) => api.createBrand(name),
    ...added("brands", "Brand"),
  });
  const addSupplier = useMutation({
    mutationFn: (input: { name: string; phone: string | null; address: string | null }) =>
      api.createSupplier(input),
    ...added("suppliers", "Supplier"),
  });

  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Master Entries</h1>
        <p className="text-sm text-slate-500">
          The lists the rest of the app chooses from.
        </p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Master entries">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setStatus("");
            }}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t.label}
            {counts[t.id] !== undefined && (
              <span className={`ml-1.5 text-xs ${tab === t.id ? "text-slate-300" : "text-slate-400"}`}>
                {counts[t.id]}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="card max-w-3xl p-5">
        <p className="mb-4 text-xs text-slate-400">{active.hint}</p>

        {status && (
          <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{status}</p>
        )}

        {tab === "units" && (
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
                if (!value("code") || !value("name")) return;
                addUnit.mutate(
                  { code: value("code"), name: value("name") },
                  { onSuccess: () => form.reset() }
                );
              }}
            >
              <input className="field w-28" name="code" placeholder="Code" aria-label="Unit code" />
              <input className="field" name="name" placeholder="Name" aria-label="Unit name" />
              <button type="submit" className="btn-secondary shrink-0" disabled={addUnit.isPending}>
                Add
              </button>
            </form>
            <Rows
              empty={units.data?.length === 0}
              rows={units.data?.map((u) => ({
                id: u.id,
                left: u.name,
                right: (
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                    {u.code}
                  </span>
                ),
              }))}
            />
          </>
        )}

        {tab === "categories" && (
          <>
            <NameForm
              placeholder="New category"
              busy={addCategory.isPending}
              onAdd={(name) => addCategory.mutate(name)}
            />
            <Rows
              empty={categories.data?.length === 0}
              rows={categories.data?.map((c) => ({ id: c.id, left: c.name }))}
            />
          </>
        )}

        {tab === "brands" && (
          <>
            <NameForm placeholder="New brand" busy={addBrand.isPending} onAdd={(name) => addBrand.mutate(name)} />
            <Rows
              empty={brands.data?.length === 0}
              rows={brands.data?.map((b) => ({ id: b.id, left: b.name }))}
            />
          </>
        )}

        {tab === "suppliers" && (
          <>
            <form
              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
                if (!value("name")) return;
                addSupplier.mutate(
                  {
                    name: value("name"),
                    phone: value("phone") || null,
                    address: value("address") || null,
                  },
                  { onSuccess: () => form.reset() }
                );
              }}
            >
              <input className="field" name="name" placeholder="Name *" aria-label="Supplier name" />
              <input className="field" name="phone" placeholder="Phone" aria-label="Supplier phone" />
              <input className="field" name="address" placeholder="Address" aria-label="Supplier address" />
              <button type="submit" className="btn-secondary shrink-0" disabled={addSupplier.isPending}>
                Add
              </button>
            </form>
            <Rows
              empty={suppliers.data?.length === 0}
              rows={suppliers.data?.map((s) => ({
                id: s.id,
                left: (
                  <>
                    {s.name}
                    {s.phone && <span className="ml-2 text-xs text-slate-400">{s.phone}</span>}
                  </>
                ),
                right:
                  Number(s.outstanding) > 0 ? (
                    <span className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      {lkr(Number(s.outstanding))} owed
                    </span>
                  ) : undefined,
              }))}
            />
          </>
        )}
      </div>
    </div>
  );
}

function NameForm({
  placeholder,
  busy,
  onAdd,
}: {
  placeholder: string;
  busy: boolean;
  onAdd: (name: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onAdd(value.trim());
        setValue("");
      }}
    >
      <input
        className="field"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn-secondary shrink-0" disabled={busy}>
        Add
      </button>
    </form>
  );
}

function Rows({
  rows,
  empty,
}: {
  rows?: { id: number; left: React.ReactNode; right?: React.ReactNode }[];
  empty: boolean;
}) {
  return (
    <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 text-sm">
      {rows?.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
          <span className="min-w-0 text-slate-700">{r.left}</span>
          {r.right}
        </li>
      ))}
      {empty && <li className="py-3 text-slate-400">None yet.</li>}
    </ul>
  );
}
