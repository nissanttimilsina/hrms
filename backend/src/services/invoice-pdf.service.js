import PDFDocument from 'pdfkit';
import { getSetting } from './settings.service.js';

const npr = (n) => `NPR ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '—');

/** Render an invoice / credit note as a PDF stream (A4). */
export async function renderInvoicePdf(invoice, items, payments = []) {
  const seller = await getSetting('billing.seller');
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: invoice.number, Author: seller.name } });
  const isCredit = invoice.kind === 'CREDIT_NOTE';

  doc.fontSize(20).fillColor('#0f1729').text(isCredit ? 'CREDIT NOTE' : 'TAX INVOICE', 50, 50);
  doc.fontSize(10).fillColor('#64748b').text(invoice.number, 50, 76);
  doc.fillColor('#0f1729').fontSize(11).text(seller.name, 350, 50, { width: 195, align: 'right' });
  doc.fontSize(9).fillColor('#64748b').text([seller.address, seller.pan && `PAN/VAT: ${seller.pan}`, seller.email, seller.phone].filter(Boolean).join('\n'), 350, 66, { width: 195, align: 'right' });

  const bt = invoice.billTo || {};
  doc.moveDown(3).fontSize(9).fillColor('#64748b').text('BILL TO', 50, 140);
  doc.fontSize(11).fillColor('#0f1729').text(bt.name || '—', 50, 154);
  doc.fontSize(9).fillColor('#334155').text([bt.address, bt.pan && `PAN: ${bt.pan}`, bt.email].filter(Boolean).join('\n'), 50, 170);

  const meta = [['Issue date', d(invoice.issuedAt)], ['Due date', d(invoice.dueAt)], ['Status', invoice.status], ...(invoice.periodStart ? [['Service period', `${d(invoice.periodStart)} – ${d(invoice.periodEnd)}`]] : [])];
  meta.forEach(([k, v], i) => {
    doc.fontSize(9).fillColor('#64748b').text(k, 350, 140 + i * 16, { width: 90 });
    doc.fillColor('#0f1729').text(v, 440, 140 + i * 16, { width: 105, align: 'right' });
  });

  let y = 240;
  doc.rect(50, y, 495, 22).fill('#f1f4f8');
  doc.fillColor('#64748b').fontSize(9).text('DESCRIPTION', 58, y + 7).text('QTY', 360, y + 7, { width: 40, align: 'right' }).text('AMOUNT', 420, y + 7, { width: 117, align: 'right' });
  y += 30;
  for (const it of items) {
    doc.fillColor('#334155').fontSize(10).text(it.description, 58, y, { width: 290 });
    const h = doc.heightOfString(it.description, { width: 290 });
    doc.text(String(Number(it.quantity)), 360, y, { width: 40, align: 'right' }).text(npr(it.amount), 420, y, { width: 117, align: 'right' });
    y += Math.max(h, 14) + 10;
  }
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#e5e9f0').stroke();
  y += 10;
  const rows = [['Subtotal', invoice.subtotal], ...(Number(invoice.discount) ? [[`Discount${invoice.couponCode ? ` (${invoice.couponCode})` : ''}`, -invoice.discount]] : []), [`VAT ${Number(invoice.taxRate)}%`, invoice.tax]];
  for (const [k, v] of rows) {
    doc.fontSize(10).fillColor('#64748b').text(k, 330, y, { width: 90 }).fillColor('#0f1729').text(npr(v), 420, y, { width: 117, align: 'right' });
    y += 18;
  }
  doc.rect(330, y, 215, 26).fill('#eff5ff');
  doc.fontSize(11).fillColor('#1d43ad').text(isCredit ? 'Total credited' : 'Total', 338, y + 8).text(npr(invoice.total), 420, y + 8, { width: 117, align: 'right' });
  y += 44;

  const paid = payments.filter((p) => p.status === 'SUCCEEDED');
  if (paid.length) {
    doc.fontSize(9).fillColor('#64748b').text('PAYMENTS', 50, y);
    paid.forEach((p, i) => doc.fillColor('#334155').text(`${d(p.updatedAt)} · ${p.provider.replace('_', ' ')} · ${p.providerRef || p.reference} · ${npr(p.amount)}`, 50, y + 14 + i * 14));
  }
  doc.fontSize(8).fillColor('#94a3b8').text('This is a computer-generated document. Thank you for choosing Lishnu HRMS.', 50, 780, { width: 495, align: 'center' });
  doc.end();
  return doc;
}
