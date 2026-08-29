import { ReactNode, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Shell from "./layout/Shell";
import Splash from "./components/Splash";
import { DbState, watchDb } from "./db";
import { useAuth, useCurrentUser } from "./auth";
import type { Role } from "./api";
import Login from "./pages/Login";
import ForcePasswordChange from "./pages/ForcePasswordChange";
import Pos from "./pages/Pos";
import Products from "./pages/Products";
import MasterEntries from "./pages/MasterEntries";
import Inventory from "./pages/Inventory";
import Purchasing from "./pages/Purchasing";
import Reconciliation from "./pages/Reconciliation";
import Reports from "./pages/Reports";
import Returns from "./pages/Returns";
import SettingsPage from "./pages/SettingsPage";

/** Redirects to the till rather than showing an empty/broken page for a role
    that has no business on this route (e.g. a cashier typing /settings). */
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const user = useCurrentUser();
  if (user && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const [dbState, setDbState] = useState<DbState>({ kind: "starting" });
  useEffect(() => watchDb(setDbState), []);
  const { state } = useAuth();

  if (state.kind === "loading") {
    return <Splash ready={false} />;
  }
  if (state.kind === "signedOut") {
    return <Login />;
  }
  if (state.kind === "signedIn" && state.user.must_change_password) {
    return <ForcePasswordChange />;
  }

  return (
    <>
      <Splash ready={dbState.kind !== "starting"} />
      <Routes>
        <Route element={<Shell dbState={dbState} />}>
          <Route index element={<Pos />} />
          <Route path="returns" element={<Returns />} />
          <Route
            path="products"
            element={
              <RequireRole roles={["admin", "manager"]}>
                <Products />
              </RequireRole>
            }
          />
          <Route
            path="master-entries"
            element={
              <RequireRole roles={["admin", "manager"]}>
                <MasterEntries />
              </RequireRole>
            }
          />
          <Route
            path="inventory"
            element={
              <RequireRole roles={["admin", "manager"]}>
                <Inventory />
              </RequireRole>
            }
          />
          <Route
            path="purchasing"
            element={
              <RequireRole roles={["admin", "manager"]}>
                <Purchasing />
              </RequireRole>
            }
          />
          <Route path="reports" element={<Reports />} />
          <Route path="reconciliation" element={<Reconciliation />} />
          <Route
            path="settings"
            element={
              <RequireRole roles={["admin", "manager"]}>
                <SettingsPage />
              </RequireRole>
            }
          />
        </Route>
      </Routes>
    </>
  );
}
