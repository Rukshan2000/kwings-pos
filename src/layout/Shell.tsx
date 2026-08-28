import { NavLink, Outlet } from "react-router-dom";
import DbBanner from "../components/DbBanner";
import { DbState } from "../db";
import { SHOP } from "../shop";

const LINKS = [
  { to: "/", label: "POS", end: true },
  { to: "/products", label: "Products" },
  { to: "/master-entries", label: "Master Entries" },
  { to: "/inventory", label: "Inventory" },
  { to: "/purchasing", label: "Purchasing" },
  { to: "/settings", label: "Settings" },
];

export default function Shell({ dbState }: { dbState: DbState }) {
  return (
    <div className="min-h-screen flex flex-col">
      <nav className="sticky top-0 z-10 flex items-center gap-1 bg-white/90 backdrop-blur border-b border-slate-200 px-5 py-3">
        <div className="flex items-center gap-2 mr-6">
          <span className="h-6 w-6 rounded-lg bg-brand-600" />
          <span className="font-semibold text-slate-800 tracking-tight">{SHOP.name}</span>
        </div>
        {LINKS.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.end}
            className={({ isActive }) =>
              `rounded-lg px-3.5 py-2 text-sm font-medium transition-colors duration-150 ${
                isActive
                  ? "bg-brand-600 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
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
