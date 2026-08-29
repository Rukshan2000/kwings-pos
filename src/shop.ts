// Shop identity and receipt content, editable from Settings and persisted to
// localStorage. Defaults below are used until the shop owner changes them.

export type BillLanguage = "en" | "si" | "ta";
export type LocalizedText = { en: string; si: string; ta: string };

export type ShopSettings = {
  name: LocalizedText;
  tagline: LocalizedText;
  tel: string;
  web: string;
  /** Data URL of an uploaded logo, or a path to the bundled default. */
  logo: string;
  footer: [LocalizedText, LocalizedText, LocalizedText];
  /** Which language the printed/previewed receipt is rendered in — independent
      of the app's own UI language. */
  billLanguage: BillLanguage;
  /** Dots the printer is told to advance between each 24-dot image band (the
      logo, and the whole receipt on a Sinhala/Tamil bill). Should just be 24,
      but some printer firmware clamps or misreads that and leaves a visible
      gap between bands — this lets it be tuned per printer instead. */
  imageLineSpacing: number;
  /** The customer-facing second-screen display. */
  customerDisplay: CustomerDisplaySettings;
};

export type CustomerDisplaySettings = {
  /** Play the video queue on a loop whenever the till's cart is empty. */
  adsEnabled: boolean;
  /** Absolute local file paths, played in order and looped back to the start. */
  videoQueue: string[];
};

export const CURRENCY = "LKR";

export const DEFAULT_LOGO = "/logo.png";

const DEFAULTS: ShopSettings = {
  name: { en: "Green Plus Argo", si: "Green Plus Argo", ta: "Green Plus Argo" },
  tagline: {
    en: "Grow Green Grow Better",
    si: "වඩා හරිත වර්ධනයක්",
    ta: "பசுமையாக வளருங்கள், சிறப்பாக வளருங்கள்",
  },
  tel: "+94 77 236 5879",
  web: "www.greenplusagro.lk",
  logo: DEFAULT_LOGO,
  footer: [
    { en: "Thank You!", si: "ස්තුතියි!", ta: "நன்றி!" },
    { en: "Please Come Again", si: "නැවත එන්න", ta: "மீண்டும் வருக" },
    {
      en: "Your satisfaction is our priority",
      si: "ඔබේ තෘප්තිය අපගේ මුල් අරමුණයි",
      ta: "உங்கள் திருப்தியே எங்கள் முதன்மை",
    },
  ],
  billLanguage: "en",
  imageLineSpacing: 24,
  customerDisplay: { adsEnabled: false, videoQueue: [] },
};

const STORAGE_KEY = "pos.shopSettings";
const CHANGE_EVENT = "pos:shop-settings-changed";

const merge = (raw: Partial<ShopSettings> | null): ShopSettings =>
  raw
    ? {
        ...DEFAULTS,
        ...raw,
        name: { ...DEFAULTS.name, ...raw.name },
        tagline: { ...DEFAULTS.tagline, ...raw.tagline },
        footer: [
          { ...DEFAULTS.footer[0], ...raw.footer?.[0] },
          { ...DEFAULTS.footer[1], ...raw.footer?.[1] },
          { ...DEFAULTS.footer[2], ...raw.footer?.[2] },
        ],
        customerDisplay: { ...DEFAULTS.customerDisplay, ...raw.customerDisplay },
      }
    : DEFAULTS;

let cache: ShopSettings | null = null;

export function getShopSettings(): ShopSettings {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = merge(raw ? JSON.parse(raw) : null);
  } catch {
    cache = DEFAULTS;
  }
  return cache;
}

export function setShopSettings(next: ShopSettings) {
  cache = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Fires whenever shop settings are saved, so open screens (the printer's
    cached logo, the receipt preview) can pick up the change. Same-window
    only — a plain `localStorage.setItem` doesn't fire the native `storage`
    event in the window that made the change, only in others, so a second
    window (the customer display) has to listen for `storage` itself; see
    `onShopSettingsChangeAnywhere`. */
export function onShopSettingsChange(fn: () => void) {
  window.addEventListener(CHANGE_EVENT, fn);
  return () => window.removeEventListener(CHANGE_EVENT, fn);
}

/** Like `onShopSettingsChange`, but also picks up saves made from another
    window of the same app (e.g. Settings saved on the till while the
    customer display window is open elsewhere), via the native `storage`
    event those fire in. */
export function onShopSettingsChangeAnywhere(fn: (settings: ShopSettings) => void) {
  const reload = () => {
    cache = null;
    fn(getShopSettings());
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) reload();
  };
  window.addEventListener(CHANGE_EVENT, reload);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, reload);
    window.removeEventListener("storage", onStorage);
  };
}

export const pick = (t: LocalizedText, lang: BillLanguage) => t[lang] || t.en;

// Legacy default export kept for anything reading the shop's English text
// without caring about localization (e.g. a fallback before settings load).
export const SHOP = DEFAULTS;

// Optional quick-pick catalog shown as buttons.
export const CATALOG = [
  { name: "Growth Hormone 250ml", price: 22 },
  { name: "Urea 50kg Bag", price: 25 },
  { name: "NPK Fertilizer 10kg", price: 45 },
  { name: "Weedicide 1L", price: 60 },
];
