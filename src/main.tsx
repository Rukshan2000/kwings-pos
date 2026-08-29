import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import CustomerDisplay from "./pages/CustomerDisplay";
import SqlConsole from "./pages/SqlConsole";
import { AuthProvider } from "./auth";
import "./styles.css";
import "./receipt.css";
import "./i18n";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
});

// The customer-facing display is a second webview loading this same bundle
// (see `open_customer_display` in the Rust backend) — its window label picks
// a plain, unauthenticated render tree instead of the till's routed app, so
// it never touches login, the router, or the database.
const isCustomerDisplay = getCurrentWindow().label === "customer";
// The SQL console is the same second-window pattern (see `open_sql_console`
// in the Rust backend) — it needs auth (to confirm the shared session is
// still an admin) and react-query, but not the router or the till's screens.
const isSqlConsole = getCurrentWindow().label === "sql-console";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isCustomerDisplay ? (
      <CustomerDisplay />
    ) : isSqlConsole ? (
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <SqlConsole />
        </AuthProvider>
      </QueryClientProvider>
    ) : (
      <QueryClientProvider client={queryClient}>
        <HashRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </HashRouter>
      </QueryClientProvider>
    )}
  </React.StrictMode>
);
