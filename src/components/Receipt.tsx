import i18n from "../i18n";
import { BillLanguage, CURRENCY, getShopSettings, pick, ShopSettings } from "../shop";
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
} from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Always rendered in the shop's configured bill language, not the cashier's
 * current UI language — the two are independent settings, and a receipt
 * should not change language because someone flipped the till's interface.
 *
 * `shop`/`lang` can be passed to preview settings that have not been saved
 * yet (Settings' Bill Content tab); every other caller lets them default to
 * whatever is actually persisted.
 */
export default function Receipt({
  bill,
  shop: shopOverride,
  lang: langOverride,
}: {
  bill: Bill;
  shop?: ShopSettings;
  lang?: BillLanguage;
}) {
  const shop = shopOverride ?? getShopSettings();
  const lang = langOverride ?? shop.billLanguage;
  const t = i18n.getFixedT(lang);
  const d = bill.date;
  const sub = subtotal(bill.items);
  const off = discountTotal(bill.items, bill.billDiscount);
  const billOff = billDiscountAmount(bill.items, bill.billDiscount);
  const total = grandTotal(bill.items, bill.billDiscount);

  return (
    <div className="receipt" id="receipt">
      <div className="r-head">
        <img className="r-logo" src={shop.logo} alt="" />
        <div className="r-tagline">{pick(shop.tagline, lang).split("").join(" ")}</div>
        <div className="r-name">{pick(shop.name, lang)}</div>
        <div className="r-contact">{t("receipt.tel", { tel: shop.tel })}</div>
        <div className="r-contact">{shop.web}</div>
      </div>

      <div className="r-sep" />

      <div className="r-meta">
        <div>
          <span>{t("receipt.billNumber")}</span>
          <b>{bill.billNumber}</b>
        </div>
        <div>
          <span>{t("receipt.date")}</span>
          <span>{`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`}</span>
        </div>
        <div>
          <span>{t("receipt.time")}</span>
          <span>{`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`}</span>
        </div>
      </div>

      <div className="r-sep" />

      <div className="r-items">
        {bill.items.map((i) => (
          <div className="r-item" key={i.id}>
            <div className="r-item-name">{i.name}</div>
            <div className="r-item-line">
              <span>
                {i.qty} x {CURRENCY} {money(i.price)}
              </span>
              <b>
                {CURRENCY} {money(lineGross(i))}
              </b>
            </div>
            {i.discount && lineDiscount(i) > 0 && (
              <div className="r-item-line">
                <span>{t("receipt.discountLine", { desc: describeDiscount(i.discount) })}</span>
                <b>
                  −{CURRENCY} {money(lineDiscount(i))}
                </b>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="r-sep" />

      <div className="r-sum">
        <span>{t("receipt.subtotal")}</span>
        <span>
          {CURRENCY} {money(sub)}
        </span>
      </div>
      {billOff > 0 && (
        <div className="r-sum">
          <span>
            {bill.billDiscount
              ? t("receipt.billDiscount", { desc: describeDiscount(bill.billDiscount) })
              : t("receipt.billDiscountPlain")}
          </span>
          <span>
            −{CURRENCY} {money(billOff)}
          </span>
        </div>
      )}
      {off > 0 && (
        <div className="r-sum">
          <span>{t("receipt.youSaved")}</span>
          <span>
            −{CURRENCY} {money(off)}
          </span>
        </div>
      )}
      <div className="r-total">
        <span>{t("receipt.total")}</span>
        <span>
          {CURRENCY} {money(total)}
        </span>
      </div>

      <div className="r-sep" />

      <div className="r-foot">
        <div className="r-thanks">{pick(shop.footer[0], lang)}</div>
        <div>{pick(shop.footer[1], lang)}</div>
        <div className="r-italic">{pick(shop.footer[2], lang)}</div>
      </div>
    </div>
  );
}
