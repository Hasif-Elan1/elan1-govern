import { pct } from '@/lib/format';
import { GST_RATE, REFUSAL_FACTOR } from '@/lib/pricing';
import { money, monthLabelLong, type Currency } from './model';
import { SUPPLIER, taxSplit, type ChainInvoice } from './chainMeter';
import { LIST_PRICE, OUTCOME_LABEL } from '@/mock/billing';
import { lineText } from './InvoiceDrawer';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Opens the tax invoice in a new window, laid out for "Print or save as PDF". */
export function printInvoice(inv: ChainInvoice, cur: Currency) {
  const w = window.open('', '_blank');
  if (!w) return false;
  const rows = inv.lines.map((l, i) => {
    const t = lineText(l, cur);
    return `<tr><td>${i + 1}</td><td><b>${esc(t.title)}</b>${t.sub ? `<br><small>${esc(t.sub)}</small>` : ''}${l.held ? `<br><small class="held">Held in dispute (receipt #${l.held.seq}) — not payable until resolved</small>` : ''}${l.settled ? `<br><small>Dispute ${esc(OUTCOME_LABEL[l.settled.outcome].toLowerCase())} (receipt #${l.settled.seq})${l.settled.creditNote ? ` — credit note ${esc(l.settled.creditNote)}` : '' }</small>` : ''}</td><td>${SUPPLIER.sac}</td><td class="r">${esc(money(l.amount, cur, true))}</td></tr>`;
  }).join('');
  const tax = taxSplit(inv).map((x) => `<tr><td></td><td>${esc(x.label)}</td><td></td><td class="r">${esc(money(x.amount, cur, true))}</td></tr>`).join('');
  const period = inv.kind === 'credit_note' ? `Credit note against ${inv.creditFor?.invoice ?? ''} (${monthLabelLong(inv.period)})` : inv.kind === 'deployment' ? `${day(inv.periodStart)} to ${day(inv.periodEnd)}` : monthLabelLong(inv.period);
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(inv.number)}</title><style>
body{font-family:"IBM Plex Sans",system-ui,sans-serif;color:#0A1320;max-width:800px;margin:32px auto;padding:0 24px;font-size:12.5px}
h1{font-family:"Schibsted Grotesk",system-ui,sans-serif;margin:0 0 4px;font-size:22px}.k{letter-spacing:.08em;text-transform:uppercase;font-size:10.5px;color:#8A4229;font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid #CDD6E0;margin-top:16px}.grid>div{padding:10px 12px}.grid>div+div{border-left:1px solid #CDD6E0}
table{width:100%;border-collapse:collapse;margin-top:18px}td,th{border-bottom:1px solid #CDD6E0;padding:7px 8px;vertical-align:top;text-align:left}th{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:#3B506A}
.r{text-align:right;white-space:nowrap}small{color:#3B506A}.held{color:#8a5a00}.tot td{font-weight:600}.mono{font-family:"IBM Plex Mono",monospace;font-size:11px;word-break:break-all}
.note{margin-top:20px;padding:10px 12px;background:#E7ECF1;border-left:3px solid #16243A}@media print{button{display:none}}</style></head><body>
<button onclick="window.print()">Print or save as PDF</button>
<p class="k">${esc(SUPPLIER.brand)} · ${inv.kind === 'credit_note' ? 'Credit note' : 'Tax invoice'}</p>
<h1>${esc(inv.number)}</h1>
<p>${esc(period)} · ${esc(inv.status === 'draft' ? 'Draft — the month is still open' : inv.status === 'paid' ? 'Paid' : inv.status === 'held' ? 'Held — the period is not reconciled; not issued until it is' : inv.status === 'credit' ? 'Credit note' : 'Due')} · Issued ${esc(day(inv.issuedAt))}${inv.dueAt ? ` · Due ${esc(day(inv.dueAt))}` : ''}</p>
<div class="grid"><div><b>Supplier</b><br>${esc(SUPPLIER.name)}<br>${esc(SUPPLIER.address)}<br>GSTIN <span class="mono">${esc(SUPPLIER.gstin)}</span> · State code ${esc(SUPPLIER.stateCode)}</div>
<div><b>Bill to</b><br>${esc(inv.customer.name)}<br>Place of supply: ${esc(inv.placeOfSupply)}<br>Service: SAC ${esc(SUPPLIER.sac)} — ${esc(SUPPLIER.sacLabel)}</div></div>
<table><thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="r">Taxable value</th></tr></thead><tbody>${rows}
<tr class="tot"><td></td><td>Taxable value</td><td></td><td class="r">${esc(money(inv.subtotal, cur, true))}</td></tr>${tax}
<tr class="tot"><td></td><td>Total</td><td></td><td class="r">${esc(money(inv.total, cur, true))}</td></tr>
${inv.heldAmount > 0 ? `<tr class="tot"><td></td><td>Payable now (held lines excluded)</td><td></td><td class="r">${esc(money(inv.payableNow, cur, true))}</td></tr>` : ''}</tbody></table>
<p style="margin-top:14px"><b>IRN</b> <span class="mono">${esc(inv.irn)}</span></p>
${inv.fromSeq ? `<p>Metered from receipts #${inv.fromSeq}–#${inv.toSeq} of ${esc(inv.customer.name)}’s chain (${inv.events} governed actions).${inv.partial ? ` Metered from ${esc(day(inv.partial))}, where this copy of the chain starts.` : ''}</p>` : ''}
<p class="note">A refused action costs ${pct(REFUSAL_FACTOR)} of the per-action rate; inside the yearly allowance it uses ${REFUSAL_FACTOR} of an included action. GST at ${pct(GST_RATE)}. ${esc(LIST_PRICE.label)}s, flat to 31 March 2029, then +4% a year. ${esc(SUPPLIER.name)}.</p>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
  return true;
}
