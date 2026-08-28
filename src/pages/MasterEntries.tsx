import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";

/**
 * The shop's own vocabulary: the units it sells by, and the categories and
 * brands it files products under.
 *
 * These used to be reachable only as two small "quick add" boxes tucked under
 * the product form, and units could not be added at all — the ten in the
 * migration were all a shop would ever have. A shop that sells by the acre, the
 * roll or the bundle needs to be able to say so, so units are created here like
 * everything else.
 */
export default function MasterEntries() {
  const qc = useQueryClient();
  const [status, setStatus] = useState("");

  const units = useQuery({ queryKey: ["units"], queryFn: api.units });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const brands = useQuery({ queryKey: ["brands"], queryFn: api.brands });

  // One handler for all three: they differ only in what they invalidate and
  // what they call.
  const added = (key: string, what: string) => ({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [key] });
      setStatus(`${what} added.`);
    },
    onError: (e: unknown) =>
      setStatus(e instanceof Error ? e.message : String(e)),
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

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Master Entries</h1>
        <p className="text-sm text-slate-500">
          Units, categories and brands used across products, purchasing and the till.
        </p>
      </div>

      {status && (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-600">
          {status}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        <Panel
          title="Units"
          hint="How stock is counted and sold — pieces, kilograms, bottles, or anything the shop uses."
          count={units.data?.length}
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const code = (form.elements.namedItem("code") as HTMLInputElement).value;
              const name = (form.elements.namedItem("name") as HTMLInputElement).value;
              if (!code.trim() || !name.trim()) return;
              addUnit.mutate(
                { code, name },
                { onSuccess: () => form.reset() }
              );
            }}
          >
            <input className="field !py-1.5 w-24 text-xs" name="code" placeholder="Code" aria-label="Unit code" />
            <input className="field !py-1.5 text-xs" name="name" placeholder="Name" aria-label="Unit name" />
            <button type="submit" className="btn-secondary !py-1.5 !px-3 text-xs" disabled={addUnit.isPending}>
              Add
            </button>
          </form>

          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {units.data?.map((u) => (
              <li key={u.id} className="flex items-center justify-between py-2">
                <span className="text-slate-700">{u.name}</span>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                  {u.code}
                </span>
              </li>
            ))}
            {units.data?.length === 0 && <li className="py-2 text-slate-400">None yet.</li>}
          </ul>
        </Panel>

        <Panel
          title="Categories"
          hint="How products are grouped on the till's product grid."
          count={categories.data?.length}
        >
          <NameForm
            placeholder="New category"
            busy={addCategory.isPending}
            onAdd={(name) => addCategory.mutate(name)}
          />
          <NameList names={categories.data?.map((c) => ({ id: c.id, name: c.name }))} />
        </Panel>

        <Panel title="Brands" hint="Who makes the product." count={brands.data?.length}>
          <NameForm placeholder="New brand" busy={addBrand.isPending} onAdd={(name) => addBrand.mutate(name)} />
          <NameList names={brands.data?.map((b) => ({ id: b.id, name: b.name }))} />
        </Panel>
      </div>
    </div>
  );
}

function Panel({
  title,
  hint,
  count,
  children,
}: {
  title: string;
  hint: string;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-brand-700">{title}</h2>
        {count !== undefined && <span className="text-xs text-slate-400">{count}</span>}
      </div>
      <p className="mb-4 text-xs text-slate-400">{hint}</p>
      {children}
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
        className="field !py-1.5 text-xs"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn-secondary !py-1.5 !px-3 text-xs" disabled={busy}>
        Add
      </button>
    </form>
  );
}

function NameList({ names }: { names?: { id: number; name: string }[] }) {
  return (
    <ul className="mt-3 divide-y divide-slate-100 text-sm">
      {names?.map((n) => (
        <li key={n.id} className="py-2 text-slate-700">
          {n.name}
        </li>
      ))}
      {names?.length === 0 && <li className="py-2 text-slate-400">None yet.</li>}
    </ul>
  );
}
