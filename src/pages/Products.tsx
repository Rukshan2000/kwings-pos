import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { api, Product } from "../api";
import Pagination, { paginate } from "../components/Pagination";

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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [extrasOpen, setExtrasOpen] = useState(false);
  const [priceOptionsOpen, setPriceOptionsOpen] = useState(false);
  const [page, setPage] = useState(1);

  const products = useQuery({
    queryKey: ["products", search, showArchived],
    queryFn: () => api.products(search || undefined, showArchived),
  });
  const { pageItems, totalPages, safePage } = paginate(products.data ?? [], page, 15);
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
      setFormOpen(false);
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
    setFormOpen(true);
  };

  const openNewForm = () => {
    setEditing(null);
    setForm(emptyForm);
    setError("");
    setFormOpen(true);
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(emptyForm);
    setError("");
    setFormOpen(false);
  };

  const unitList = units.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="card p-6">
        <div className="mb-4 flex items-center gap-3">
          <input
            className="field"
            placeholder={t("products.searchPlaceholder")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          {/* Archiving hides a product; this is where it went. Nothing is ever
              deleted, so anything listed here can come straight back. */}
          <button
            type="button"
            className={`shrink-0 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-colors ${
              showArchived
                ? "bg-slate-900 dark:bg-brand-600 text-white"
                : "border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            }`}
            onClick={() => {
              setShowArchived((v) => !v);
              setConfirmArchive(null);
              setError("");
              setPage(1);
            }}
          >
            {showArchived ? t("products.viewingArchived") : t("products.archived")}
          </button>
          <button type="button" className="btn-primary shrink-0" onClick={openNewForm}>
            {t("products.newProduct")}
          </button>
        </div>

        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
                <th className="px-2 py-2.5">{t("products.name")}</th>
                <th className="px-2 py-2.5">{t("products.sku")}</th>
                <th className="px-2 py-2.5">{t("products.unit")}</th>
                <th className="px-2 py-2.5">{t("products.cost")}</th>
                <th className="px-2 py-2.5">{t("products.price")}</th>
                <th className="px-2 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {pageItems.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => setSelectedId(p.id)}
                  className={`cursor-pointer transition-colors ${
                    selectedId === p.id ? "bg-brand-50" : "hover:bg-slate-50 dark:hover:bg-slate-800"
                  }`}
                >
                  <td className="px-2 py-2.5 text-slate-800 dark:text-slate-100">{p.name}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{p.sku ?? "—"}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{p.base_unit_code}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{p.cost_price}</td>
                  <td className="px-2 py-2.5 font-medium text-slate-800 dark:text-slate-100">{p.selling_price}</td>
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
                          {t("common.edit")}
                        </button>
                      )}
                      {!showArchived && (
                        <button
                          type="button"
                          className="btn-secondary !py-1 !px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(p.id);
                            setExtrasOpen(true);
                          }}
                        >
                          {t("products.unitsAndPrices")}
                        </button>
                      )}
                      {!showArchived && (
                        <button
                          type="button"
                          className="btn-secondary !py-1 !px-2.5 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(p.id);
                            setPriceOptionsOpen(true);
                          }}
                        >
                          {t("products.priceOptions")}
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
                          {restore.isPending && restore.variables === p.id ? t("common.restoring") : t("common.restore")}
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
                            {archive.isPending ? t("common.archiving") : t("common.confirm")}
                          </button>
                          <button
                            type="button"
                            className="btn-secondary !py-1 !px-2.5 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmArchive(null);
                            }}
                          >
                            {t("common.cancel")}
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
                          {t("common.archive")}
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
                  <td colSpan={6} className="px-2 py-10 text-center text-slate-400 dark:text-slate-500">
                    {showArchived ? t("products.nothingArchived") : t("products.noProductsFound")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          page={safePage}
          totalPages={totalPages}
          totalItems={products.data?.length ?? 0}
          pageSize={15}
          onPageChange={setPage}
        />
      </div>

      <ProductFormDialog
        open={formOpen}
        editing={editing}
        form={form}
        setForm={setForm}
        categories={categories.data ?? []}
        brands={brands.data ?? []}
        units={unitList}
        error={error}
        saving={save.isPending}
        onSubmit={() => save.mutate()}
        onClose={cancelEdit}
      />

      <ProductExtrasDialog
        open={extrasOpen}
        detail={extrasOpen ? detail.data ?? null : null}
        units={unitList}
        onChange={invalidate}
        onClose={() => setExtrasOpen(false)}
      />

      <PriceOptionsDialog
        open={priceOptionsOpen}
        detail={priceOptionsOpen ? detail.data ?? null : null}
        onChange={invalidate}
        onClose={() => setPriceOptionsOpen(false)}
      />
    </div>
  );
}


function ProductFormDialog({
  open,
  editing,
  form,
  setForm,
  categories,
  brands,
  units,
  error,
  saving,
  onSubmit,
  onClose,
}: {
  open: boolean;
  editing: Product | null;
  form: Form;
  setForm: (f: Form) => void;
  categories: { id: number; name: string }[];
  brands: { id: number; name: string }[];
  units: { id: number; name: string; code: string }[];
  error: string;
  saving: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
      aria-label={editing ? t("products.dialog.editAria", { name: editing.name }) : t("products.dialog.newAria")}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-brand-700">
            {editing ? t("products.dialog.editTitle", { name: editing.name }) : t("products.dialog.newTitle")}
          </h2>
          <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <input
            className="field"
            placeholder={t("products.dialog.namePlaceholder")}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              className="field"
              placeholder={t("products.dialog.skuPlaceholder")}
              value={form.sku}
              onChange={(e) => setForm({ ...form, sku: e.target.value })}
            />
            <input
              className="field"
              placeholder={t("products.dialog.barcodePlaceholder")}
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
              <option value="">{t("products.dialog.categoryPlaceholder")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <select
              className="select"
              value={form.brand_id ?? ""}
              onChange={(e) => setForm({ ...form, brand_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">{t("products.dialog.brandPlaceholder")}</option>
              {brands.map((b) => (
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
            <option value="" disabled>{t("products.dialog.baseUnitPlaceholder")}</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.name} ({u.code})</option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label">{t("products.dialog.costPricePlaceholder")}</span>
              <input
                className="field mt-1"
                type="number" step="0.01" min="0"
                value={form.cost_price}
                onChange={(e) => setForm({ ...form, cost_price: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="label">{t("products.dialog.sellingPricePlaceholder")}</span>
              <input
                className="field mt-1"
                type="number" step="0.01" min="0"
                value={form.selling_price}
                onChange={(e) => setForm({ ...form, selling_price: e.target.value })}
              />
            </label>
          </div>
          <label className="col-span-2 block">
            <span className="label">{t("products.dialog.lowStockThreshold")}</span>
            <input
              className="field mt-1"
              type="number" step="0.001" min="0"
              required
              placeholder="0"
              value={form.low_stock_at}
              onChange={(e) => setForm({ ...form, low_stock_at: e.target.value })}
            />
            <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">{t("products.dialog.lowStockHint")}</span>
          </label>

          {/* Bags and the like: sold with almost every order, so they get a
              button on the till rather than a trip through the product grid. */}
          <label className="col-span-2 flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-700 px-3.5 py-2.5">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-brand-600"
              checked={form.quick_add}
              onChange={(e) => setForm({ ...form, quick_add: e.target.checked })}
            />
            <span className="text-sm text-slate-700 dark:text-slate-200">{t("products.dialog.quickAddLabel")}</span>
            {form.quick_add && (
              <input
                className="ml-auto w-20 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1 text-xs text-slate-700 dark:text-slate-200"
                type="number"
                step="1"
                placeholder={t("products.dialog.orderPlaceholder")}
                aria-label={t("products.dialog.orderAria")}
                value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: Number(e.target.value) || 0 })}
              />
            )}
          </label>

          {error && <p className="text-sm text-amber-600">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button type="submit" className="btn-primary flex-1" disabled={saving}>
              {saving ? t("common.saving") : editing ? t("products.dialog.saveChanges") : t("products.dialog.addProduct")}
            </button>
            <button type="button" className="btn-secondary" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </div>
        </form>

        <p className="mt-5 border-t border-slate-100 dark:border-slate-800 pt-4 text-xs text-slate-400 dark:text-slate-500">
          <Trans
            i18nKey="products.dialog.masterEntriesNote"
            components={{
              link: <Link className="text-brand-600 hover:underline" to="/master-entries" />,
            }}
          />
        </p>
      </div>
    </div>
  );
}

function ProductExtrasDialog({
  open,
  detail,
  units,
  onChange,
  onClose,
}: {
  open: boolean;
  detail: import("../api").ProductDetail | null;
  units: import("../api").Unit[];
  onChange: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !detail) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("products.extras.aria", { name: detail.name })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-brand-700">{t("products.extras.title", { name: detail.name })}</h2>
          <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <ProductExtras detail={detail} units={units} onChange={onChange} />
      </div>
    </div>
  );
}

function ProductExtras({
  detail,
  units,
  onChange,
}: {
  detail: import("../api").ProductDetail;
  units: import("../api").Unit[];
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [unitId, setUnitId] = useState("");
  const [factor, setFactor] = useState("");
  const [tierKind, setTierKind] = useState<"retail" | "wholesale">("wholesale");
  const [tierUnitId, setTierUnitId] = useState("");
  const [tierMinQty, setTierMinQty] = useState("");
  const [tierPrice, setTierPrice] = useState("");

  return (
    <div>

      <h3 className="label mb-2">{t("products.extras.alternateUnits")}</h3>
      <ul className="mb-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {detail.units.map((u) => (
          <li key={u.id}>
            1 {u.unit_code} = {u.factor} {detail.base_unit_code}
            {u.barcode && <span className="text-slate-400 dark:text-slate-500"> · barcode {u.barcode}</span>}
          </li>
        ))}
        {detail.units.length === 0 && <li className="text-slate-400 dark:text-slate-500">{t("products.extras.noneYet")}</li>}
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
          <option value="">{t("products.extras.unitPlaceholder")}</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.code}</option>
          ))}
        </select>
        <input
          className="field"
          type="number" step="0.001" min="0"
          placeholder={t("products.extras.factorPlaceholder", { baseUnit: detail.base_unit_code })}
          value={factor}
          onChange={(e) => setFactor(e.target.value)}
        />
        <button type="submit" className="btn-secondary">{t("common.add")}</button>
      </form>

      <h3 className="label mb-2 mt-5">{t("products.extras.priceTiers")}</h3>
      <ul className="mb-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {detail.price_tiers.map((pt) => (
          <li key={pt.id}>
            {pt.kind} · {pt.min_qty}+ {pt.unit_code} → {pt.price}
          </li>
        ))}
        {detail.price_tiers.length === 0 && <li className="text-slate-400 dark:text-slate-500">{t("products.extras.noneYet")}</li>}
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
          <option value="retail">{t("products.extras.retail")}</option>
          <option value="wholesale">{t("products.extras.wholesale")}</option>
        </select>
        <select className="select" value={tierUnitId} onChange={(e) => setTierUnitId(e.target.value)}>
          <option value="">{t("products.extras.unitPlaceholder")}</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>{u.code}</option>
          ))}
        </select>
        <input
          className="field"
          type="number" step="0.001" min="0"
          placeholder={t("products.extras.minQtyPlaceholder")}
          value={tierMinQty}
          onChange={(e) => setTierMinQty(e.target.value)}
        />
        <input
          className="field"
          type="number" step="0.01" min="0"
          placeholder={t("products.extras.pricePlaceholder")}
          value={tierPrice}
          onChange={(e) => setTierPrice(e.target.value)}
        />
        <button type="submit" className="btn-secondary col-span-2">{t("products.extras.addTier")}</button>
      </form>
    </div>
  );
}

function PriceOptionsDialog({
  open,
  detail,
  onChange,
  onClose,
}: {
  open: boolean;
  detail: import("../api").ProductDetail | null;
  onChange: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !detail) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("products.priceOptionsDialog.aria", { name: detail.name })}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <div className="mb-4 flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-brand-700">{t("products.priceOptionsDialog.title", { name: detail.name })}</h2>
          <button type="button" className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
        <PriceOptions detail={detail} onChange={onChange} />
      </div>
    </div>
  );
}

function PriceOptions({
  detail,
  onChange,
}: {
  detail: import("../api").ProductDetail;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  const [optionLabel, setOptionLabel] = useState("");
  const [optionPrice, setOptionPrice] = useState("");

  return (
    <div>
      {/* Alternate prices for the same line, picked by the cashier at checkout
          rather than applied by a rule — a tier fires on quantity, this fires
          on whatever the market did today. Sale price is unaffected until this
          list has a second entry: one price is still just the product's own. */}
      <p className="mb-2 text-xs text-slate-400 dark:text-slate-500">{t("products.priceOptionsDialog.hint")}</p>
      <ul className="mb-3 space-y-1 text-sm text-slate-600 dark:text-slate-300">
        {detail.price_options.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-2">
            <span>
              {o.label} — {o.price}
            </span>
            <button
              type="button"
              className="text-xs text-slate-400 dark:text-slate-500 hover:text-amber-600"
              onClick={async () => {
                await api.deletePriceOption(detail.id, o.id);
                onChange();
              }}
            >
              {t("products.priceOptionsDialog.remove")}
            </button>
          </li>
        ))}
        {detail.price_options.length === 0 && <li className="text-slate-400 dark:text-slate-500">{t("products.priceOptionsDialog.noneYet")}</li>}
      </ul>
      <form
        className="grid grid-cols-[1fr_auto_auto] gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!optionLabel.trim() || !optionPrice) return;
          await api.setPriceOption(detail.id, null, {
            label: optionLabel.trim(),
            price: optionPrice,
            sort_order: detail.price_options.length,
          });
          setOptionLabel("");
          setOptionPrice("");
          onChange();
        }}
      >
        <input
          className="field"
          placeholder={t("products.priceOptionsDialog.labelPlaceholder")}
          value={optionLabel}
          onChange={(e) => setOptionLabel(e.target.value)}
        />
        <input
          className="field w-28"
          type="number" step="0.01" min="0"
          placeholder={t("products.priceOptionsDialog.pricePlaceholder")}
          value={optionPrice}
          onChange={(e) => setOptionPrice(e.target.value)}
        />
        <button type="submit" className="btn-secondary">{t("common.add")}</button>
      </form>
    </div>
  );
}
