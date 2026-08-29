import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { lkr } from "../types";

type Tab = "units" | "categories" | "brands" | "suppliers" | "loyalty";

const TABS: Tab[] = ["units", "categories", "brands", "suppliers", "loyalty"];

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
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("units");
  const [status, setStatus] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const units = useQuery({ queryKey: ["units"], queryFn: api.units });
  const categories = useQuery({ queryKey: ["categories"], queryFn: api.categories });
  const brands = useQuery({ queryKey: ["brands"], queryFn: api.brands });
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: api.suppliers });
  const customers = useQuery({ queryKey: ["customers"], queryFn: api.customers });
  const loyaltySetting = useQuery({ queryKey: ["loyaltySetting"], queryFn: api.loyaltySetting });

  const counts: Record<Tab, number | undefined> = {
    units: units.data?.length,
    categories: categories.data?.length,
    brands: brands.data?.length,
    suppliers: suppliers.data?.length,
    loyalty: customers.data?.length,
  };

  // The three write paths differ only in what they call and what they refresh.
  const added = (key: string, entity: string) => ({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [key] });
      setStatus(t("masterEntries.added", { what: t(`masterEntries.entities.${entity}`) }));
    },
    onError: (e: unknown) => setStatus(e instanceof Error ? e.message : String(e)),
  });

  const addUnit = useMutation({
    mutationFn: ({ code, name }: { code: string; name: string }) => api.createUnit(code, name),
    ...added("units", "unit"),
  });
  const addCategory = useMutation({
    mutationFn: ({ name, color }: { name: string; color: string | null }) => api.createCategory(name, color),
    ...added("categories", "category"),
  });
  const setCategoryColor = useMutation({
    mutationFn: ({ id, color }: { id: number; color: string | null }) => api.updateCategoryColor(id, color),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["categories"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
  const addBrand = useMutation({
    mutationFn: (name: string) => api.createBrand(name),
    ...added("brands", "brand"),
  });
  const addSupplier = useMutation({
    mutationFn: (input: { name: string; phone: string | null; address: string | null }) =>
      api.createSupplier(input),
    ...added("suppliers", "supplier"),
  });
  const addCustomer = useMutation({
    mutationFn: ({ name, phone }: { name: string; phone: string | null }) =>
      api.createCustomer(name, phone),
    ...added("customers", "customer"),
  });

  const saveLoyaltySetting = useMutation({
    mutationFn: (input: { earn_amount_lkr: string; earn_points: string; redeem_value_per_point: string }) =>
      api.updateLoyaltySetting(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["loyaltySetting"] });
      setStatus(t("masterEntries.loyaltySaved"));
    },
    onError: (e: unknown) => setStatus(e instanceof Error ? e.message : String(e)),
  });

  // The four delete paths differ only in what they call and what they refresh.
  const removed = (key: string, entity: string) => ({
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [key] });
      setStatus(t("masterEntries.removed", { what: t(`masterEntries.entities.${entity}`) }));
      setConfirmDelete(null);
    },
    onError: (e: unknown) => setStatus(e instanceof Error ? e.message : String(e)),
  });

  const deleteUnit = useMutation({
    mutationFn: (id: number) => api.archiveUnit(id),
    ...removed("units", "unit"),
  });
  const deleteCategory = useMutation({
    mutationFn: (id: number) => api.archiveCategory(id),
    ...removed("categories", "category"),
  });
  const deleteBrand = useMutation({
    mutationFn: (id: number) => api.archiveBrand(id),
    ...removed("brands", "brand"),
  });
  const deleteSupplier = useMutation({
    mutationFn: (id: number) => api.archiveSupplier(id),
    ...removed("suppliers", "supplier"),
  });
  const deleteCustomer = useMutation({
    mutationFn: (id: number) => api.archiveCustomer(id),
    ...removed("customers", "customer"),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">{t("masterEntries.title")}</h1>
        <p className="text-sm text-slate-500">{t("masterEntries.subtitle")}</p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("masterEntries.tabsAria")}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setStatus("");
              setConfirmDelete(null);
            }}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? "bg-slate-900 text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {t(`masterEntries.tabs.${id}.label`)}
            {counts[id] !== undefined && (
              <span className={`ml-1.5 text-xs ${tab === id ? "text-slate-300" : "text-slate-400"}`}>
                {counts[id]}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="card max-w-3xl p-5">
        <p className="mb-4 text-xs text-slate-400">{t(`masterEntries.tabs.${tab}.hint`)}</p>

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
              <input className="field w-28" name="code" placeholder={t("masterEntries.codePlaceholder")} aria-label={t("masterEntries.codeAria")} />
              <input className="field" name="name" placeholder={t("masterEntries.namePlaceholder")} aria-label={t("masterEntries.nameAria")} />
              <button type="submit" className="btn-secondary shrink-0" disabled={addUnit.isPending}>
                {t("common.add")}
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
              confirmDelete={confirmDelete}
              onConfirmDelete={setConfirmDelete}
              onDelete={(id) => deleteUnit.mutate(id)}
              deleting={deleteUnit.isPending ? deleteUnit.variables : undefined}
            />
          </>
        )}

        {tab === "categories" && (
          <>
            <CategoryForm
              placeholder={t("masterEntries.newCategoryPlaceholder")}
              busy={addCategory.isPending}
              onAdd={(name, color) => addCategory.mutate({ name, color })}
            />
            <Rows
              empty={categories.data?.length === 0}
              rows={categories.data?.map((c) => ({
                id: c.id,
                left: (
                  <span className="flex items-center gap-2">
                    <span
                      className="h-3.5 w-3.5 shrink-0 rounded-full border border-slate-200"
                      style={{ backgroundColor: c.color ?? "#cbd5e1" }}
                    />
                    {c.name}
                  </span>
                ),
                right: (
                  <input
                    type="color"
                    className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
                    value={c.color ?? "#cbd5e1"}
                    aria-label={t("masterEntries.categoryColorAria")}
                    onChange={(e) => setCategoryColor.mutate({ id: c.id, color: e.target.value })}
                  />
                ),
              }))}
              confirmDelete={confirmDelete}
              onConfirmDelete={setConfirmDelete}
              onDelete={(id) => deleteCategory.mutate(id)}
              deleting={deleteCategory.isPending ? deleteCategory.variables : undefined}
            />
          </>
        )}

        {tab === "brands" && (
          <>
            <NameForm placeholder={t("masterEntries.newBrandPlaceholder")} busy={addBrand.isPending} onAdd={(name) => addBrand.mutate(name)} />
            <Rows
              empty={brands.data?.length === 0}
              rows={brands.data?.map((b) => ({ id: b.id, left: b.name }))}
              confirmDelete={confirmDelete}
              onConfirmDelete={setConfirmDelete}
              onDelete={(id) => deleteBrand.mutate(id)}
              deleting={deleteBrand.isPending ? deleteBrand.variables : undefined}
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
              <input className="field" name="name" placeholder={t("masterEntries.supplierNamePlaceholder")} aria-label={t("masterEntries.supplierNameAria")} />
              <input className="field" name="phone" placeholder={t("masterEntries.phonePlaceholder")} aria-label={t("masterEntries.phoneAria")} />
              <input className="field" name="address" placeholder={t("masterEntries.addressPlaceholder")} aria-label={t("masterEntries.addressAria")} />
              <button type="submit" className="btn-secondary shrink-0" disabled={addSupplier.isPending}>
                {t("common.add")}
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
                      {lkr(Number(s.outstanding))} {t("masterEntries.owed")}
                    </span>
                  ) : undefined,
              }))}
              confirmDelete={confirmDelete}
              onConfirmDelete={setConfirmDelete}
              onDelete={(id) => deleteSupplier.mutate(id)}
              deleting={deleteSupplier.isPending ? deleteSupplier.variables : undefined}
            />
          </>
        )}

        {tab === "loyalty" && (
          <>
            <form
              className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
                if (!value("earn_amount_lkr") || !value("earn_points") || !value("redeem_value_per_point")) return;
                saveLoyaltySetting.mutate({
                  earn_amount_lkr: value("earn_amount_lkr"),
                  earn_points: value("earn_points"),
                  redeem_value_per_point: value("redeem_value_per_point"),
                });
              }}
            >
              <label className="block">
                <span className="label mb-1 block text-xs">{t("masterEntries.loyaltyEarnAmountLabel")}</span>
                <input
                  className="field"
                  name="earn_amount_lkr"
                  type="number"
                  step="0.01"
                  min="0.01"
                  defaultValue={loyaltySetting.data?.earn_amount_lkr}
                  key={`earn_amount_lkr-${loyaltySetting.data?.earn_amount_lkr}`}
                  aria-label={t("masterEntries.loyaltyEarnAmountLabel")}
                />
              </label>
              <label className="block">
                <span className="label mb-1 block text-xs">{t("masterEntries.loyaltyEarnPointsLabel")}</span>
                <input
                  className="field"
                  name="earn_points"
                  type="number"
                  step="0.01"
                  min="0.01"
                  defaultValue={loyaltySetting.data?.earn_points}
                  key={`earn_points-${loyaltySetting.data?.earn_points}`}
                  aria-label={t("masterEntries.loyaltyEarnPointsLabel")}
                />
              </label>
              <label className="block">
                <span className="label mb-1 block text-xs">{t("masterEntries.loyaltyRedeemValueLabel")}</span>
                <input
                  className="field"
                  name="redeem_value_per_point"
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  defaultValue={loyaltySetting.data?.redeem_value_per_point}
                  key={`redeem_value_per_point-${loyaltySetting.data?.redeem_value_per_point}`}
                  aria-label={t("masterEntries.loyaltyRedeemValueLabel")}
                />
              </label>
              <button type="submit" className="btn-secondary shrink-0 self-end" disabled={saveLoyaltySetting.isPending}>
                {t("common.save")}
              </button>
            </form>
            <p className="mt-2 text-xs text-slate-400">{t("masterEntries.loyaltyHint")}</p>

            <div className="mt-6 border-t border-slate-100 pt-4">
              <h3 className="label mb-2">{t("masterEntries.customers")}</h3>
              <form
                className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const value = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.trim();
                  if (!value("name")) return;
                  addCustomer.mutate(
                    { name: value("name"), phone: value("phone") || null },
                    { onSuccess: () => form.reset() }
                  );
                }}
              >
                <input className="field" name="name" placeholder={t("masterEntries.customerNamePlaceholder")} aria-label={t("masterEntries.customerNamePlaceholder")} />
                <input className="field" name="phone" placeholder={t("masterEntries.phonePlaceholder")} aria-label={t("masterEntries.phoneAria")} />
                <button type="submit" className="btn-secondary shrink-0" disabled={addCustomer.isPending}>
                  {t("common.add")}
                </button>
              </form>
              <Rows
                empty={customers.data?.length === 0}
                rows={customers.data?.map((c) => ({
                  id: c.id,
                  left: (
                    <>
                      {c.name}
                      {c.phone && <span className="ml-2 text-xs text-slate-400">{c.phone}</span>}
                    </>
                  ),
                  right: (
                    <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                      {t("masterEntries.pointsBalance", { points: c.loyalty_points })}
                    </span>
                  ),
                }))}
                confirmDelete={confirmDelete}
                onConfirmDelete={setConfirmDelete}
                onDelete={(id) => deleteCustomer.mutate(id)}
                deleting={deleteCustomer.isPending ? deleteCustomer.variables : undefined}
              />
            </div>
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
  const { t } = useTranslation();
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
        {t("common.add")}
      </button>
    </form>
  );
}

const DEFAULT_CATEGORY_COLOR = "#0ea5e9";

function CategoryForm({
  placeholder,
  busy,
  onAdd,
}: {
  placeholder: string;
  busy: boolean;
  onAdd: (name: string, color: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [color, setColor] = useState(DEFAULT_CATEGORY_COLOR);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        onAdd(value.trim(), color);
        setValue("");
        setColor(DEFAULT_CATEGORY_COLOR);
      }}
    >
      <input
        type="color"
        className="h-9 w-11 shrink-0 cursor-pointer rounded border border-slate-200 bg-white p-0.5"
        value={color}
        aria-label={t("masterEntries.categoryColorAria")}
        onChange={(e) => setColor(e.target.value)}
      />
      <input
        className="field"
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className="btn-secondary shrink-0" disabled={busy}>
        {t("common.add")}
      </button>
    </form>
  );
}

function Rows({
  rows,
  empty,
  confirmDelete,
  onConfirmDelete,
  onDelete,
  deleting,
}: {
  rows?: { id: number; left: React.ReactNode; right?: React.ReactNode }[];
  empty: boolean;
  confirmDelete?: number | null;
  onConfirmDelete?: (id: number | null) => void;
  onDelete?: (id: number) => void;
  deleting?: number;
}) {
  const { t } = useTranslation();
  return (
    <ul className="mt-4 divide-y divide-slate-100 border-t border-slate-100 text-sm">
      {rows?.map((r) => (
        <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
          <span className="min-w-0 truncate text-slate-700">{r.left}</span>
          <span className="flex shrink-0 items-center gap-2">
            {r.right}
            {onDelete &&
              (confirmDelete === r.id ? (
                <>
                  <button
                    type="button"
                    className="btn-danger !py-1 !px-2.5 text-xs"
                    disabled={deleting === r.id}
                    onClick={() => onDelete(r.id)}
                  >
                    {deleting === r.id ? t("common.deleting") : t("common.confirm")}
                  </button>
                  <button
                    type="button"
                    className="btn-secondary !py-1 !px-2.5 text-xs"
                    onClick={() => onConfirmDelete?.(null)}
                  >
                    {t("common.cancel")}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn-danger !py-1 !px-2.5 text-xs"
                  onClick={() => onConfirmDelete?.(r.id)}
                >
                  {t("common.delete")}
                </button>
              ))}
          </span>
        </li>
      ))}
      {empty && <li className="py-3 text-slate-400">{t("masterEntries.noneYet")}</li>}
    </ul>
  );
}
