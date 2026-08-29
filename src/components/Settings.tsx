import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import Receipt from "./Receipt";
import UsersPanel from "./UsersPanel";
import { backupNow, DbState } from "../db";
import { useCurrentUser } from "../auth";
import { setLanguage, SUPPORTED_LANGUAGES } from "../i18n";
import { getTheme, setTheme, ThemeSetting } from "../theme";
import {
  isDesktop,
  listPrinters,
  savedDrawer,
  savedPrinter,
  setSavedDrawer,
  setSavedPrinter,
} from "../printer";
import { BillLanguage, DEFAULT_LOGO, getShopSettings, setShopSettings, ShopSettings } from "../shop";
import { api } from "../api";
import { Bill } from "../types";

// Representative line items just for showing what the receipt will look
// like — never sent anywhere, never saved.
const PREVIEW_BILL: Bill = {
  billNumber: "0001-000123",
  date: new Date(),
  items: [
    { id: "1", name: "Urea 50kg Bag", qty: 2, price: 25 },
    { id: "2", name: "Growth Hormone 250ml", qty: 1, price: 22, discount: { kind: "percent", value: 10 } },
  ],
  billDiscount: { kind: "fixed", value: 5 },
};

export default function Settings({
  dbState,
  onClose,
  embedded,
}: {
  dbState: DbState;
  onClose: () => void;
  embedded?: boolean;
}) {
  const [names, setNames] = useState<string[]>([]);
  const [sysDefault, setSysDefault] = useState<string | null>(null);
  const [printer, setPrinter] = useState(savedPrinter);
  const [drawer, setDrawer] = useState(savedDrawer);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [backup, setBackup] = useState("");
  const [backingUp, setBackingUp] = useState(false);
  const { t, i18n } = useTranslation();

  const [shop, setShop] = useState<ShopSettings>(getShopSettings);
  const [editingLang, setEditingLang] = useState<BillLanguage>("en");
  const [logoError, setLogoError] = useState("");
  const [tab, setTab] = useState<
    "printer" | "language" | "billContent" | "customerDisplay" | "database" | "users"
  >("printer");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [addingVideo, setAddingVideo] = useState(false);
  const currentUser = useCurrentUser();
  const isAdmin = currentUser?.role === "admin";
  const [theme, setThemeState] = useState<ThemeSetting>(getTheme);
  const setThemeSetting = (t: ThemeSetting) => {
    setTheme(t);
    setThemeState(t);
  };

  const addVideos = async () => {
    setAddingVideo(true);
    try {
      const picked = await openFileDialog({
        multiple: true,
        filters: [{ name: "Video", extensions: ["mp4", "webm", "mov", "mkv", "avi"] }],
      });
      const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
      if (paths.length === 0) return;
      setShop((s) => ({
        ...s,
        customerDisplay: {
          ...s.customerDisplay,
          videoQueue: [...s.customerDisplay.videoQueue, ...paths],
        },
      }));
    } finally {
      setAddingVideo(false);
    }
  };

  const removeVideo = (index: number) =>
    setShop((s) => ({
      ...s,
      customerDisplay: {
        ...s.customerDisplay,
        videoQueue: s.customerDisplay.videoQueue.filter((_, i) => i !== index),
      },
    }));

  const moveVideo = (index: number, delta: -1 | 1) =>
    setShop((s) => {
      const queue = [...s.customerDisplay.videoQueue];
      const target = index + delta;
      if (target < 0 || target >= queue.length) return s;
      [queue[index], queue[target]] = [queue[target], queue[index]];
      return { ...s, customerDisplay: { ...s.customerDisplay, videoQueue: queue } };
    });

  const setLocalized = (
    field: "name" | "tagline",
    lang: BillLanguage,
    value: string
  ) => setShop((s) => ({ ...s, [field]: { ...s[field], [lang]: value } }));

  const setFooterLine = (index: 0 | 1 | 2, lang: BillLanguage, value: string) =>
    setShop((s) => {
      const footer = [...s.footer] as ShopSettings["footer"];
      footer[index] = { ...footer[index], [lang]: value };
      return { ...s, footer };
    });

  const onLogoFile = (file: File | null) => {
    if (!file) return;
    if (file.size > 1024 * 1024) {
      setLogoError(t("settings.billContent.logoTooBig"));
      return;
    }
    setLogoError("");
    const reader = new FileReader();
    reader.onload = () => setShop((s) => ({ ...s, logo: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  const load = () => {
    setLoading(true);
    setError("");
    listPrinters()
      .then((p) => {
        setNames(p.names);
        setSysDefault(p.default);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const save = () => {
    setSaveState("saving");
    setSavedPrinter(printer);
    setSavedDrawer(drawer);
    setShopSettings(shop);
    setTimeout(() => {
      setSaveState("saved");
      onClose();
      setTimeout(() => setSaveState("idle"), 1500);
    }, 300);
  };

  const body = (
    <div
      className={embedded ? "card max-w-2xl flex-1 p-6 space-y-5" : "card w-[440px] max-w-[92vw] p-6 space-y-5"}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap gap-2" role="tablist">
        {(
          [
            "printer",
            "language",
            "billContent",
            "customerDisplay",
            "database",
            ...(isAdmin ? (["users"] as const) : []),
          ] as const
        ).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-xl px-3.5 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? "bg-slate-900 dark:bg-brand-600 text-white"
                : "border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            }`}
          >
            {id === "printer"
              ? t("settings.printerSettings")
              : id === "language"
                ? t("settings.language")
                : id === "billContent"
                  ? t("settings.billContent.title")
                  : id === "customerDisplay"
                    ? t("settings.customerDisplay.title")
                    : id === "database"
                      ? t("settings.database")
                      : t("settings.users")}
          </button>
        ))}
        {isAdmin && (
          <button
            type="button"
            className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
            onClick={() => api.openSqlConsole()}
          >
            {t("settings.sqlConsole.title")} ↗
          </button>
        )}
      </div>

      {tab === "language" && (
        <div className="space-y-6">
          <div>
            <label className="label mb-1.5 block">{t("settings.language")}</label>
            <div className="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 w-fit">
              {SUPPORTED_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => setLanguage(l.code)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    i18n.language === l.code ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="label mb-1.5 block">{t("settings.appearance.title")}</label>
            <div className="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 w-fit">
              {(["light", "dark", "system"] as const).map((th) => (
                <button
                  key={th}
                  type="button"
                  onClick={() => setThemeSetting(th)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    theme === th ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                  }`}
                >
                  {t(`settings.appearance.${th}`)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">{t("settings.appearance.hint")}</p>
          </div>
        </div>
      )}

      {tab === "printer" && (
        <div className={embedded ? "grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2" : "space-y-5"}>
          <div>
            <label className="label mb-1.5 block">{t("settings.receiptPrinter")}</label>
            <select className="select" value={printer} onChange={(e) => setPrinter(e.target.value)}>
              <option value="">
                {sysDefault ? t("settings.systemDefaultNamed", { name: sysDefault }) : t("settings.systemDefault")}
              </option>
              {names.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {loading && <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">{t("settings.lookingForPrinters")}</p>}
            {!loading && !names.length && isDesktop() && (
              <p className="mt-1.5 text-xs text-amber-600">{t("settings.noPrintersFound")}</p>
            )}
            {error && <p className="mt-1.5 text-xs text-amber-600">{error}</p>}
          </div>

          {!isDesktop() && (
            <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800 sm:col-span-2">
              {t("settings.browserWarning")}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 sm:col-span-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-brand-600 focus:ring-brand-400"
              checked={drawer}
              onChange={(e) => setDrawer(e.target.checked)}
            />
            {t("settings.openCashDrawer")}
          </label>

          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed sm:col-span-2">{t("settings.escposNote")}</p>
        </div>
      )}

      {tab === "billContent" && (
        <div className="space-y-5">
          <p className="text-xs text-slate-400 dark:text-slate-500">{t("settings.billContent.hint")}</p>

          <div className={embedded ? "grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2" : "space-y-5"}>
            <div>
              <label className="label mb-1.5 block">{t("settings.billContent.billLanguage")}</label>
              <div className="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 w-fit">
                {SUPPORTED_LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    type="button"
                    onClick={() => setShop((s) => ({ ...s, billLanguage: l.code }))}
                    className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                      shop.billLanguage === l.code ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">{t("settings.billContent.billLanguageHint")}</p>
            </div>

            <div>
              <span className="label mb-1.5 block">{t("settings.billContent.logo")}</span>
              <div className="flex items-center gap-3">
                <img
                  src={shop.logo}
                  alt=""
                  className="h-12 w-12 rounded-lg border border-slate-200 dark:border-slate-700 object-contain bg-white dark:bg-slate-900"
                />
                <label className="btn-secondary cursor-pointer !py-1.5 !px-3 text-xs">
                  {t("settings.billContent.uploadLogo")}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onLogoFile(e.target.files?.[0] ?? null)}
                  />
                </label>
                {shop.logo !== DEFAULT_LOGO && (
                  <button
                    type="button"
                    className="text-xs text-slate-400 dark:text-slate-500 hover:text-amber-600"
                    onClick={() => setShop((s) => ({ ...s, logo: DEFAULT_LOGO }))}
                  >
                    {t("settings.billContent.resetLogo")}
                  </button>
                )}
              </div>
              {logoError && <p className="mt-1.5 text-xs text-amber-600">{logoError}</p>}
            </div>

            <label className="block">
              <span className="label mb-1 block">{t("settings.billContent.phone")}</span>
              <input
                className="field"
                value={shop.tel}
                onChange={(e) => setShop((s) => ({ ...s, tel: e.target.value }))}
              />
            </label>
            <label className="block">
              <span className="label mb-1 block">{t("settings.billContent.website")}</span>
              <input
                className="field"
                value={shop.web}
                onChange={(e) => setShop((s) => ({ ...s, web: e.target.value }))}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className="label mb-1 block">{t("settings.billContent.imageLineSpacing")}</span>
              <input
                className="field w-32"
                type="number"
                min={1}
                max={48}
                value={shop.imageLineSpacing}
                onChange={(e) =>
                  setShop((s) => ({ ...s, imageLineSpacing: Number(e.target.value) || 24 }))
                }
              />
              <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">
                {t("settings.billContent.imageLineSpacingHint")}
              </span>
            </label>
          </div>

          <div className="border-t border-slate-100 dark:border-slate-800 pt-5">
            <label className="label mb-1.5 block">{t("settings.billContent.editingLanguage")}</label>
            <div className="flex overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700 w-fit">
              {SUPPORTED_LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  type="button"
                  onClick={() => setEditingLang(l.code)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    editingLang === l.code ? "bg-brand-600 text-white" : "bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>

            <div className={embedded ? "mt-4 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2" : "mt-4 space-y-5"}>
              <label className="block">
                <span className="label mb-1 block">{t("settings.billContent.shopName")}</span>
                <input
                  className="field"
                  value={shop.name[editingLang]}
                  onChange={(e) => setLocalized("name", editingLang, e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label mb-1 block">{t("settings.billContent.tagline")}</span>
                <input
                  className="field"
                  value={shop.tagline[editingLang]}
                  onChange={(e) => setLocalized("tagline", editingLang, e.target.value)}
                />
              </label>
              <div className={embedded ? "grid grid-cols-1 gap-x-8 gap-y-5 sm:col-span-2 sm:grid-cols-3" : "space-y-5"}>
                {([0, 1, 2] as const).map((i) => (
                  <label className="block" key={i}>
                    <span className="label mb-1 block">{t("settings.billContent.footerLine", { n: i + 1 })}</span>
                    <input
                      className="field"
                      value={shop.footer[i][editingLang]}
                      onChange={(e) => setFooterLine(i, editingLang, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === "customerDisplay" && (
        <div className="space-y-5">
          <p className="text-xs text-slate-400 dark:text-slate-500">{t("settings.customerDisplay.hint")}</p>

          <button type="button" className="btn-secondary" onClick={() => api.openCustomerDisplay().catch(() => {})}>
            {t("settings.customerDisplay.open")}
          </button>

          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 dark:border-slate-600 text-brand-600 focus:ring-brand-400"
              checked={shop.customerDisplay.adsEnabled}
              onChange={(e) =>
                setShop((s) => ({
                  ...s,
                  customerDisplay: { ...s.customerDisplay, adsEnabled: e.target.checked },
                }))
              }
            />
            {t("settings.customerDisplay.playAdsWhenIdle")}
          </label>

          <div>
            <div className="flex items-center justify-between">
              <span className="label">{t("settings.customerDisplay.queue")}</span>
              <button type="button" className="btn-secondary !py-1.5 !px-3 text-xs" disabled={addingVideo} onClick={addVideos}>
                {addingVideo ? t("common.loading") : t("settings.customerDisplay.addVideos")}
              </button>
            </div>

            {shop.customerDisplay.videoQueue.length === 0 ? (
              <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">{t("settings.customerDisplay.queueEmpty")}</p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
                {shop.customerDisplay.videoQueue.map((path, i) => (
                  <li key={`${path}-${i}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="w-5 shrink-0 text-xs text-slate-400 dark:text-slate-500">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200" title={path}>
                      {path}
                    </span>
                    <button
                      type="button"
                      className="h-6 w-6 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-30"
                      disabled={i === 0}
                      onClick={() => moveVideo(i, -1)}
                      aria-label={t("settings.customerDisplay.moveUp")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="h-6 w-6 shrink-0 rounded-md border border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-30"
                      disabled={i === shop.customerDisplay.videoQueue.length - 1}
                      onClick={() => moveVideo(i, 1)}
                      aria-label={t("settings.customerDisplay.moveDown")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="shrink-0 text-slate-400 dark:text-slate-500 hover:text-amber-600"
                      onClick={() => removeVideo(i)}
                      aria-label={t("settings.customerDisplay.remove")}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {tab === "database" && (
        <div>
          {dbState.kind === "ready" ? (
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {t("settings.dbInfo", {
                version: dbState.health.serverVersion,
                port: dbState.health.port,
                count: dbState.health.migrations,
                plural: dbState.health.migrations === 1 ? "" : "s",
              })}
              {dbState.health.dataDir && (
                <>
                  <br />
                  {dbState.health.dataDir}
                </>
              )}
            </p>
          ) : dbState.kind === "starting" ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">{t("settings.starting")}</p>
          ) : dbState.kind === "browser" ? (
            <p className="text-xs text-slate-400 dark:text-slate-500">{t("settings.notAvailableInBrowser")}</p>
          ) : (
            <p className="text-xs text-amber-600">{dbState.message}</p>
          )}

          <button
            type="button"
            className="btn-secondary mt-3"
            disabled={dbState.kind !== "ready" || backingUp}
            onClick={async () => {
              setBackingUp(true);
              setBackup("");
              try {
                setBackup(t("settings.savedTo", { path: await backupNow() }));
              } catch (e) {
                setBackup(t("settings.backupFailed", { error: e instanceof Error ? e.message : String(e) }));
              } finally {
                setBackingUp(false);
              }
            }}
          >
            {backingUp ? t("settings.backingUp") : t("settings.backupNow")}
          </button>
          {backup && (
            <p className={`mt-1.5 text-xs ${backup.startsWith("Backup failed") ? "text-amber-600" : "text-slate-500 dark:text-slate-400"}`}>
              {backup}
            </p>
          )}
        </div>
      )}

      {tab === "users" && isAdmin && <UsersPanel />}

      {tab !== "users" && (
        <div className="flex justify-end gap-2 border-t border-slate-100 dark:border-slate-800 pt-5">
          <button type="button" className="btn-secondary" onClick={load}>{t("common.refresh")}</button>
          <button
            type="button"
            className="btn-primary inline-flex items-center gap-2"
            disabled={saveState === "saving"}
            onClick={save}
          >
            {saveState === "saving" && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            )}
            {saveState === "saving" ? t("common.saving") : saveState === "saved" ? t("common.saved") : t("common.save")}
          </button>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return (
      <div className="flex flex-wrap items-start gap-6">
        {body}
        <div className="shrink-0">
          <p className="label mb-2">{t("settings.billContent.preview")}</p>
          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-4 shadow-sm">
            <Receipt bill={PREVIEW_BILL} shop={shop} lang={shop.billLanguage} />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40" onClick={onClose}>
      {body}
    </div>
  );
}
