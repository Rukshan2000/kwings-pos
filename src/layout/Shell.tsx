import { NavLink, Outlet } from "react-router-dom";
import DbBanner from "../components/DbBanner";
import { DbState } from "../db";
import { SHOP } from "../shop";

const LINKS = [
  { to: "/", label: "POS", end: true },
  { to: "/products", label: "Products" },
  { to: "/inventory", label: "Inventory" },
  { to: "/purchasing", label: "Purchasing" },
];

export default function Shell({ dbState }: { dbState: DbState }) {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="nav-brand">{SHOP.name}</div>
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className="nav-link">
            {l.label}
          </NavLink>
        ))}
      </nav>
      <DbBanner state={dbState} />
      <div className="shell-body">
        <Outlet />
      </div>
    </div>
  );
}
