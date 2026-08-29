// ESC/POS byte stream for a generic 80mm thermal printer.
// 80mm at Font A = 48 characters per line, 576 dots wide.

import i18n from "./i18n";
import { BillLanguage, CURRENCY, ShopSettings, pick } from "./shop";
import {
  Bill,
  billDiscountAmount,
  describeDiscount,
  discountTotal,
  grandTotal,
  lineDiscount,
  lineGross,
  money,
  subtotal,
} from "./types";

export const COLS = 48;
export const DOTS = 576;

const ESC = 0x1b;
const GS = 0x1d;

class Buf {
  private parts: number[] = [];

  raw(...b: number[]) {
    this.parts.push(...b);
    return this;
  }

  bytes(b: ArrayLike<number>) {
    this.parts.push(...Array.from(b));
    return this;
  }

  /** CP437 is the default codepage on these printers; ASCII is the safe subset. */
  text(s: string) {
    for (const ch of s.replace(/[^\x20-\x7e]/g, "?")) this.parts.push(ch.charCodeAt(0));
    return this;
  }

  line(s = "") {
    return this.text(s).raw(0x0a);
  }

  init() {
    return this.raw(ESC, 0x40);
  }
  align(a: "left" | "center" | "right") {
    return this.raw(ESC, 0x61, { left: 0, center: 1, right: 2 }[a]);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  /** width/height are 1..8 multipliers. */
  size(w: number, h: number) {
    return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }
  feed(n: number) {
    return this.raw(ESC, 0x64, n);
  }
  cut() {
    return this.raw(GS, 0x56, 66, 0);
  }
  /** Pulse pin 2 — pops a cash drawer wired to the printer's RJ11 port. */
  drawer() {
    return this.raw(ESC, 0x70, 0, 25, 250);
  }

  /**
   * Prints a bitmap as `ESC *` 24-dot bit-image bands rather than the newer
   * `GS v 0` raster command — plenty of cheap ESC/POS clones simply don't
   * implement `GS v 0` and, worse, don't reject it either: they fall through
   * to printing its bytes as literal CP437 text, which is what turns a logo
   * into a page of garbage characters. `ESC *` is part of the original
   * Epson command set and is about as close to universally supported as
   * ESC/POS printers get.
   *
   * Each band is 24 dots tall; `lineSpacingDots` is what we tell the printer
   * (via `ESC 3`) to advance between bands so they sit flush with no gap.
   * That should just be 24 — but plenty of clone firmware silently clamps or
   * misinterprets small `ESC 3` values and leaves a visible white gap
   * between bands anyway, with no reliable way to detect that from software.
   * `lineSpacingDots` exists so that can be tuned per printer from Settings
   * instead of guessed at in code.
   */
  image({ bytesPerRow, height, bmp }: Bitmap, lineSpacingDots = 24) {
    const width = bytesPerRow * 8;
    this.raw(ESC, 0x33, lineSpacingDots);
    for (let y0 = 0; y0 < height; y0 += 24) {
      this.raw(ESC, 0x2a, 33, width & 0xff, (width >> 8) & 0xff);
      for (let x = 0; x < width; x++) {
        for (let slice = 0; slice < 3; slice++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            const y = y0 + slice * 8 + bit;
            if (y >= height) continue;
            if (bmp[y * bytesPerRow + (x >> 3)] & (0x80 >> (x & 7))) byte |= 0x80 >> bit;
          }
          this.raw(byte);
        }
      }
      this.raw(0x0a);
    }
    this.raw(ESC, 0x32); // restore the printer's default line spacing
    return this;
  }

  out() {
    return new Uint8Array(this.parts);
  }
}

/** "Subtotal:" on the left, "LKR 69.00" hard against the right margin. */
const row = (left: string, right: string, cols = COLS) => {
  const gap = cols - left.length - right.length;
  return gap > 0 ? left + " ".repeat(gap) + right : `${left} ${right}`;
};

const wrap = (s: string, cols = COLS) => {
  const out: string[] = [];
  let line = "";
  for (const w of s.split(/\s+/)) {
    if (!line.length) line = w;
    else if (line.length + 1 + w.length <= cols) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line.length) out.push(line);
  return out.length ? out : [""];
};

export type Bitmap = { bytesPerRow: number; height: number; bmp: Uint8Array };

/**
 * Rasterize an image to a 1-bit bitmap. Anything darker than mid-grey (or any
 * opaque pixel of a transparent-background logo) burns as a dot.
 */
export async function rasterize(src: string, maxWidth = 384): Promise<Bitmap | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();

    const w = Math.min(maxWidth, DOTS) & ~7; // must land on a byte boundary
    const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);
    const bytesPerRow = w / 8;
    const bmp = new Uint8Array(bytesPerRow * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const lum = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
        if (lum < 128) bmp[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }

    return { bytesPerRow, height: h, bmp };
  } catch {
    return null; // a missing logo must never block a sale
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Fast path: plain ASCII text over ESC/POS. The printer's CP437 codepage has
 * no Sinhala or Tamil glyphs, so this only ever runs for an English bill —
 * `printBill` in printer.ts routes anything else to `buildReceiptImage`.
 */
export function buildReceipt(bill: Bill, shop: ShopSettings, logo: Bitmap | null, openDrawer = false) {
  const t = i18n.getFixedT("en");
  const b = new Buf().init();
  // Defensive: `ESC @` is supposed to reset line spacing on its own, but on
  // flaky clone firmware a leftover `ESC 3` from an earlier job has been seen
  // to survive init and corrupt the very first band of the very next image.
  b.raw(ESC, 0x32);
  const d = bill.date;
  const sub = subtotal(bill.items);
  const off = discountTotal(bill.items, bill.billDiscount);
  const billOff = billDiscountAmount(bill.items, bill.billDiscount);
  const total = grandTotal(bill.items, bill.billDiscount);
  const dash = "-".repeat(COLS);

  b.align("center");
  if (logo) b.image(logo, shop.imageLineSpacing).feed(1);

  b.text(pick(shop.tagline, "en").toUpperCase().split("").join(" ")).raw(0x0a);
  b.bold(true).size(2, 2).line(pick(shop.name, "en")).size(1, 1).bold(false);
  b.line(t("receipt.tel", { tel: shop.tel }));
  b.line(shop.web);

  b.align("left").line(dash);
  b.line(row(t("receipt.billNumber"), bill.billNumber));
  b.line(row(t("receipt.date"), `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`));
  b.line(row(t("receipt.time"), `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`));
  b.line(dash);

  for (const i of bill.items) {
    b.bold(true);
    for (const l of wrap(i.name)) b.line(l);
    b.bold(false);
    // The line always prints at full price; a discount shows as its own row
    // underneath, so the customer can see what was taken off and why.
    b.line(
      row(
        `  ${i.qty} x ${CURRENCY} ${money(i.price)}`,
        `${CURRENCY} ${money(lineGross(i))}`
      )
    );
    const lineOff = lineDiscount(i);
    if (i.discount && lineOff > 0) {
      b.line(
        row(
          t("receipt.discountLine", { desc: describeDiscount(i.discount) }),
          `-${CURRENCY} ${money(lineOff)}`
        )
      );
    }
  }

  b.line(dash);
  b.line(row(t("receipt.subtotal"), `${CURRENCY} ${money(sub)}`));
  if (billOff > 0) {
    const label = bill.billDiscount
      ? t("receipt.billDiscount", { desc: describeDiscount(bill.billDiscount) })
      : t("receipt.billDiscountPlain");
    b.line(row(label, `-${CURRENCY} ${money(billOff)}`));
  }
  if (off > 0) {
    b.bold(true).line(row(t("receipt.youSaved"), `-${CURRENCY} ${money(off)}`)).bold(false);
  }
  // Double width halves the usable columns, so lay the TOTAL out over 24.
  b.bold(true).size(2, 2);
  b.line(row(t("receipt.total"), `${CURRENCY} ${money(total)}`, COLS / 2));
  b.size(1, 1).bold(false);
  b.line(dash);

  b.align("center");
  b.bold(true).line(pick(shop.footer[0], "en")).bold(false);
  b.line(pick(shop.footer[1], "en"));
  b.line(pick(shop.footer[2], "en"));

  b.feed(4);
  if (openDrawer) b.drawer();
  b.cut();

  return b.out();
}

const FONT_FAMILY: Record<BillLanguage, string> = {
  en: "sans-serif",
  si: "'Iskoola Pota','Noto Sans Sinhala',sans-serif",
  ta: "'Latha','Vijaya','Noto Sans Tamil',sans-serif",
};

const font = (lang: BillLanguage, size: number, bold: boolean) =>
  `${bold ? "bold " : ""}${size}px ${FONT_FAMILY[lang]}`;

type ImgLine =
  | { kind: "logo" }
  | { kind: "rule" }
  | { kind: "text"; text: string; align: "left" | "center" | "right"; size: number; bold: boolean }
  | { kind: "row"; left: string; right: string; size: number; bold: boolean };

/**
 * Slow path for a Sinhala or Tamil bill: the printer's built-in codepage
 * cannot represent those scripts, so the whole receipt is drawn with a
 * Unicode-capable canvas font and sent as one raster image instead of text.
 */
async function buildReceiptImage(
  bill: Bill,
  shop: ShopSettings,
  lang: BillLanguage,
  logoImg: HTMLImageElement | null,
  openDrawer: boolean
): Promise<Uint8Array> {
  const t = i18n.getFixedT(lang);
  const d = bill.date;
  const sub = subtotal(bill.items);
  const off = discountTotal(bill.items, bill.billDiscount);
  const billOff = billDiscountAmount(bill.items, bill.billDiscount);
  const total = grandTotal(bill.items, bill.billDiscount);

  // A canvas font that hasn't finished loading yet silently falls back to a
  // generic one for the first paint, with different glyph widths — that
  // desyncs `measureText` (used to center text) from what actually gets
  // drawn once the real font loads moments later, throwing off centering.
  // Loading it up front makes sure measuring and drawing agree throughout.
  if (lang !== "en" && "fonts" in document) {
    try {
      await Promise.all([
        document.fonts.load(font(lang, 24, false)),
        document.fonts.load(font(lang, 24, true)),
      ]);
    } catch {
      // A font that fails to load falls back to the generic sans-serif for
      // both measuring and drawing, which is at least internally consistent.
    }
  }

  const W = DOTS;
  const PAD = 10;
  const contentW = W - PAD * 2;
  // Matches the English receipt: `rasterize()`'s default logo width (384 of
  // 576 dots), and the shop name/total's `GS !` double-width-double-height
  // text (roughly a 40px cap height at this canvas's 1-dot-per-pixel scale).
  const LOGO_W = 384;
  const NAME_TOTAL_SIZE = 40;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = 10; // resized once the real height is known
  const ctx = canvas.getContext("2d")!;

  const wrapMeasured = (text: string, size: number, bold: boolean): string[] => {
    ctx.font = font(lang, size, bold);
    const words = text.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (!line || ctx.measureText(test).width <= contentW) line = test;
      else {
        out.push(line);
        line = w;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };

  const lines: ImgLine[] = [];
  const addText = (text: string, align: "left" | "center" | "right" = "left", size = 24, bold = false) =>
    lines.push({ kind: "text", text, align, size, bold });
  const addWrapped = (text: string, size = 24, bold = false) =>
    wrapMeasured(text, size, bold).forEach((l) => addText(l, "left", size, bold));
  const addRow = (left: string, right: string, size = 24, bold = false) =>
    lines.push({ kind: "row", left, right, size, bold });
  const rule = () => lines.push({ kind: "rule" });

  if (logoImg) lines.push({ kind: "logo" });
  addText(pick(shop.tagline, lang).toUpperCase(), "center", 20);
  addText(pick(shop.name, lang), "center", NAME_TOTAL_SIZE, true);
  addText(t("receipt.tel", { tel: shop.tel }), "center", 20);
  addText(shop.web, "center", 20);
  rule();
  addRow(t("receipt.billNumber"), bill.billNumber, 22);
  addRow(t("receipt.date"), `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`, 22);
  addRow(t("receipt.time"), `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`, 22);
  rule();

  for (const i of bill.items) {
    addWrapped(i.name, 22, true);
    addRow(`${i.qty} x ${CURRENCY} ${money(i.price)}`, `${CURRENCY} ${money(lineGross(i))}`, 22, false);
    const lineOff = lineDiscount(i);
    if (i.discount && lineOff > 0) {
      addRow(t("receipt.discountLine", { desc: describeDiscount(i.discount) }), `-${CURRENCY} ${money(lineOff)}`, 20);
    }
  }

  rule();
  addRow(t("receipt.subtotal"), `${CURRENCY} ${money(sub)}`, 22);
  if (billOff > 0) {
    const label = bill.billDiscount
      ? t("receipt.billDiscount", { desc: describeDiscount(bill.billDiscount) })
      : t("receipt.billDiscountPlain");
    addRow(label, `-${CURRENCY} ${money(billOff)}`, 22);
  }
  if (off > 0) addRow(t("receipt.youSaved"), `-${CURRENCY} ${money(off)}`, 22, true);
  addRow(t("receipt.total"), `${CURRENCY} ${money(total)}`, NAME_TOTAL_SIZE, true);
  rule();
  addText(pick(shop.footer[0], lang), "center", 24, true);
  addText(pick(shop.footer[1], lang), "center", 20);
  addText(pick(shop.footer[2], lang), "center", 20);

  // Layout pass: turn each line into a y position, then size the canvas.
  const logoH = logoImg ? Math.round((logoImg.naturalHeight / logoImg.naturalWidth) * LOGO_W) : 0;
  const positioned: { line: ImgLine; y: number }[] = [];
  let y = PAD;
  for (const line of lines) {
    if (line.kind === "logo") {
      positioned.push({ line, y });
      y += logoH + 14;
      continue;
    }
    if (line.kind === "rule") {
      positioned.push({ line, y });
      y += 16;
      continue;
    }
    const lh = Math.round(line.size * 1.5);
    y += lh;
    positioned.push({ line, y });
    y += 6;
  }
  y += PAD;

  canvas.height = y;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.textBaseline = "alphabetic";

  for (const { line, y: ly } of positioned) {
    if (line.kind === "logo") {
      if (logoImg) {
        ctx.drawImage(logoImg, (W - LOGO_W) / 2, ly, LOGO_W, logoH);
      }
      continue;
    }
    if (line.kind === "rule") {
      // Dashed, to match the row of hyphens ("-".repeat(COLS)) the English
      // receipt prints as its separator.
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD, ly + 7);
      ctx.lineTo(W - PAD, ly + 7);
      ctx.stroke();
      ctx.setLineDash([]);
      continue;
    }
    if (line.kind === "text") {
      ctx.font = font(lang, line.size, line.bold);
      if (line.align === "center") {
        // `textAlign: "center"` centers by advance width, which assumes the
        // glyphs are visually balanced around it — not a safe assumption for
        // Sinhala/Tamil, whose combining vowel signs can sit to one side of
        // their base consonant and pull the rendered ink off-center even
        // though the API reports it as centered. Centering the actual
        // rendered bounding box instead keeps it visually centered.
        ctx.textAlign = "left";
        const m = ctx.measureText(line.text);
        const x = W / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
        ctx.fillText(line.text, x, ly);
      } else {
        ctx.textAlign = line.align;
        ctx.fillText(line.text, line.align === "left" ? PAD : W - PAD, ly);
      }
      continue;
    }
    ctx.font = font(lang, line.size, line.bold);
    ctx.textAlign = "left";
    ctx.fillText(line.left, PAD, ly);
    ctx.textAlign = "right";
    ctx.fillText(line.right, W - PAD, ly);
  }

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bytesPerRow = canvas.width / 8;
  const bmp = new Uint8Array(bytesPerRow * canvas.height);
  for (let py = 0; py < canvas.height; py++) {
    for (let px = 0; px < canvas.width; px++) {
      const o = (py * canvas.width + px) * 4;
      const lum = (data[o] * 299 + data[o + 1] * 587 + data[o + 2] * 114) / 1000;
      if (data[o + 3] > 64 && lum < 160) bmp[py * bytesPerRow + (px >> 3)] |= 0x80 >> (px & 7);
    }
  }

  const b = new Buf().init();
  // Defensive: `ESC @` is supposed to reset line spacing on its own, but on
  // flaky clone firmware a leftover `ESC 3` from an earlier job has been seen
  // to survive init and corrupt the very first band of the very next image.
  b.raw(ESC, 0x32).align("left");
  b.image({ bytesPerRow, height: canvas.height, bmp }, shop.imageLineSpacing);
  b.feed(4);
  if (openDrawer) b.drawer();
  b.cut();
  return b.out();
}

/**
 * Builds the full ESC/POS byte stream for a bill, in whatever language the
 * shop has configured for its receipts. English uses fast plain-text ESC/POS;
 * Sinhala and Tamil are rendered as one raster image, since the printer's
 * codepage has no glyphs for those scripts.
 */
export async function buildReceiptFor(
  bill: Bill,
  shop: ShopSettings,
  logo: Bitmap | null,
  logoImg: HTMLImageElement | null,
  openDrawer: boolean
): Promise<Uint8Array> {
  if (shop.billLanguage === "en") return buildReceipt(bill, shop, logo, openDrawer);
  return buildReceiptImage(bill, shop, shop.billLanguage, logoImg, openDrawer);
}
