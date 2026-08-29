import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import DbBanner from "../components/DbBanner";
import { DbState } from "../db";
import { useAuth, useCurrentUser } from "../auth";
import type { Role } from "../api";

function Clock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="text-sm font-medium text-slate-600 dark:text-slate-300 tabular-nums">
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
    </span>
  );
}

const LINKS: { to: string; key: string; end?: boolean; roles?: Role[] }[] = [
  { to: "/", key: "pos", end: true },
  { to: "/returns", key: "returns" },
  { to: "/products", key: "products", roles: ["admin", "manager"] },
  { to: "/master-entries", key: "masterEntries", roles: ["admin", "manager"] },
  { to: "/inventory", key: "inventory", roles: ["admin", "manager"] },
  { to: "/purchasing", key: "purchasing", roles: ["admin", "manager"] },
  { to: "/reports", key: "reports" },
  { to: "/reconciliation", key: "reconciliation" },
  { to: "/settings", key: "settings", roles: ["admin", "manager"] },
];

export default function Shell({ dbState }: { dbState: DbState }) {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const { logout } = useAuth();
  const links = LINKS.filter((l) => !l.roles || (user && l.roles.includes(user.role)));

  return (
    <div className="min-h-screen flex flex-col">
      <nav className="sticky top-0 z-10 flex items-center gap-1 bg-white/90 dark:bg-slate-900/90 backdrop-blur border-b border-slate-200 dark:border-slate-700 px-5 py-3">
        <div className="flex items-center gap-3 mr-6">
          <img src="/pos-logo-black.png" alt="" className="h-11 w-11 object-contain dark:hidden" />
          <img src="/pos-logo-white.png" alt="" className="hidden h-11 w-11 object-contain dark:block" />
          <span className="font-semibold text-slate-800 dark:text-slate-100 tracking-tight">{t("shell.appName")}</span>
        </div>
        {links.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) =>
              `rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150 ${
                isActive
                  ? "bg-brand-600 text-white shadow-sm"
                  : "text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-slate-50"
              }`
            }
          >
            {t(`nav.${l.key}`)}
          </NavLink>
        ))}
        <div className="ml-auto flex items-center gap-3">
          <Clock />
        </div>
        {user && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-slate-500 dark:text-slate-400">
              {user.display_name} <span className="text-slate-400 dark:text-slate-500">· {t(`auth.roles.${user.role}`)}</span>
            </span>
            <button
              type="button"
              onClick={() => logout()}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
            >
              {t("auth.signOut")}
            </button>
          </div>
        )}
      </nav>

      <div className="px-5 pt-4">
        <DbBanner state={dbState} />
      </div>

      <div className="flex-1 p-5">
        <Outlet />
      </div>
    </div>
  );
}
