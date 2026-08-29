import { invoke } from "@tauri-apps/api/core";
import { Bitmap, buildReceiptFor, rasterize } from "./escpos";
import { getShopSettings, onShopSettingsChange } from "./shop";
import { Bill } from "./types";

export type Printers = { names: string[]; default: string | null };

const KEY_PRINTER = "pos.printer";
const KEY_DRAWER = "pos.drawer";

export const isDesktop = () => "__TAURI_INTERNALS__" in window;

export const savedPrinter = () => localStorage.getItem(KEY_PRINTER) ?? "";
export const setSavedPrinter = (v: string) => localStorage.setItem(KEY_PRINTER, v);
export const savedDrawer = () => localStorage.getItem(KEY_DRAWER) === "1";
export const setSavedDrawer = (v: boolean) => localStorage.setItem(KEY_DRAWER, v ? "1" : "0");

export async function listPrinters(): Promise<Printers> {
  if (!isDesktop()) return { names: [], default: null };
  return invoke<Printers>("list_printers");
}

let logoCache: Bitmap | null | undefined;
let logoImgCache: HTMLImageElement | null | undefined;
let logoCacheSrc: string | undefined;

// A saved logo change should not keep printing the old one until restart.
onShopSettingsChange(() => {
  logoCache = undefined;
  logoImgCache = undefined;
  logoCacheSrc = undefined;
});

async function loadLogoImage(src: string): Promise<HTMLImageElement | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    return img;
  } catch {
    return null; // a missing/broken logo must never block a sale
  }
}

/**
 * Sends the bill as raw ESC/POS to the configured printer. Falls back to the
 * browser print dialog when running outside the desktop shell (npm run dev in a
 * plain browser), so the receipt is still testable there.
 */
export async function printBill(bill: Bill): Promise<void> {
  if (!isDesktop()) {
    window.print();
    return;
  }

  const printer = savedPrinter() || (await listPrinters()).default;
  if (!printer) {
    throw new Error("No printer selected. Open Settings and choose the receipt printer.");
  }

  const shop = getShopSettings();
  if (logoCacheSrc !== shop.logo) {
    logoCache = await rasterize(shop.logo);
    logoImgCache = await loadLogoImage(shop.logo);
    logoCacheSrc = shop.logo;
  }

  const data = await buildReceiptFor(bill, shop, logoCache ?? null, logoImgCache ?? null, savedDrawer());
  await invoke("print_raw", { printer, data: Array.from(data) });
}
