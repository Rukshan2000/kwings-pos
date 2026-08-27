import { invoke } from "@tauri-apps/api/core";
import { buildReceipt, rasterize } from "./escpos";
import { SHOP } from "./shop";
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

let logoCache: Uint8Array | null | undefined;

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

  if (logoCache === undefined) logoCache = await rasterize(SHOP.logo);

  const data = buildReceipt(bill, logoCache, savedDrawer());
  await invoke("print_raw", { printer, data: Array.from(data) });
}
