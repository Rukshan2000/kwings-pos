import { useEffect, useState } from "react";
import Settings from "../components/Settings";
import { DbState, watchDb } from "../db";

export default function SettingsPage() {
  const [dbState, setDbState] = useState<DbState>({ kind: "starting" });
  useEffect(() => watchDb(setDbState), []);

  return (
    <div className="max-w-6xl">
      <Settings dbState={dbState} onClose={() => {}} embedded />
    </div>
  );
}
