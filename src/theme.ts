// Light/dark theme, editable from Settings and persisted to localStorage —
// same pattern as shop.ts. "system" follows the OS's own light/dark setting
// and stays live if the OS setting changes while the app is open.

export type ThemeSetting = "light" | "dark" | "system";

const STORAGE_KEY = "pos.theme";
const CHANGE_EVENT = "pos:theme-changed";

export function getTheme(): ThemeSetting {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "system";
}

export function setTheme(next: ThemeSetting) {
  localStorage.setItem(STORAGE_KEY, next);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  applyTheme();
}

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function resolvedTheme(): "light" | "dark" {
  const t = getTheme();
  return t === "system" ? (prefersDark() ? "dark" : "light") : t;
}

/** Toggles the `dark` class on <html> — every dark: Tailwind variant in the
    app keys off this. Call once at startup and whenever the setting or the
    OS preference changes. */
export function applyTheme() {
  document.documentElement.classList.toggle("dark", resolvedTheme() === "dark");
}

/** Wires up live updates: this window's own changes, another window's saved
    change (via the native `storage` event, like shop.ts), and the OS theme
    flipping while on "system". Call once per window that renders themed UI. */
export function initTheme() {
  applyTheme();
  window.addEventListener(CHANGE_EVENT, applyTheme);
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) applyTheme();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getTheme() === "system") applyTheme();
  });
}
