import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, Product, ProductInput } from "../api";

const emptyForm: ProductInput = {
  sku: "",
  barcode: "",
  name: "",
  category_id: null,
  brand_id: null,
  base_unit_id: 0,
  cost_price: "0",
  selling_price: "0",
  low_stock_at: "",
};

export default function Products() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<ProductInput>(emptyForm);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const products = useQuery({
    queryKey: ["products", search],
    queryFn: () => api.products(search || undefined),
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
    mutationFn: () =>
      editing ? api.updateProduct(editing.id, form) : api.createProduct(form),
    onSuccess: () => {
      invalidate();
      setEditing(null);
      setForm(emptyForm);
      setError("");
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const archive = useMutation({
    mutationFn: (id: number) => api.archiveProduct(id),
    onSuccess: invalidate,
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
      low_stock_at: p.low_stock_at ?? "",
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(emptyForm);
    setError("");
  };

  const unitList = units.data ?? [];

  return (
    <div className="products">
      <div className="products-list">
        <div className="products-search">
          <input
            placeholder="Search by name, SKU or scan a barcode…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>SKU</th>
              <th>Unit</th>
              <th>Cost</th>
              <th>Price</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {products.data?.map((p) => (
              <tr
                key={p.id}
                className={selectedId === p.id ? "row-selected" : ""}
                onClick={() => setSelectedId(p.id)}
              >
                <td>{p.name}</td>
                <td>{p.sku ?? "—"}</td>
                <td>{p.base_unit_code}</td>
                <td>{p.cost_price}</td>
                <td>{p.selling_price}</td>
                <td className="table-actions">
                  <button type="button" onClick={(e) => { e.stopPropagation(); startEdit(p); }}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Archive "${p.name}"?`)) archive.mutate(p.id);
                    }}
                  >
                    Archive
                  </button>
                </td>
              </tr>
            ))}
            {products.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">No products found.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="products-side">
        <div className="pane">
          <h2>{editing ? `Edit: ${editing.name}` : "New Product"}</h2>

          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            <input
              placeholder="Name *"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="row2">
              <input
                placeholder="SKU"
                value={form.sku ?? ""}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
              />
              <input
                placeholder="Barcode"
                value={form.barcode ?? ""}
                onChange={(e) => setForm({ ...form, barcode: e.target.value })}
              />
            </div>
            <div className="row2">
              <select
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
                value={form.brand_id ?? ""}
                onChange={(e) =>
                  setForm({ ...form, brand_id: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">Brand…</option>
                {brands.data?.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </div>
            <select
              required
              value={form.base_unit_id || ""}
              onChange={(e) => setForm({ ...form, base_unit_id: Number(e.target.value) })}
            >
              <option value="" disabled>Base unit *…</option>
              {unitList.map((u) => (
                <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
              ))}
            </select>
            <div className="row2">
              <input
                type="number" step="0.01" min="0"
                placeholder="Cost price"
                value={form.cost_price}
                onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
              />
              <input
                type="number" step="0.01" min="0"
                placeholder="Selling price"
                value={form.selling_price}
                onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
              />
            </div>
            <input
              type="number" step="0.001" min="0"
              placeholder="Low stock threshold (optional)"
              value={form.low_stock_at ?? ""}
              onChange={(e) => setForm({ ...form, low_stock_at: e.target.value })}
            />

            {error && <p className="warn">{error}</p>}

            <div className="row2">
              <button type="submit" className="primary" disabled={save.isPending}>
                {save.isPending ? "Saving…" : editing ? "Save changes" : "Add product"}
              </button>
              {editing && (
                <button type="button" onClick={cancelEdit}>Cancel</button>
              )}
            </div>
          </form>

          <QuickAdd
            label="New category"
            onAdd={(name) =>
              api.createCategory(name).then(() => qc.invalidateQueries({ queryKey: ["categories"] }))
            }
          />
          <QuickAdd
            label="New brand"
            onAdd={(name) =>
              api.createBrand(name).then(() => qc.invalidateQueries({ queryKey: ["brands"] }))
            }
          />
        </div>

        {detail.data && <ProductExtras productId={detail.data.id} detail={detail.data} units={unitList} onChange={invalidate} />}
      </div>
    </div>
  );
}

function QuickAdd({ label, onAdd }: { label: string; onAdd: (name: string) => Promise<unknown> }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="quick-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setBusy(true);
        try {
          await onAdd(value.trim());
          setValue("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input placeholder={label} value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="submit" disabled={busy}>Add</button>
    </form>
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
    <div className="pane">
      <h2>Units &amp; Price Tiers</h2>

      <h3>Alternate units</h3>
      <ul className="plain-list">
        {detail.units.map((u) => (
          <li key={u.id}>
            1 {u.unit_code} = {u.factor} {detail.base_unit_code}
            {u.barcode && <span className="hint"> · barcode {u.barcode}</span>}
          </li>
        ))}
        {detail.units.length === 0 && <li className="hint">None yet.</li>}
      </ul>
      <form
        className="row2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!unitId || !factor) return;
          await api.setProductUnit(detail.id, {
            unit_id: Number(unitId),
            factor,
            barcode: null,
          });
          setUnitId("");
          setFactor("");
          onChange();
        }}
      >
        <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
          <option value="">Unit…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.code}</option>
          ))}
        </select>
        <input
          type="number" step="0.001" min="0"
          placeholder={`= ? ${detail.base_unit_code}`}
          value={factor}
          onChange={(e) => setFactor(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>

      <h3>Price tiers</h3>
      <ul className="plain-list">
        {detail.price_tiers.map((t) => (
          <li key={t.id}>
            {t.kind} · {t.min_qty}+ {t.unit_code} → {t.price}
          </li>
        ))}
        {detail.price_tiers.length === 0 && <li className="hint">None yet.</li>}
      </ul>
      <form
        className="row2"
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
        <select value={tierKind} onChange={(e) => setTierKind(e.target.value as "retail" | "wholesale")}>
          <option value="retail">Retail</option>
          <option value="wholesale">Wholesale</option>
        </select>
        <select value={tierUnitId} onChange={(e) => setTierUnitId(e.target.value)}>
          <option value="">Unit…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.code}</option>
          ))}
        </select>
        <input
          type="number" step="0.001" min="0"
          placeholder="Min qty"
          value={tierMinQty}
          onChange={(e) => setTierMinQty(e.target.value)}
        />
        <input
          type="number" step="0.01" min="0"
          placeholder="Price"
          value={tierPrice}
          onChange={(e) => setTierPrice(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>
    </div>
  );
}
