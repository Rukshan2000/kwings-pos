import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getShopSettings, onShopSettingsChangeAnywhere } from "../shop";
import {
  CustomerDisplayPayload,
  discountTotal,
  grandTotal,
  lineDiscount,
  lineTotal,
  lkr,
  money,
  subtotal as grossSubtotal,
} from "../types";

export const CUSTOMER_DISPLAY_EVENT = "customer-display:update";

const EMPTY: CustomerDisplayPayload = { items: [], shopName: "" };

/** Cycles through the ad queue on a loop, shown only while the cart is idle. */
function AdPlayer({ queue }: { queue: string[] }) {
  const [index, setIndex] = useState(0);
  // The queue can change (or shrink) while playing — clamp rather than
  // let a stale index point past the end.
  const clamped = index < queue.length ? index : 0;
  const src = useMemo(() => convertFileSrc(queue[clamped]), [queue, clamped]);

  return (
    <video
      key={src}
      className="h-full w-full object-contain bg-black"
      src={src}
      autoPlay
      muted
      playsInline
      onEnded={() => setIndex((i) => (i + 1 < queue.length ? i + 1 : 0))}
      onError={() => setIndex((i) => (i + 1 < queue.length ? i + 1 : 0))}
    />
  );
}

/** The customer-facing window: a second, unauthenticated render tree (picked
    by window label in `main.tsx`, not by route) that only ever reflects what
    the till pushes over `CUSTOMER_DISPLAY_EVENT` — it holds no state of its
    own and makes no API calls. */
export default function CustomerDisplay() {
  const [data, setData] = useState<CustomerDisplayPayload>(EMPTY);
  const [shop, setShop] = useState(getShopSettings);

  useEffect(() => {
    const un = listen<CustomerDisplayPayload>(CUSTOMER_DISPLAY_EVENT, (e) => setData(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Settings are edited on the till's window, not this one — pick up saves
  // made there via the cross-window `storage` event.
  useEffect(() => onShopSettingsChangeAnywhere(setShop), []);

  const { items, billDiscount, completedInvoice } = data;
  const subtotal = grossSubtotal(items);
  const savings = discountTotal(items, billDiscount);
  const toPay = grandTotal(items, billDiscount);

  if (completedInvoice) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-slate-900 text-white">
        <p className="text-2xl text-slate-300">Thank you!</p>
        <p className="mt-2 text-lg text-slate-400">Invoice {completedInvoice}</p>
        <p className="mt-8 text-4xl font-semibold">{lkr(toPay)}</p>
      </div>
    );
  }

  if (items.length === 0 && shop.customerDisplay.adsEnabled && shop.customerDisplay.videoQueue.length > 0) {
    return (
      <div className="h-screen w-screen bg-black">
        <AdPlayer queue={shop.customerDisplay.videoQueue} />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-slate-900 text-white">
      <div className="border-b border-slate-700 px-8 py-5">
        <h1 className="text-xl font-semibold">{data.shopName || "Your Order"}</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-4">
        {items.length === 0 ? (
          <p className="mt-16 text-center text-lg text-slate-500">Welcome — your items will appear here.</p>
        ) : (
          <div className="space-y-2">
            {items.map((l) => {
              const off = lineDiscount(l);
              return (
                <div key={l.id} className="flex items-center justify-between border-b border-slate-800 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg">{l.name}</p>
                    <p className="text-sm text-slate-400">
                      {l.qty} × {lkr(l.price)}
                    </p>
                  </div>
                  <div className="text-right">
                    {off > 0 && <div className="text-sm text-slate-500 line-through">{money(l.qty * l.price)}</div>}
                    <span className="text-lg font-semibold">{money(lineTotal(l))}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-slate-700 px-8 py-5">
        <div className="flex justify-between text-slate-300">
          <span>Subtotal</span>
          <span>{lkr(subtotal)}</span>
        </div>
        {savings > 0 && (
          <div className="flex justify-between text-emerald-400">
            <span>Discount</span>
            <span>−{lkr(savings)}</span>
          </div>
        )}
        <div className="flex justify-between pt-2 text-2xl font-semibold">
          <span>Total</span>
          <span>{lkr(toPay)}</span>
        </div>
      </div>
    </div>
  );
}
