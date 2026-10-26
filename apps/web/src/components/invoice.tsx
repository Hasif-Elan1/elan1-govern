import { formatINR } from "@gate/core/browser";

export interface InvoiceDoc {
  filename: string;
  number: string;
  date: string;
  seller: { name: string; gstin: string; address: string };
  buyer: { name: string; gstin: string; address: string };
  lines: { description: string; hsn: string; qty: number; rate: number; amount: number }[];
  taxable_inr: number;
  cgst_inr: number;
  sgst_inr: number;
  igst_inr: number;
  total_inr: number;
}

/** A rendering of the invoice the agent read, laid out like a GST tax invoice. */
export function InvoicePreview({ inv }: { inv: InvoiceDoc }) {
  const rows: [string, number][] = [["Taxable value", inv.taxable_inr]];
  if (inv.igst_inr) rows.push(["IGST 18%", inv.igst_inr]);
  else rows.push(["CGST 9%", inv.cgst_inr], ["SGST 9%", inv.sgst_inr]);
  return (
    <figure className="overflow-hidden rounded-md border border-line bg-white text-[#1a1b20] shadow-[0_1px_0_rgba(0,0,0,0.04)]">
      <figcaption className="flex items-center justify-between border-b border-[#e6e6e3] bg-[#f6f6f4] px-3 py-1.5 text-xs text-[#6e707a]">
        <span>{inv.filename}</span>
        <span>Attachment</span>
      </figcaption>
      <div className="p-4 text-[12.5px] leading-relaxed">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[14px] font-semibold">{inv.seller.name}</p>
            <p className="text-[#4a4c55]">{inv.seller.address}</p>
            <p className="text-[#4a4c55]">GSTIN {inv.seller.gstin}</p>
          </div>
          <div className="text-right">
            <p className="font-semibold">Tax invoice</p>
            <p className="text-[#4a4c55]">{inv.number}</p>
            <p className="text-[#4a4c55]">{inv.date}</p>
          </div>
        </div>
        <p className="mt-3 text-[#4a4c55]">
          Bill to <span className="text-[#1a1b20]">{inv.buyer.name}</span>, GSTIN {inv.buyer.gstin}
        </p>
        <table className="mt-3 w-full border-collapse">
          <thead>
            <tr className="border-y border-[#e6e6e3] text-left text-[#6e707a]">
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 font-medium">HSN</th>
              <th className="py-1 text-right font-medium">Qty</th>
              <th className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.description} className="border-b border-[#f0f0ee] align-top">
                <td className="py-1 pr-2">{l.description}</td>
                <td className="py-1 pr-2 text-[#6e707a]">{l.hsn}</td>
                <td className="py-1 text-right tabular-nums">{l.qty}</td>
                <td className="py-1 text-right tabular-nums">{formatINR(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="mt-2 ml-auto grid max-w-[220px] grid-cols-[1fr_auto] gap-x-4 tabular-nums">
          {rows.map(([k, v]) => (
            <div key={k} className="contents text-[#4a4c55]">
              <dt>{k}</dt>
              <dd className="text-right">{formatINR(v)}</dd>
            </div>
          ))}
          <dt className="mt-1 border-t border-[#e6e6e3] pt-1 font-semibold">Total</dt>
          <dd className="mt-1 border-t border-[#e6e6e3] pt-1 text-right font-semibold">{formatINR(inv.total_inr)}</dd>
        </dl>
      </div>
    </figure>
  );
}
