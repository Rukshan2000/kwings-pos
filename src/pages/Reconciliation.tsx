import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, DailyReconciliation } from "../api";
import { useCurrentUser } from "../auth";
import DatePicker from "../components/DatePicker";
import Pagination, { paginate } from "../components/Pagination";
import { lkr } from "../types";

const DENOMINATIONS = [5000, 2000, 1000, 500, 100, 50, 20, 10, 5, 2, 1];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoIso(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function denominationsTotal(counts: Record<number, string>) {
  return DENOMINATIONS.reduce((sum, v) => sum + v * (Number(counts[v]) || 0), 0);
}

function DenominationGrid({
  counts,
  onChange,
}: {
  counts: Record<number, string>;
  onChange: (counts: Record<number, string>) => void;
}) {
  const step = (v: number, delta: number) => {
    const next = Math.max(0, (Number(counts[v]) || 0) + delta);
    onChange({ ...counts, [v]: String(next) });
  };

  return (
    <div className="grid grid-cols-3 gap-3">
      {DENOMINATIONS.map((v) => (
        <div key={v} className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2 py-1.5">
          <span className="w-14 shrink-0 text-sm font-medium text-slate-600 dark:text-slate-300">{v}</span>
          <button
            type="button"
            className="h-7 w-7 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 active:bg-slate-200"
            onClick={() => step(v, -1)}
          >
            −
          </button>
          <input
            type="number" min="0" step="1"
            className="field !w-16 shrink-0 !px-2 !py-1 text-right"
            value={counts[v] ?? ""}
            onChange={(e) => onChange({ ...counts, [v]: e.target.value })}
            placeholder="0"
          />
          <button
            type="button"
            className="h-7 w-7 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 active:bg-slate-200"
            onClick={() => step(v, 1)}
          >
            +
          </button>
        </div>
      ))}
    </div>
  );
}

type Tab = "opening" | "closing" | "summary";

export default function Reconciliation() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const canSetOpening = user?.role === "admin" || user?.role === "manager";
  const [tab, setTab] = useState<Tab>(canSetOpening ? "opening" : "closing");
  const [date, setDate] = useState(todayIso());

  const data = useQuery({
    queryKey: ["reconciliation", date],
    queryFn: () => api.dailyReconciliation(date),
    enabled: tab !== "summary",
  });

  const tabs: { key: Tab; label: string }[] = [
    ...(canSetOpening ? [{ key: "opening" as const, label: t("reconciliation.tabs.opening") }] : []),
    { key: "closing", label: t("reconciliation.tabs.closing") },
    { key: "summary", label: t("reconciliation.tabs.summary") },
  ];

  // Only admins/managers can pre-set a future opening float (e.g. preparing
  // tomorrow's till tonight); the closing/reconcile side can never be about a
  // day that hasn't happened yet.
  const dateMax = tab === "opening" && canSetOpening ? undefined : todayIso();

  return (
    <div className="space-y-5">
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              type="button"
              onClick={() => {
                setTab(tb.key);
                if (tb.key === "closing" && date > todayIso()) setDate(todayIso());
              }}
              className={`rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150 ${
                tab === tb.key ? "bg-brand-600 text-white shadow-sm" : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>
        {tab !== "summary" && (
          <div className="ml-auto flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
            {t("reconciliation.date")}
            <DatePicker value={date} onChange={setDate} max={dateMax} />
          </div>
        )}
      </div>

      {tab === "opening" && canSetOpening && <OpeningTab date={date} data={data.data} />}
      {tab === "closing" && <ClosingTab date={date} data={data.data} />}
      {tab === "summary" && <SummaryTab />}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-slate-800 dark:text-slate-100">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  );
}

function OpeningTab({ date, data }: { date: string; data: DailyReconciliation | undefined }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(false);
    if (data?.saved) {
      const byValue: Record<number, string> = {};
      for (const d of data.saved.opening_denominations) byValue[Number(d.value)] = String(d.count);
      setCounts(byValue);
    } else {
      setCounts({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, data?.saved]);

  const openingCash = denominationsTotal(counts);
  const alreadySaved = !!data?.saved && data.saved.opening_denominations.length > 0;

  const save = useMutation({
    mutationFn: () =>
      api.saveOpeningCount({
        business_date: date,
        denominations: DENOMINATIONS.filter((v) => Number(counts[v]) > 0).map((v) => ({
          value: String(v),
          count: Number(counts[v]),
        })),
      }),
    onSuccess: (result) => {
      qc.setQueryData(["reconciliation", date], result);
      setSaved(true);
    },
  });

  return (
    <div className="card p-6 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-brand-700">{t("reconciliation.openingCash")}</h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{t("reconciliation.openingCashHint")}</p>
      </div>

      {alreadySaved && (
        <p className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-sm text-emerald-700">
          {t("reconciliation.openingAlreadySaved", { amount: lkr(Number(data!.saved!.opening_cash)) })}
        </p>
      )}

      <DenominationGrid counts={counts} onChange={setCounts} />

      <p className="text-sm text-slate-500 dark:text-slate-400">
        {t("reconciliation.openingCashTotal")} <b className="text-slate-800 dark:text-slate-100">{lkr(openingCash)}</b>
      </p>

      <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? t("common.saving") : t("reconciliation.saveOpening")}
      </button>
      {saved && <p className="text-xs text-emerald-600">{t("reconciliation.saved")}</p>}
    </div>
  );
}

function ClosingTab({ date, data }: { date: string; data: DailyReconciliation | undefined }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSaved(false);
    if (data?.saved) {
      const byValue: Record<number, string> = {};
      for (const d of data.saved.denominations) byValue[Number(d.value)] = String(d.count);
      setCounts(byValue);
      setNote(data.saved.note ?? "");
    } else {
      setCounts({});
      setNote("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, data?.saved]);

  const openingCash = data?.saved ? Number(data.saved.opening_cash) : 0;
  const hasOpening = !!data?.saved && data.saved.opening_denominations.length > 0;
  const countedCash = denominationsTotal(counts);
  const netCash = data ? Number(data.net_cash) : 0;
  const expectedCash = openingCash + netCash;
  const variance = countedCash - expectedCash;

  const save = useMutation({
    mutationFn: () =>
      api.saveClosingCount({
        business_date: date,
        denominations: DENOMINATIONS.filter((v) => Number(counts[v]) > 0).map((v) => ({
          value: String(v),
          count: Number(counts[v]),
        })),
        payment_counts: (data?.other_methods ?? []).map((m) => ({ method: m.method, counted: m.expected })),
        note: note.trim() || null,
      }),
    onSuccess: (result) => {
      qc.setQueryData(["reconciliation", date], result);
      setSaved(true);
    },
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
      <div className="card p-6 space-y-5">
        {!hasOpening && (
          <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-700">
            {t("reconciliation.noOpeningWarning")}
          </p>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label={t("reconciliation.sold")} value={data ? lkr(Number(data.sold)) : "…"} hint={t("reconciliation.orders", { count: data?.order_count ?? 0 })} />
          <StatCard label={t("reconciliation.earned")} value={data ? lkr(Number(data.earned)) : "…"} />
          <StatCard label={t("reconciliation.cashRefunds")} value={data ? lkr(Number(data.cash_refunds)) : "…"} />
          <StatCard label={t("reconciliation.expectedCash")} value={data ? lkr(expectedCash) : "…"} hint={t("reconciliation.expectedCashHint")} />
        </div>

        <div>
          <h3 className="label mb-2">{t("reconciliation.countDrawer")}</h3>
          <DenominationGrid counts={counts} onChange={setCounts} />
        </div>

        {data && data.other_methods.length > 0 && (
          <div>
            <h3 className="label mb-2">{t("reconciliation.otherMethods")}</h3>
            <div className="space-y-2">
              {data.other_methods.map((m) => (
                <div key={m.method} className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2">
                  <span className="text-sm font-medium capitalize text-slate-700 dark:text-slate-200">{m.method.replace("_", " ")}</span>
                  <span className="text-sm text-slate-600 dark:text-slate-300">
                    {lkr(Number(m.expected))}
                    {Number(m.refunds) > 0 && (
                      <span className="ml-1.5 text-xs text-slate-400 dark:text-slate-500">
                        ({t("reconciliation.afterRefunds", { amount: lkr(Number(m.refunds)) })})
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <label className="block">
          <span className="label mb-1 block">{t("reconciliation.note")}</span>
          <input className="field" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      <div className="card p-6 space-y-3">
        <h2 className="text-sm font-semibold text-brand-700">{t("reconciliation.summary")}</h2>
        <p className="flex justify-between text-sm text-slate-600 dark:text-slate-300">
          <span>{t("reconciliation.openingCash")}</span>
          <span className="font-medium text-slate-800 dark:text-slate-100">{lkr(openingCash)}</span>
        </p>
        <p className="flex justify-between text-sm text-slate-600 dark:text-slate-300">
          <span>{t("reconciliation.countedCash")}</span>
          <span className="font-medium text-slate-800 dark:text-slate-100">{lkr(countedCash)}</span>
        </p>
        <p className="flex justify-between text-sm text-slate-600 dark:text-slate-300">
          <span>{t("reconciliation.expectedCash")}</span>
          <span className="font-medium text-slate-800 dark:text-slate-100">{lkr(expectedCash)}</span>
        </p>
        <p className="flex justify-between border-t border-slate-100 dark:border-slate-800 pt-3 text-sm font-medium">
          <span className={variance === 0 ? "text-slate-600 dark:text-slate-300" : variance > 0 ? "text-emerald-600" : "text-amber-600"}>
            {variance === 0 ? t("reconciliation.balanced") : variance > 0 ? t("reconciliation.over") : t("reconciliation.short")}
          </span>
          <span className={variance === 0 ? "text-slate-800 dark:text-slate-100" : variance > 0 ? "text-emerald-600" : "text-amber-600"}>
            {lkr(Math.abs(variance))}
          </span>
        </p>

        <button type="button" className="btn-primary w-full" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t("common.saving") : t("reconciliation.saveClosing")}
        </button>
        {saved && <p className="text-xs text-emerald-600">{t("reconciliation.saved")}</p>}
      </div>
    </div>
  );
}

function SummaryTab() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(daysAgoIso(29));
  const [to, setTo] = useState(todayIso());

  const history = useQuery({
    queryKey: ["reconciliation-history", from, to],
    queryFn: () => api.listReconciliations(from, to),
  });
  const [page, setPage] = useState(1);
  const { pageItems, totalPages, safePage } = paginate(history.data ?? [], page, 15);

  return (
    <div className="card p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-brand-700">{t("reconciliation.tabs.summary")}</h2>
        <div className="ml-auto flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
          {t("reports.from")} <DatePicker value={from} onChange={setFrom} max={to} />
          {t("reports.to")} <DatePicker value={to} onChange={setTo} min={from} max={todayIso()} />
        </div>
      </div>

      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700">
              <th className="px-2 py-2.5">{t("reconciliation.date")}</th>
              <th className="px-2 py-2.5">{t("reconciliation.openingCash")}</th>
              <th className="px-2 py-2.5">{t("reconciliation.countedCash")}</th>
              <th className="px-2 py-2.5">{t("reconciliation.expectedCash")}</th>
              <th className="px-2 py-2.5">{t("reconciliation.varianceCol")}</th>
              <th className="px-2 py-2.5">{t("reconciliation.closedBy")}</th>
              <th className="px-2 py-2.5">{t("reconciliation.note")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {pageItems.map((r) => {
              const variance = Number(r.variance);
              return (
                <tr key={r.business_date}>
                  <td className="px-2 py-2.5 text-slate-800 dark:text-slate-100">{r.business_date}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{lkr(Number(r.opening_cash))}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{lkr(Number(r.counted_cash))}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{lkr(Number(r.expected_cash))}</td>
                  <td className={`px-2 py-2.5 font-medium ${variance === 0 ? "text-slate-800 dark:text-slate-100" : variance > 0 ? "text-emerald-600" : "text-amber-600"}`}>
                    {variance === 0 ? lkr(0) : `${variance > 0 ? "+" : ""}${lkr(variance)}`}
                  </td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{r.created_by_name ?? "—"}</td>
                  <td className="px-2 py-2.5 text-slate-500 dark:text-slate-400">{r.note ?? "—"}</td>
                </tr>
              );
            })}
            {(history.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-10 text-center text-slate-400 dark:text-slate-500">{t("reconciliation.noHistory")}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={safePage} totalPages={totalPages} totalItems={history.data?.length ?? 0} pageSize={15} onPageChange={setPage} />
    </div>
  );
}
