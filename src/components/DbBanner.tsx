import { DbState } from "../db";

/** Only visible when the database is not usable — a healthy DB says nothing. */
export default function DbBanner({ state }: { state: DbState }) {
  if (state.kind === "ready" || state.kind === "browser") return null;

  if (state.kind === "starting") {
    return (
      <div className="db-banner">
        Starting the database… the first launch takes a little longer while it is set up.
      </div>
    );
  }

  return (
    <div className="db-banner db-banner-error">
      <b>Database unavailable.</b> {state.message}
      <div className="db-banner-hint">
        Sales cannot be saved until this is fixed. Printing still works.
      </div>
    </div>
  );
}
