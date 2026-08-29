import { useTranslation } from "react-i18next";
import { DbState } from "../db";

/** Only visible when the database is not usable — a healthy DB says nothing. */
export default function DbBanner({ state }: { state: DbState }) {
  const { t } = useTranslation();
  if (state.kind === "ready" || state.kind === "browser") return null;

  if (state.kind === "starting") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
        <span>{t("dbBanner.starting")}</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <p className="font-medium">{t("dbBanner.unavailable", { message: state.message })}</p>
      <p className="mt-1 text-amber-600/80">{t("dbBanner.salesCannotBeSaved")}</p>
    </div>
  );
}
