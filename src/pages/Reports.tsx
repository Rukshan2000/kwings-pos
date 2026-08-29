import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useCurrentUser } from "../auth";
import Pagination, { paginate } from "../components/Pagination";
import DatePicker from "../components/DatePicker";
import { lkr } from "../types";

type Tab = "revenue" | "products" | "profit" | "payments" | "purchases" | "cashiers" | "stock";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function Reports() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const isManager = user?.role === "admin" || user?.role === "manager";
  const [tab, setTab] = useState<Tab>(isManager ? "revenue" : "cashiers");
  const [from, setFrom] = useState(daysAgoIso(29));
  const [to, setTo] = useState(todayIso());

  const tabs: { key: Tab; label: string }[] = isManager
    ? [
        { key: "revenue", label: t("reports.tabs.revenue") },
        { key: "products", label: t("reports.tabs.products") },
        { key: "profit", label: t("reports.tabs.profit") },
        { key: "payments", label: t("reports.tabs.payments") },
        { key: "purchases", label: t("reports.tabs.purchases") },
        { key: "cashiers", label: t("reports.tabs.cashiers") },
        { key: "stock", label: t("reports.tabs.stock") },
      ]
    : [{ key: "cashiers", label: t("reports.tabs.mySales") }];

  return (
    <div className="space-y-5">
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => setTab(tb.key)}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150 ${
                tab === tb.key ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
        {tab !== "stock" && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5 text-slate-500">
              {t("reports.from")}
              <DatePicker value={from} max={to} onChange={setFrom} />
            </label>
            <label className="flex items-center gap-1.5 text-slate-500">
              {t("reports.to")}
              <DatePicker value={to} min={from} max={todayIso()} onChange={setTo} />
            </label>
          </div>
        )}
      </div>

      {tab === "revenue" && <RevenueTab from={from} to={to} />}
      {tab === "products" && <ProductsTab from={from} to={to} />}
      {tab === "profit" && <ProfitTab from={from} to={to} />}
      {tab === "payments" && <PaymentsTab from={from} to={to} />}
      {tab === "purchases" && <PurchasesTab from={from} to={to} />}
      {tab === "cashiers" && <CashiersTab from={from} to={to} isManager={isManager} />}
      {tab === "stock" && <StockTab />}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-800">{value}</p>
    </div>
  );
}

function RevenueTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["reports", "revenue", from, to], queryFn: () => api.revenueReport(from, to) });
  const r = q.data;
  const [page, setPage] = useState(1);
  const { pageItems, totalPages, safePage } = paginate(r?.daily ?? [], page, 15);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={t("reports.revenue.orders")} value={r ? String(r.order_count) : "…"} />
        <StatCard label={t("reports.revenue.subtotal")} value={r ? lkr(Number(r.subtotal)) : "…"} />
        <StatCard label={t("reports.revenue.discounts")} value={r ? lkr(Number(r.discount_total)) : "…"} />
        <StatCard label={t("reports.revenue.total")} value={r ? lkr(Number(r.revenue)) : "…"} />
      </div>
      <div className="card p-6 overflow-x-auto">
        <h2 className="mb-4 text-sm font-semibold text-brand-700">{t("reports.revenue.daily")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("reports.date")}</th>
              <th className="px-2 py-2.5">{t("reports.revenue.orders")}</th>
              <th className="px-2 py-2.5">{t("reports.revenue.total")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageItems.map((d) => (
              <tr key={d.day}>
                <td className="px-2 py-2.5 text-slate-800">{d.day}</td>
                <td className="px-2 py-2.5 text-slate-500">{d.order_count}</td>
                <td className="px-2 py-2.5 font-medium text-slate-800">{lkr(Number(d.revenue))}</td>
              </tr>
            ))}
            {(r?.daily.length ?? 0) === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-10 text-center text-slate-400">{t("reports.nothingToShow")}</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination page={safePage} totalPages={totalPages} totalItems={r?.daily.length ?? 0} pageSize={15} onPageChange={setPage} />
      </div>
    </div>
  );
}

function ProductsTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["reports", "products", from, to], queryFn: () => api.salesByProduct(from, to) });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return q.data ?? [];
    return (q.data ?? []).filter((row) => row.product_name.toLowerCase().includes(s));
  }, [q.data, search]);
  const { pageItems, totalPages, safePage } = paginate(filtered, page, 15);
  return (
    <div className="card p-6">
      <input
        className="field mb-4 w-64"
        placeholder={t("common.search")}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("reports.product")}</th>
              <th className="px-2 py-2.5">{t("reports.products.qtySold")}</th>
              <th className="px-2 py-2.5">{t("reports.products.revenue")}</th>
              <th className="px-2 py-2.5">{t("reports.products.cost")}</th>
              <th className="px-2 py-2.5">{t("reports.products.profit")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageItems.map((row) => (
              <tr key={row.product_id}>
                <td className="px-2 py-2.5 text-slate-800">{row.product_name}</td>
                <td className="px-2 py-2.5 text-slate-500">{row.quantity}</td>
                <td className="px-2 py-2.5 text-slate-500">{lkr(Number(row.revenue))}</td>
                <td className="px-2 py-2.5 text-slate-500">{lkr(Number(row.cost))}</td>
                <td className="px-2 py-2.5 font-medium text-emerald-600">{lkr(Number(row.profit))}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-10 text-center text-slate-400">{t("reports.nothingToShow")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={safePage} totalPages={totalPages} totalItems={filtered.length} pageSize={15} onPageChange={setPage} />
    </div>
  );
}

function ProfitTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["reports", "profit", from, to], queryFn: () => api.profitSummary(from, to) });
  const p = q.data;
  const [page, setPage] = useState(1);
  const { pageItems, totalPages, safePage } = paginate(p?.by_category ?? [], page, 15);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={t("reports.profit.revenue")} value={p ? lkr(Number(p.revenue)) : "…"} />
        <StatCard label={t("reports.profit.cost")} value={p ? lkr(Number(p.cost)) : "…"} />
        <StatCard label={t("reports.profit.profit")} value={p ? lkr(Number(p.profit)) : "…"} />
        <StatCard label={t("reports.profit.margin")} value={p ? `${Number(p.margin_pct).toFixed(2)}%` : "…"} />
      </div>
      <div className="card p-6 overflow-x-auto">
        <h2 className="mb-4 text-sm font-semibold text-brand-700">{t("reports.profit.byCategory")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("reports.profit.category")}</th>
              <th className="px-2 py-2.5">{t("reports.profit.revenue")}</th>
              <th className="px-2 py-2.5">{t("reports.profit.cost")}</th>
              <th className="px-2 py-2.5">{t("reports.profit.profit")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageItems.map((c) => (
              <tr key={c.category_name}>
                <td className="px-2 py-2.5 text-slate-800">{c.category_name}</td>
                <td className="px-2 py-2.5 text-slate-500">{lkr(Number(c.revenue))}</td>
                <td className="px-2 py-2.5 text-slate-500">{lkr(Number(c.cost))}</td>
                <td className="px-2 py-2.5 font-medium text-emerald-600">{lkr(Number(c.profit))}</td>
              </tr>
            ))}
            {(p?.by_category.length ?? 0) === 0 && (
              <tr>
                <td colSpan={4} className="px-2 py-10 text-center text-slate-400">{t("reports.nothingToShow")}</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination page={safePage} totalPages={totalPages} totalItems={p?.by_category.length ?? 0} pageSize={15} onPageChange={setPage} />
      </div>
    </div>
  );
}

function PaymentsTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["reports", "payments", from, to], queryFn: () => api.paymentBreakdown(from, to) });
  const [page, setPage] = useState(1);
  const { pageItems, totalPages, safePage } = paginate(q.data ?? [], page, 15);
  return (
    <div className="card p-6">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("reports.payments.method")}</th>
              <th className="px-2 py-2.5">{t("reports.payments.count")}</th>
              <th className="px-2 py-2.5">{t("reports.payments.total")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageItems.map((row) => (
              <tr key={row.method}>
                <td className="px-2 py-2.5 text-slate-800 capitalize">{row.method.replace("_", " ")}</td>
                <td className="px-2 py-2.5 text-slate-500">{row.order_count}</td>
                <td className="px-2 py-2.5 font-medium text-slate-800">{lkr(Number(row.total))}</td>
              </tr>
            ))}
            {(q.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-10 text-center text-slate-400">{t("reports.nothingToShow")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={safePage} totalPages={totalPages} totalItems={q.data?.length ?? 0} pageSize={15} onPageChange={setPage} />
    </div>
  );
}

function PurchasesTab({ from, to }: { from: string; to: string }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["reports", "purchases", from, to], queryFn: () => api.purchasesReport(from, to) });
  const p = q.data;
  const [page, setPage] = useState(1);
  const { pageItems, totalPages, safePage } = paginate(p?.by_supplier ?? [], page, 15);
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={t("reports.purchases.count")} value={p ? String(p.purchase_count) : "…"} />
        <StatCard label={t("reports.purchases.total")} value={p ? lkr(Number(p.total)) : "…"} />
        <StatCard label={t("reports.purchases.paid")} value={p ? lkr(Number(p.paid)) : "…"} />
        <StatCard label={t("reports.purchases.outstanding")} value={p ? lkr(Number(p.outstanding)) : "…"} />
      </div>
      <div className="card p-6 overflow-x-auto">
        <h2 className="mb-4 text-sm font-semibold text-brand-700">{t("reports.purchases.bySupplier")}</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("reports.purchases.supplier")}</th>
              <th className="px-2 py-2.5">{t("reports.purchases.count")}</th>
              <th className="px-2 py-2.5">{t("reports.purchases.total")}</th>
              <th className="px-2 py-2.5">{t("reports.purchases.paid")}</th>
              <th className="px-2 py-2.5">{t("reports.purchases.outstanding")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageItems.map((s) => (
              <tr key={s.supplier_id}>
                <td className="px-2 py-2.5 text-slate-800">{s.supplier_name}</td>
                <td className="px-2 py-2.5 text-slate-500">{s.purchase_count}</td>
                <td className="px-2 py-2.5 text-slate-500">{lkr(Number(s.total))}</td>
                <td className="px-2 py-2.5 text-slate-500">{lkr(Number(s.paid))}</td>
                <td className={`px-2 py-2.5 font-medium ${Number(s.outstanding) > 0 ? "text-amber-600" : "text-slate-800"}`}>
                  {lkr(Number(s.outstanding))}
                </td>
              </tr>
            ))}
            {(p?.by_supplier.length ?? 0) === 0 && (
              <tr>
                <td colSpan={5} className="px-2 py-10 text-center text-slate-400">{t("reports.nothingToShow")}</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pagination page={safePage} totalPages={totalPages} totalItems={p?.by_supplier.length ?? 0} pageSize={15} onPageChange={setPage} />
      </div>
    </div>
  );
}

function CashiersTab({ from, to, isManager }: { from: string; to: string; isManager: boolean }) {
  const { t } = useTranslation();
  const byCashier = useQuery({
    queryKey: ["reports", "sales-by-cashier", from, to],
    queryFn: () => api.salesByCashier(from, to),
    enabled: isManager,
  });
  const mine = useQuery({
    queryKey: ["reports", "my-sales", from, to],
    queryFn: () => api.mySales(from, to),
    enabled: !isManager,
  });
  const [page, setPage] = useState(1);
  const { pageItems, totalPages, safePage } = paginate(byCashier.data ?? [], page, 15);

  if (!isManager) {
    const m = mine.data;
    return (
      <div className="grid grid-cols-2 gap-3">
        <StatCard label={t("reports.revenue.orders")} value={m ? String(m.order_count) : "…"} />
        <StatCard label={t("reports.revenue.total")} value={m ? lkr(Number(m.revenue)) : "…"} />
      </div>
    );
  }

  return (
    <div className="card p-6">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
              <th className="px-2 py-2.5">{t("reports.cashiers.cashier")}</th>
              <th className="px-2 py-2.5">{t("reports.revenue.orders")}</th>
              <th className="px-2 py-2.5">{t("reports.revenue.total")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {pageItems.map((row) => (
              <tr key={row.cashier_id ?? "unassigned"}>
                <td className="px-2 py-2.5 text-slate-800">{row.cashier_name}</td>
                <td className="px-2 py-2.5 text-slate-500">{row.order_count}</td>
                <td className="px-2 py-2.5 font-medium text-slate-800">{lkr(Number(row.revenue))}</td>
              </tr>
            ))}
            {(byCashier.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-10 text-center text-slate-400">{t("reports.nothingToShow")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={safePage} totalPages={totalPages} totalItems={byCashier.data?.length ?? 0} pageSize={15} onPageChange={setPage} />
    </div>
  );
}

function StockTab() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["reports", "stock-summary"], queryFn: api.stockSummary });
  const s = q.data;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label={t("reports.stock.products")} value={s ? String(s.product_count) : "…"} />
        <StatCard label={t("reports.stock.lowStock")} value={s ? String(s.low_stock_count) : "…"} />
        <StatCard label={t("reports.stock.value")} value={s ? lkr(Number(s.total_on_hand_value)) : "…"} />
      </div>
      <p className="text-sm text-slate-500">{t("reports.stock.detailHint")}</p>
    </div>
  );
}
