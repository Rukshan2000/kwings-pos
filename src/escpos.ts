// ESC/POS byte stream for a generic 80mm thermal printer.
// 80mm at Font A = 48 characters per line, 576 dots wide.

import { SHOP } from "./shop";
import { Bill, lineTotal, money, subtotal } from "./types";

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

/**
 * Rasterize an image to a GS v 0 bitmap. Anything darker than mid-grey (or any
 * opaque pixel of a transparent-background logo) burns as a dot.
 */
export async function rasterize(src: string, maxWidth = 384): Promise<Uint8Array | null> {
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

    const head = new Uint8Array([
      GS, 0x76, 0x30, 0x00,
      bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
      h & 0xff, (h >> 8) & 0xff,
    ]);
    const out = new Uint8Array(head.length + bmp.length);
    out.set(head);
    out.set(bmp, head.length);
    return out;
  } catch {
    return null; // a missing logo must never block a sale
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

export function buildReceipt(bill: Bill, logo: Uint8Array | null, openDrawer = false) {
  const b = new Buf().init();
  const d = bill.date;
  const sub = subtotal(bill.items);
  const dash = "-".repeat(COLS);

  b.align("center");
  if (logo) b.bytes(logo).feed(1);

  b.text(SHOP.tagline.toUpperCase().split("").join(" ")).raw(0x0a);
  b.bold(true).size(2, 2).line(SHOP.name).size(1, 1).bold(false);
  b.line(`Tel: ${SHOP.tel}`);
  b.line(SHOP.web);

  b.align("left").line(dash);
  b.line(row("Bill Number:", bill.billNumber));
  b.line(row("Date:", `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`));
  b.line(row("Time:", `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`));
  b.line(dash);

  for (const i of bill.items) {
    b.bold(true);
    for (const l of wrap(i.name)) b.line(l);
    b.bold(false);
    b.line(
      row(
        `  ${i.qty} x ${SHOP.currency} ${money(i.price)}`,
        `${SHOP.currency} ${money(lineTotal(i))}`
      )
    );
  }

  b.line(dash);
  b.line(row("Subtotal:", `${SHOP.currency} ${money(sub)}`));
  // Double width halves the usable columns, so lay the TOTAL out over 24.
  b.bold(true).size(2, 2);
  b.line(row("TOTAL:", `${SHOP.currency} ${money(sub)}`, COLS / 2));
  b.size(1, 1).bold(false);
  b.line(dash);

  b.align("center");
  b.bold(true).line(SHOP.footer[0]).bold(false);
  b.line(SHOP.footer[1]);
  b.line(SHOP.footer[2]);

  b.feed(4);
  if (openDrawer) b.drawer();
  b.cut();

  return b.out();
}
