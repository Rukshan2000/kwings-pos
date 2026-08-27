import { SHOP } from "../shop";
import { Bill, lineTotal, money, subtotal } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

export default function Receipt({ bill }: { bill: Bill }) {
  const d = bill.date;
  const sub = subtotal(bill.items);

  return (
    <div className="receipt" id="receipt">
      <div className="r-head">
        <img className="r-logo" src={SHOP.logo} alt="" />
        <div className="r-tagline">{SHOP.tagline.split("").join(" ")}</div>
        <div className="r-name">{SHOP.name}</div>
        <div className="r-contact">Tel: {SHOP.tel}</div>
        <div className="r-contact">{SHOP.web}</div>
      </div>

      <div className="r-sep" />

      <div className="r-meta">
        <div>
          <span>Bill Number:</span>
          <b>{bill.billNumber}</b>
        </div>
        <div>
          <span>Date:</span>
          <span>{`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`}</span>
        </div>
        <div>
          <span>Time:</span>
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
                {i.qty} x {SHOP.currency} {money(i.price)}
              </span>
              <b>
                {SHOP.currency} {money(lineTotal(i))}
              </b>
            </div>
          </div>
        ))}
      </div>

      <div className="r-sep" />

      <div className="r-sum">
        <span>Subtotal:</span>
        <span>
          {SHOP.currency} {money(sub)}
        </span>
      </div>
      <div className="r-total">
        <span>TOTAL:</span>
        <span>
          {SHOP.currency} {money(sub)}
        </span>
      </div>

      <div className="r-sep" />

      <div className="r-foot">
        <div className="r-thanks">{SHOP.footer[0]}</div>
        <div>{SHOP.footer[1]}</div>
        <div className="r-italic">{SHOP.footer[2]}</div>
      </div>
    </div>
  );
}
