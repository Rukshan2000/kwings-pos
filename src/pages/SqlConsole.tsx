import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { useCurrentUser } from "../auth";

// A shared password on top of the admin-only window, not a login of its own
// — the backend command still re-checks the admin role on every query, so
// this is only meant to keep a curious cashier from poking around.
const CONSOLE_PASSWORD = "kwings@2026";

const PAGE_SIZE = 100;

/** Trusted identifiers only (from `list_sql_tables`, never free text) — quoted
 *  so a reserved-word table name still works as `SELECT * FROM "..."`. */
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

const browseSql = (table: string, orderBy: string | null, offset: number) =>
  `SELECT * FROM ${quoteIdent(table)}${orderBy ? ` ORDER BY ${quoteIdent(orderBy)}` : ""} LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

const EXAMPLES: { label: string; sql: string }[] = [
  {
    label: "All categories",
    sql: "SELECT * FROM category WHERE archived_at IS NULL ORDER BY name",
  },
  {
    label: "All products with category & brand",
    sql: `SELECT p.id, p.name, p.sku, p.barcode, c.name AS category, b.name AS brand,
       p.cost_price, p.selling_price, p.active
FROM product p
LEFT JOIN category c ON c.id = p.category_id
LEFT JOIN brand b ON b.id = p.brand_id
ORDER BY p.name`,
  },
  {
    label: "Current stock on hand, by product",
    sql: `SELECT p.name, u.code AS unit, COALESCE(SUM(m.quantity), 0) AS on_hand
FROM product p
JOIN unit u ON u.id = p.base_unit_id
LEFT JOIN stock_movement m ON m.product_id = p.id
GROUP BY p.id, p.name, u.code
ORDER BY p.name`,
  },
  {
    label: "Products below their low-stock threshold",
    sql: `SELECT p.name, p.low_stock_at, COALESCE(SUM(m.quantity), 0) AS on_hand
FROM product p
LEFT JOIN stock_movement m ON m.product_id = p.id
GROUP BY p.id, p.name, p.low_stock_at
HAVING COALESCE(SUM(m.quantity), 0) <= p.low_stock_at
ORDER BY on_hand`,
  },
  {
    label: "Purchases with supplier & outstanding balance",
    sql: `SELECT pu.id, s.name AS supplier, pu.invoice_number, pu.status,
       pu.total, pu.paid, (pu.total - pu.paid) AS outstanding, pu.created_at
FROM purchase pu
JOIN supplier s ON s.id = pu.supplier_id
ORDER BY pu.created_at DESC`,
  },
  {
    label: "Sales in the last 30 days",
    sql: `SELECT id, invoice_number, grand_total, balance_due, completed_at
FROM sale
WHERE completed_at >= now() - interval '30 days'
ORDER BY completed_at DESC`,
  },
  {
    label: "Revenue by category (last 30 days)",
    sql: `SELECT c.name AS category, SUM(sl.quantity * sl.unit_price - sl.discount_amount) AS revenue
FROM sale_line sl
JOIN sale s ON s.id = sl.sale_id
JOIN product p ON p.id = sl.product_id
LEFT JOIN category c ON c.id = p.category_id
WHERE s.completed_at >= now() - interval '30 days'
GROUP BY c.name
ORDER BY revenue DESC`,
  },
  {
    label: "Rename a category (UPDATE)",
    sql: "UPDATE category SET name = 'New Name' WHERE id = 1 RETURNING *",
  },
  {
    label: "Add a category (INSERT)",
    sql: "INSERT INTO category (name, color) VALUES ('New Category', '#0ea5e9') RETURNING *",
  },
  {
    label: "Adjust a product's selling price (UPDATE)",
    sql: "UPDATE product SET selling_price = 100.00 WHERE id = 1 RETURNING id, name, selling_price",
  },
  {
    label: "Soft-delete (archive) a category (DELETE-equivalent)",
    sql: "UPDATE category SET archived_at = now() WHERE id = 1 RETURNING *",
  },
];

function CellValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-slate-300 dark:text-slate-600">null</span>;
  if (typeof value === "object") return <span>{JSON.stringify(value)}</span>;
  return <span>{String(value)}</span>;
}

export default function SqlConsole() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [sql, setSql] = useState(EXAMPLES[0].sql);
  const [confirmDangerous, setConfirmDangerous] = useState(false);
  const [tableFilter, setTableFilter] = useState("");
  const [browsing, setBrowsing] = useState<{ table: string; offset: number } | null>(null);

  const tables = useQuery({
    queryKey: ["sql-console-tables"],
    queryFn: api.listSqlTables,
    enabled: unlocked,
  });
  const columns = useQuery({
    queryKey: ["sql-console-columns", browsing?.table],
    queryFn: () => api.listTableColumns(browsing!.table),
    enabled: unlocked && !!browsing,
  });

  const run = useMutation({
    mutationFn: (query: string) => api.runSqlQuery(query),
  });

  const isMutation = /^\s*(insert|update|delete)/i.test(sql);

  const execute = () => {
    setConfirmDangerous(false);
    run.mutate(sql);
  };

  const openTable = (table: string, offset: number) => {
    setBrowsing({ table, offset });
    setConfirmDangerous(false);
    // A first-column order is only a nicety for stable paging (usually `id`)
    // — falls back to no ORDER BY once we know the table's real columns.
    const orderBy = columns.data && columns.data[0]?.name;
    const query = browseSql(table, table === browsing?.table ? orderBy ?? null : null, offset);
    setSql(query);
    run.mutate(query);
  };

  const visibleTables = tables.data?.filter((t) => t.name.toLowerCase().includes(tableFilter.trim().toLowerCase()));

  if (user && user.role !== "admin") {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 dark:bg-slate-800 p-6 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("settings.sqlConsole.adminOnly")}</p>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 dark:bg-slate-800 p-6">
        <form
          className="w-full max-w-sm space-y-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-6 shadow-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (password === CONSOLE_PASSWORD) {
              setUnlocked(true);
              setPasswordError("");
            } else {
              setPasswordError(t("settings.sqlConsole.wrongPassword"));
            }
          }}
        >
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t("settings.sqlConsole.title")}</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("settings.sqlConsole.locked")}</p>
          <input
            type="password"
            className="field"
            placeholder={t("settings.sqlConsole.passwordPlaceholder")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          {passwordError && <p className="text-sm text-rose-600">{passwordError}</p>}
          <button type="submit" className="btn-primary w-full">
            {t("settings.sqlConsole.unlock")}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-800">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div className="border-b border-slate-100 dark:border-slate-800 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {t("settings.sqlConsole.tables")}
          </p>
          <input
            className="field !py-1.5 text-xs"
            placeholder={t("common.search")}
            value={tableFilter}
            onChange={(e) => setTableFilter(e.target.value)}
          />
        </div>
        <ul className="flex-1 overflow-y-auto py-1">
          {visibleTables?.map((tbl) => (
            <li key={tbl.name}>
              <button
                type="button"
                onClick={() => openTable(tbl.name, 0)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  browsing?.table === tbl.name
                    ? "bg-brand-50 font-medium text-brand-700"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
                }`}
              >
                <span className="truncate">{tbl.name}</span>
                <span className="shrink-0 text-slate-300 dark:text-slate-600">{Math.round(tbl.row_estimate)}</span>
              </button>
            </li>
          ))}
          {tables.isLoading && <li className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">{t("common.loading")}</li>}
          {visibleTables?.length === 0 && (
            <li className="px-3 py-2 text-xs text-slate-400 dark:text-slate-500">{t("masterEntries.noneYet")}</li>
          )}
        </ul>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-hidden p-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">{t("settings.sqlConsole.title")}</h1>
          <p className="text-xs text-slate-400 dark:text-slate-500">{t("settings.sqlConsole.hintCrud")}</p>
        </div>

        {browsing && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-xs text-brand-700">
            <span className="font-medium">{t("settings.sqlConsole.browsing", { table: browsing.table })}</span>
            {columns.data && columns.data.length > 0 && (
              <span className="text-brand-400">
                {columns.data.map((c) => c.name).join(", ")}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                className="rounded-md border border-brand-200 bg-white dark:bg-slate-900 px-2 py-0.5 font-medium disabled:opacity-40"
                disabled={browsing.offset === 0 || run.isPending}
                onClick={() => openTable(browsing.table, Math.max(0, browsing.offset - PAGE_SIZE))}
              >
                {t("pagination.prev")}
              </button>
              <span>{browsing.offset + 1}–{browsing.offset + (run.data?.rows.length ?? 0)}</span>
              <button
                type="button"
                className="rounded-md border border-brand-200 bg-white dark:bg-slate-900 px-2 py-0.5 font-medium disabled:opacity-40"
                disabled={(run.data?.rows.length ?? 0) < PAGE_SIZE || run.isPending}
                onClick={() => openTable(browsing.table, browsing.offset + PAGE_SIZE)}
              >
                {t("pagination.next")}
              </button>
            </span>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              type="button"
              className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
              onClick={() => {
                setBrowsing(null);
                setSql(ex.sql);
                setConfirmDangerous(false);
              }}
            >
              {ex.label}
            </button>
          ))}
        </div>

        <textarea
        className="field h-48 w-full shrink-0 font-mono text-xs leading-relaxed"
        value={sql}
        onChange={(e) => {
          setSql(e.target.value);
          setConfirmDangerous(false);
        }}
        spellCheck={false}
      />

      <div className="flex flex-wrap items-center gap-3">
        {isMutation && !confirmDangerous ? (
          <button
            type="button"
            className="btn-danger"
            disabled={run.isPending || !sql.trim()}
            onClick={() => setConfirmDangerous(true)}
          >
            {t("settings.sqlConsole.run")}
          </button>
        ) : (
          <button
            type="button"
            className={isMutation ? "btn-danger" : "btn-primary"}
            disabled={run.isPending || !sql.trim()}
            onClick={execute}
          >
            {run.isPending
              ? t("settings.sqlConsole.running")
              : isMutation && confirmDangerous
                ? t("settings.sqlConsole.confirmRun")
                : t("settings.sqlConsole.run")}
          </button>
        )}
        {isMutation && confirmDangerous && !run.isPending && (
          <button type="button" className="btn-secondary" onClick={() => setConfirmDangerous(false)}>
            {t("common.cancel")}
          </button>
        )}
        {run.data && run.data.rows_affected !== null && (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {t("settings.sqlConsole.rowsAffected", { count: run.data.rows_affected })}
          </span>
        )}
        {run.data && run.data.rows_affected === null && (
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {t("settings.sqlConsole.rowCount", { count: run.data.rows.length })}
          </span>
        )}
      </div>

      {isMutation && confirmDangerous && !run.isPending && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          {t("settings.sqlConsole.dangerousWarning")}
        </p>
      )}

      {run.isError && (
        <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {run.error instanceof Error ? run.error.message : String(run.error)}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        {run.data && run.data.rows.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
              <tr>
                {run.data.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2.5 py-2 text-left font-semibold text-slate-600 dark:text-slate-300">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {run.data.rows.map((row, i) => (
                <tr key={i}>
                  {run.data!.columns.map((c) => (
                    <td key={c} className="whitespace-nowrap px-2.5 py-1.5 text-slate-700 dark:text-slate-200">
                      <CellValue value={(row as Record<string, unknown>)[c]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {run.data && run.data.rows.length === 0 && run.data.rows_affected === null && (
          <p className="p-4 text-sm text-slate-400 dark:text-slate-500">{t("settings.sqlConsole.noRows")}</p>
        )}
        {run.data && run.data.rows.length === 0 && run.data.rows_affected !== null && (
          <p className="p-4 text-sm text-slate-400 dark:text-slate-500">
            {t("settings.sqlConsole.rowsAffected", { count: run.data.rows_affected })}
          </p>
        )}
        {!run.data && !run.isError && (
          <p className="p-4 text-sm text-slate-400 dark:text-slate-500">{t("settings.sqlConsole.runToSeeResults")}</p>
        )}
        </div>
      </div>
    </div>
  );
}
