import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, Product } from "../api";

const emptyForm = {
  sku: "",
  barcode: "",
  name: "",
  category_id: null as number | null,
  brand_id: null as number | null,
  base_unit_id: 0,
  cost_price: "0",
  selling_price: "0",
  low_stock_at: "0",
  quick_add: false,
  sort_order: 0,
};
type Form = typeof emptyForm;

export default function Products() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const products = useQuery({
    queryKey: ["products", search, showArchived],
    queryFn: () => api.products(search || undefined, showArchived),
  });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const brands = useQuery({ queryKey: ["brands"], queryFn: api.brands });
  const units = useQuery({ queryKey: ["units"], queryFn: api.units });

  const detail = useQuery({
    queryKey: ["product", selectedId],
    queryFn: () => api.product(selectedId!),
    enabled: selectedId !== null,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["products"] });
    if (selectedId !== null) qc.invalidateQueries({ queryKey: ["product", selectedId] });
  };

  const save = useMutation({
    mutationFn: () => {
      // The number input yields "" when cleared, which is not a NUMERIC the
      // backend can bind now that the column is NOT NULL.
      const input = { ...form, low_stock_at: form.low_stock_at.trim() || "0" };
      return editing ? api.updateProduct(editing.id, input) : api.createProduct(input);
    },
    onSuccess: () => {
      invalidate();
      setEditing(null);
      setForm(emptyForm);
      setError("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const restore = useMutation({
    mutationFn: (id: number) => api.restoreProduct(id),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const archive = useMutation({
    mutationFn: (id: number) => api.archiveProduct(id),
    onSuccess: () => {
      setConfirmArchive(null);
      invalidate();
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const startEdit = (p: Product) => {
    setEditing(p);
    setForm({
      sku: p.sku ?? "",
      barcode: p.barcode ?? "",
      name: p.name,
      category_id: p.category_id,
      brand_id: p.brand_id,
      base_unit_id: p.base_unit_id,
      cost_price: p.cost_price,
      selling_price: p.selling_price,
      low_stock_at: p.low_stock_at,
      quick_add: p.quick_add,
      sort_order: p.sort_order,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(emptyForm);
    setError("");
  };

  const unitList = units.data ?? [];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5 items-start">
      <div className="card p-6">
        <div className="mb-4 flex items-center gap-3">
          <input
            className="field"
            placeholder="Search by name, SKU or scan a barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {/* Archiving hides a product; this is where it went. Nothing is ever
              deleted, so anything listed here can come straight back. */}
          <button
            type="button"
            className={`shrink-0 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
              showArchived
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
            onClick={() => {
              setShowArchived((v) => !v);
              setConfirmArchive(null);
              setError("");
            }}
          >
            {showArchived ? "Viewing archived" : "Archived"}
          </button>
        </div>

        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
                <th className="px-2 py-2.5">Name</th>
                <th className="px-2 py-2.5">SKU</th>
                <th className="px-2 py-2.5">Unit</th>
                <th className="px-2 py-2.5">Cost</th>
                <th className="px-2 py-2.5">Price</th>
                <th className="px-2 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {products.data?.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`cursor-pointer transition-colors ${
                    selectedId === p.id ? "bg-brand-50" : "hover:bg-slate-50"
                  }`}
                >
                  <td className="px-2 py-2.5 text-slate-800">{p.name}</td>
                  <td className="px-2 py-2.5 text-slate-500">{p.sku ?? "—"}</td>
                  <td className="px-2 py-2.5 text-slate-500">{p.base_unit_code}</td>
                  <td className="px-2 py-2.5 text-slate-500">{p.cost_price}</td>
                  <td className="px-2 py-2.5 font-medium text-slate-800">{p.selling_price}</td>
                  <td className="px-2 py-2.5">
                    <div className="flex gap-1.5 whitespace-nowrap">
                      {!showArchived && (
                        <button
                          type="button"
                          className="btn-secondary !py-1 !px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(p);
                          }}
                        >
                          Edit
                        </button>
                      )}
                      {showArchived ? (
                        <button
                          type="button"
                          className="btn-secondary !py-1 !px-2.5 text-xs"
                          disabled={restore.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            restore.mutate(p.id);
                          }}
                        >
                          {restore.isPending && restore.variables === p.id ? "Restoring…" : "Restore"}
                        </button>
                      ) : (
                        <>
                      {/* An in-app confirm, not window.confirm(): the webview
                          this runs in does not implement the native dialog, so
                          confirm() returned false immediately and the button
                          did nothing at all. */}
                      {confirmArchive === p.id ? (
                        <>
                          <button
                            type="button"
                            className="btn-danger !py-1 !px-2.5 text-xs"
                            disabled={archive.isPending}
                            onClick={(e) => {
                              e.stopPropagation();
                              archive.mutate(p.id);
                            }}
                          >
                            {archive.isPending ? "Archiving…" : "Confirm"}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary !py-1 !px-2.5 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmArchive(null);
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn-danger !py-1 !px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmArchive(p.id);
                          }}
                        >
                          Archive
                        </button>
                      )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {products.data?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-10 text-center text-slate-400">
                    {showArchived ? "Nothing archived." : "No products found."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <div className="card p-6">
          <h2 className="mb-4 text-sm font-semibold text-brand-700">
            {editing ? `Edit: ${editing.name}` : "New Product"}
          </h2>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <input
              className="field"
              placeholder="Name *"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-3">
              <input
                className="field"
                placeholder="SKU"
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
              <input
                className="field"
                placeholder="Barcode"
                value={form.barcode}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <select
                className="select"
                value={form.category_id ?? ""}
                onChange={(e) =>
                  setForm({ ...form, category_id: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">Category…</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <select
                className="select"
                value={form.brand_id ?? ""}
                onChange={(e) => setForm({ ...form, brand_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Brand…</option>
                {brands.data?.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <select
              className="select"
              required
              value={form.base_unit_id || ""}
              onChange={(e) => setForm({ ...form, base_unit_id: Number(e.target.value) })}
            >
              <option value="" disabled>Base unit *…</option>
              {unitList.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <input
                className="field"
                type="number" step="0.01" min="0"
                placeholder="Cost price"
                value={form.cost_price}
                onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
              />
              <input
                className="field"
                type="number" step="0.01" min="0"
                placeholder="Selling price"
                value={form.selling_price}
                onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
              />
            </div>
            <label className="col-span-2 block">
              <span className="label">Low stock threshold *</span>
              <input
                className="field mt-1"
                type="number" step="0.001" min="0"
                required
                placeholder="0"
                value={form.low_stock_at}
                onChange={(e) => setForm({ ...form, low_stock_at: e.target.value })}
              />
              <span className="mt-1 block text-xs text-slate-400">
                Warn on the inventory screen when stock falls to this. 0 to never warn.
              </span>
            </label>

            {/* Bags and the like: sold with almost every order, so they get a
                button on the till rather than a trip through the product grid. */}
            <label className="col-span-2 flex items-center gap-2.5 rounded-xl border border-slate-200 px-3.5 py-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600"
                checked={form.quick_add}
                onChange={(e) => setForm({ ...form, quick_add: e.target.checked })}
              />
              <span className="text-sm text-slate-700">Quick-add button on the till</span>
              {form.quick_add && (
                <input
                  className="ml-auto w-20 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-700"
                  type="number"
                  step="1"
                  placeholder="Order"
                  aria-label="Quick-add button order"
                  value={form.sort_order}
                  onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })}
                />
              )}
            </label>

            {error && <p className="text-sm text-amber-600">{error}</p>}

            <div className="flex gap-2 pt-1">
              <button type="submit" className="btn-primary flex-1" disabled={save.isPending}>
                {save.isPending ? "Saving…" : editing ? "Save changes" : "Add product"}
              </button>
              {editing && (
                <button type="button" className="btn-secondary" onClick={cancelEdit}>
                  Cancel
                </button>
              )}
            </div>
          </form>

          <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-400">
            Categories, brands and units are managed under{" "}
            <Link className="text-brand-600 hover:underline" to="/master-entries">
              Master Entries
            </Link>
            .
          </p>
        </div>

        {detail.data && (
          <ProductExtras
            productId={detail.data.id}
            detail={detail.data}
            units={unitList}
            onChange={invalidate}
          />
        )}
      </div>
    </div>
  );
}


function ProductExtras({
  detail,
  units,
  onChange,
}: {
  productId: number;
  detail: import("../api").ProductDetail;
  units: import("../api").Unit[];
  onChange: () => void;
}) {
  const [unitId, setUnitId] = useState("");
  const [factor, setFactor] = useState("");
  const [tierKind, setTierKind] = useState<"retail" | "wholesale">("wholesale");
  const [tierUnitId, setTierUnitId] = useState("");
  const [tierMinQty, setTierMinQty] = useState("");
  const [tierPrice, setTierPrice] = useState("");

  return (
    <div className="card p-6">
      <h2 className="mb-4 text-sm font-semibold text-brand-700">Units &amp; Price Tiers</h2>

      <h3 className="label mb-2">Alternate units</h3>
      <ul className="mb-3 space-y-1 text-sm text-slate-600">
        {detail.units.map((u) => (
          <li key={u.id}>
            1 {u.unit_code} = {u.factor} {detail.base_unit_code}
            {u.barcode && <span className="text-slate-400"> · barcode {u.barcode}</span>}
          </li>
        ))}
        {detail.units.length === 0 && <li className="text-slate-400">None yet.</li>}
      </ul>
      <form
        className="grid grid-cols-[1fr_1fr_auto] gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!unitId || !factor) return;
          await api.setProductUnit(detail.id, { unit_id: Number(unitId), factor, barcode: null });
          setUnitId("");
          setFactor("");
          onChange();
        }}
      >
        <select className="select" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">Unit…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.code}</option>
          ))}
        </select>
        <input
          className="field"
          type="number" step="0.001" min="0"
          placeholder={`= ? ${detail.base_unit_code}`}
          value={factor}
          onChange={(e) => setFactor(e.target.value)}
        />
        <button type="submit" className="btn-secondary">Add</button>
      </form>

      <h3 className="label mb-2 mt-5">Price tiers</h3>
      <ul className="mb-3 space-y-1 text-sm text-slate-600">
        {detail.price_tiers.map((t) => (
          <li key={t.id}>
            {t.kind} · {t.min_qty}+ {t.unit_code} → {t.price}
          </li>
        ))}
        {detail.price_tiers.length === 0 && <li className="text-slate-400">None yet.</li>}
      </ul>
      <form
        className="grid grid-cols-2 gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!tierUnitId || !tierPrice) return;
          await api.setPriceTier(detail.id, {
            unit_id: Number(tierUnitId),
            kind: tierKind,
            min_qty: tierMinQty || "0",
            price: tierPrice,
          });
          setTierMinQty("");
          setTierPrice("");
          onChange();
        }}
      >
        <select className="select" value={tierKind} onChange={(e) => setTierKind(e.target.value as "retail" | "wholesale")}>
          <option value="retail">Retail</option>
          <option value="wholesale">Wholesale</option>
        </select>
        <select className="select" value={tierUnitId} onChange={(e) => setTierUnitId(e.target.value)}>
          <option value="">Unit…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.code}</option>
          ))}
        </select>
        <input
          className="field"
          type="number" step="0.001" min="0"
          placeholder="Min qty"
          value={tierMinQty}
          onChange={(e) => setTierMinQty(e.target.value)}
        />
        <input
          className="field"
          type="number" step="0.01" min="0"
          placeholder="Price"
          value={tierPrice}
          onChange={(e) => setTierPrice(e.target.value)}
        />
        <button type="submit" className="btn-secondary col-span-2">Add tier</button>
      </form>
    </div>
  );
}
