import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import Shell from "./layout/Shell";
import { DbState, watchDb } from "./db";
import Pos from "./pages/Pos";
import Products from "./pages/Products";
import MasterEntries from "./pages/MasterEntries";
import Inventory from "./pages/Inventory";
import Purchasing from "./pages/Purchasing";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  const [dbState, setDbState] = useState<DbState>({ kind: "starting" });
  useEffect(() => watchDb(setDbState), []);

  return (
    <Routes>
      <Route element={<Shell dbState={dbState} />}>
        <Route index element={<Pos />} />
        <Route path="products" element={<Products />} />
        <Route path="master-entries" element={<MasterEntries />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="purchasing" element={<Purchasing />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
