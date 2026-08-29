import { useTranslation } from "react-i18next";

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { pageItems: items.slice(start, start + pageSize), totalPages, safePage };
}

export default function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useTranslation();
  if (totalItems === 0) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-500 dark:text-slate-400">
      <span>
        {t("pagination.range", { start, end, total: totalItems })}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs disabled:opacity-40"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
        >
          {t("pagination.prev")}
        </button>
        <span className="px-2 text-xs text-slate-500 dark:text-slate-400">
          {t("pagination.pageOf", { page, totalPages })}
        </span>
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs disabled:opacity-40"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
        >
          {t("pagination.next")}
        </button>
      </div>
    </div>
  );
}
