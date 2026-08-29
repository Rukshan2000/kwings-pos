import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api, SaleForReturn } from "../api";
import { lkr } from "../types";

export default function Returns() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [sale, setSale] = useState<SaleForReturn | null>(null);
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [refundMethod, setRefundMethod] = useState("cash");
  const [findError, setFindError] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const find = useMutation({
    mutationFn: () => api.findSaleForReturn(invoiceNumber),
    onSuccess: (s) => {
      setSale(s);
      setQtys({});
      setFindError("");
      setResult(null);
    },
    onError: (e) => {
      setSale(null);
      setFindError(e instanceof Error ? e.message : String(e));
    },
  });

  const submit = useMutation({
    mutationFn: () => {
      const lines = sale!.lines
        .filter((l) => Number(qtys[l.sale_line_id]) > 0)
        .map((l) => ({ sale_line_id: l.sale_line_id, quantity: qtys[l.sale_line_id] }));
      return api.createReturn({
        sale_id: sale!.sale_id,
        lines,
        reason: reason.trim() || null,
        refund_method: refundMethod,
      });
    },
    onSuccess: (r) => {
      setResult(t("returns.refunded", { amount: lkr(Number(r.total)) }));
      setQtys({});
      setReason("");
      qc.invalidateQueries({ queryKey: ["stock-levels"] });
      find.mutate();
    },
    onError: (e) => {
      setResult(null);
      setFindError(e instanceof Error ? e.message : String(e));
    },
  });

  const total = sale
    ? sale.lines.reduce((sum, l) => {
        const qty = Number(qtys[l.sale_line_id]) || 0;
        const unitRefund = Number(l.line_total) / Number(l.quantity);
        return sum + unitRefund * qty;
      }, 0)
    : 0;

  const anyQtySelected = Object.values(qtys).some((v) => Number(v) > 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
      <div className="card p-6 space-y-5">
        <h2 className="text-sm font-semibold text-brand-700">{t("returns.title")}</h2>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            find.mutate();
          }}
        >
          <input
            className="field flex-1"
            placeholder={t("returns.invoicePlaceholder")}
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            required
          />
          <button type="submit" className="btn-primary" disabled={find.isPending}>
            {find.isPending ? t("common.loading") : t("returns.find")}
          </button>
        </form>
        {findError && <p className="text-sm text-amber-600">{findError}</p>}

        {sale && (
          <>
            <div className="text-sm text-slate-500">
              <p>
                <span className="font-medium text-slate-800">{sale.invoice_number}</span>
                {sale.customer_name && ` · ${sale.customer_name}`}
              </p>
              {sale.completed_at && <p className="text-xs text-slate-400">{new Date(sale.completed_at).toLocaleString()}</p>}
            </div>

            <div className="overflow-x-auto -mx-2">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs font-medium text-slate-500 border-b border-slate-200">
                    <th className="px-2 py-2.5">{t("returns.product")}</th>
                    <th className="px-2 py-2.5">{t("returns.sold")}</th>
                    <th className="px-2 py-2.5">{t("returns.alreadyReturned")}</th>
                    <th className="px-2 py-2.5">{t("returns.returnQty")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sale.lines.map((l) => {
                    const returnable = Number(l.quantity) - Number(l.already_returned);
                    return (
                      <tr key={l.sale_line_id}>
                        <td className="px-2 py-2.5 text-slate-800">{l.product_name}</td>
                        <td className="px-2 py-2.5 text-slate-500">{l.quantity} {l.unit_code}</td>
                        <td className="px-2 py-2.5 text-slate-500">{l.already_returned}</td>
                        <td className="px-2 py-2.5">
                          <input
                            type="number" min="0" step="0.001" max={returnable}
                            className="field !py-1 w-24"
                            disabled={returnable <= 0}
                            value={qtys[l.sale_line_id] ?? ""}
                            onChange={(e) => setQtys({ ...qtys, [l.sale_line_id]: e.target.value })}
                            placeholder="0"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <label className="block">
              <span className="label mb-1 block">{t("returns.reason")}</span>
              <input className="field" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>

            <label className="block max-w-xs">
              <span className="label mb-1 block">{t("returns.refundMethod")}</span>
              <select className="select" value={refundMethod} onChange={(e) => setRefundMethod(e.target.value)}>
                <option value="cash">{t("purchasing.methodCash")}</option>
                <option value="card">{t("purchasing.methodCard")}</option>
                <option value="bank_transfer">{t("purchasing.methodBankTransfer")}</option>
                <option value="credit">{t("returns.methodCredit")}</option>
              </select>
            </label>
          </>
        )}
      </div>

      {sale && (
        <div className="card p-6 space-y-3">
          <h2 className="text-sm font-semibold text-brand-700">{t("returns.summary")}</h2>
          <p className="flex justify-between text-sm font-medium">
            <span className="text-slate-600">{t("returns.refundTotal")}</span>
            <span className="text-slate-800">{lkr(total)}</span>
          </p>
          <button
            type="button"
            className="btn-primary w-full"
            disabled={!anyQtySelected || submit.isPending}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? t("common.saving") : t("returns.processReturn")}
          </button>
          {result && <p className="text-sm text-emerald-600">{result}</p>}
        </div>
      )}
    </div>
  );
}
