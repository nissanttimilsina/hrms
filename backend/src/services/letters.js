import PDFDocument from 'pdfkit';
import { toBS } from './hr/calendar.js';

/**
 * HR letters: wording and PDF layout. Everything printed comes from `content`, a snapshot frozen
 * when HR issues the letter, so re-downloading a letter later always gives the same document.
 */
export const LETTER_TYPES = {
  EMPLOYMENT: { label: 'Employment verification letter', hint: 'Confirms where you work, your role and since when.' },
  SALARY: { label: 'Salary certificate', hint: 'Employment confirmation with your monthly salary breakdown.' },
  EXPERIENCE: { label: 'Experience letter', hint: 'Your role and period of service, for a new job or study.' },
  BANK: { label: 'Letter to a bank', hint: 'Employment and salary confirmation addressed to a bank, e.g. for a loan or account.' },
  NOC: { label: 'No objection letter', hint: 'States the company has no objection, e.g. for travel, a visa or further study.' },
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
export const bsDate = (ymd) => { const b = toBS(ymd); return `${b.day} ${b.monthName} ${b.year}`; };
const npr = (n) => `NPR ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const TYPE_PHRASE = {
  PERMANENT: 'a permanent employee', PROBATION: 'currently on probation', PART_TIME: 'a part-time employee',
  INTERN: 'an intern', DAILY_WAGE: 'employed on a daily-wage basis',
};

function person(e) {
  const g = e.gender;
  return {
    hon: g === 'MALE' ? 'Mr.' : g === 'FEMALE' ? 'Ms.' : '',
    poss: g === 'MALE' ? 'his' : g === 'FEMALE' ? 'her' : 'their',
    obj: g === 'MALE' ? 'him' : g === 'FEMALE' ? 'her' : 'them',
  };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Subject, greeting and paragraphs (before and after an optional salary table) for a letter snapshot. */
export function compose(c) {
  const e = c.employee;
  const p = person(e);
  const full = [p.hon, e.name].filter(Boolean).join(' ');
  const short = p.hon ? `${p.hon} ${e.lastName}` : e.name;
  const company = c.company.legalName || c.company.name;
  const role = `${e.designation ? `as ${e.designation}` : ''}${e.department ? ` in the ${e.department} department` : ''}${e.branch ? `, ${e.branch}` : ''}`.trim();
  const left = !!e.exitedOn && e.exitedOn <= c.issuedOn;
  const employment = left
    ? `This is to certify that ${full} (employee ID ${e.code}) was employed with ${company} from ${longDate(e.joinedOn)} to ${longDate(e.exitedOn)}${role ? `, ${role}` : ''}.`
    : `This is to certify that ${full} (employee ID ${e.code}) has been working with ${company} since ${longDate(e.joinedOn)}${role ? ` ${role}` : ''}.`;
  const typeLine = !left && (e.employmentType === 'CONTRACT'
    ? `${cap(short)} is employed on a contract${e.contractEndOn ? ` until ${longDate(e.contractEndOn)}` : ''}.`
    : TYPE_PHRASE[e.employmentType] ? `${cap(short)} is ${TYPE_PHRASE[e.employmentType]} of the company.` : null);
  const forPurpose = `This letter is issued at ${p.poss} request for the purpose of ${c.purpose.replace(/\.$/, '')}.`;
  const paras = []; const after = [];
  let subject; let table = null;
  const salaryTable = () => c.salary && {
    caption: `${cap(p.poss)} ${left ? 'last drawn' : 'current'} monthly salary:`,
    rows: [['Basic salary', npr(c.salary.basic)], ...c.salary.components.map((x) => [x.name, npr(x.amount)])],
    total: ['Gross monthly salary', npr(c.salary.gross)],
  };

  switch (c.type) {
    case 'SALARY':
      subject = 'Salary certificate';
      paras.push(employment, ...(typeLine ? [typeLine] : []));
      table = salaryTable();
      after.push('Income tax, social security and other deductions required by law apply to the amounts above.');
      break;
    case 'EXPERIENCE':
      subject = 'Experience letter';
      paras.push(employment);
      paras.push(left
        ? `We thank ${short} for ${p.poss} contribution to the company and wish ${p.obj} success in the future.`
        : `${cap(short)} continues to work with us in this role.`);
      break;
    case 'BANK':
      subject = 'Confirmation of employment and salary';
      paras.push(employment, ...(typeLine ? [typeLine] : []));
      table = salaryTable();
      if (c.bank?.bankName && c.bank?.last4) after.push(`${cap(p.poss)} salary is paid into account number ending ${c.bank.last4} at ${c.bank.bankName}.`);
      after.push('This letter confirms employment and salary only. It does not make the company a guarantor for any loan or obligation.');
      break;
    case 'NOC':
      subject = 'No objection certificate';
      paras.push(employment, ...(typeLine ? [typeLine] : []));
      paras.push(`The company has no objection to the following: ${c.purpose.replace(/\.$/, '')}.`);
      if (!left) paras.push(`${cap(short)} will continue in ${p.poss} role with the company.`);
      break;
    default:
      subject = 'Employment verification';
      paras.push(employment, ...(typeLine ? [typeLine] : []));
  }
  if (c.extraParagraph) after.push(c.extraParagraph);
  if (c.type !== 'NOC') after.push(forPurpose);
  return { subject, toWhom: !c.addressedTo, paras, table, after };
}

/** Render the letter PDF onto a writable stream (an HTTP response). */
export function renderLetterPdf(out, c, { color = '#1D4ED8' } = {}) {
  const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 50, bottom: 60, left: 64, right: 64 }, info: { Title: `${LETTER_TYPES[c.type].label} · ${c.reference}`, Author: c.company.legalName || c.company.name } });
  doc.pipe(out);
  const W = doc.page.width - 128; const L = 64;
  const ink = '#0f1729'; const grey = '#64748b';

  // Letterhead
  doc.font('Helvetica-Bold').fontSize(18).fillColor(color).text(c.company.legalName || c.company.name, L, 50, { width: W });
  const contact = [c.company.address, [c.company.phone, c.company.email, c.company.website].filter(Boolean).join('  ·  '), c.company.pan && `PAN ${c.company.pan}`].filter(Boolean);
  doc.font('Helvetica').fontSize(9).fillColor(grey);
  contact.forEach((line) => doc.text(line, { width: W }));
  const y0 = doc.y + 8;
  doc.moveTo(L, y0).lineTo(L + W, y0).lineWidth(1.2).strokeColor(color).stroke();

  // Reference and date
  doc.fontSize(10).fillColor(ink).text(`Ref: ${c.reference}`, L, y0 + 14);
  doc.text(`Date: ${longDate(c.issuedOn)}`, L, y0 + 14, { width: W, align: 'right' });
  doc.fillColor(grey).fontSize(9).text(`(${bsDate(c.issuedOn)} BS)`, L, y0 + 28, { width: W, align: 'right' });
  doc.moveDown(2);

  const body = compose(c);
  doc.fillColor(ink).fontSize(11);
  if (c.addressedTo) {
    doc.font('Helvetica').text('To,', L);
    c.addressedTo.split(/\r?\n/).forEach((line) => doc.text(line.trim(), L));
    doc.moveDown();
  }
  doc.font('Helvetica-Bold').text(`Subject: ${body.subject}`, L, doc.y, { underline: true });
  doc.moveDown();
  doc.font('Helvetica').text(body.toWhom ? 'To whom it may concern,' : 'Dear Sir or Madam,', L);
  doc.moveDown(0.8);

  const para = (s) => { doc.font('Helvetica').fontSize(11).fillColor(ink).text(s, L, doc.y, { width: W, align: 'justify', lineGap: 3 }); doc.moveDown(0.8); };
  body.paras.forEach(para);
  if (body.table) drawTable(doc, body.table, L, W, color);
  body.after.forEach(para);

  // Signature block
  if (doc.y > doc.page.height - 230) doc.addPage();
  doc.moveDown(0.6).font('Helvetica').fontSize(11).fillColor(ink).text('Yours sincerely,', L);
  const sy = doc.y + 48;
  doc.moveTo(L, sy).lineTo(L + 180, sy).lineWidth(0.6).strokeColor('#94a3b8').stroke();
  doc.font('Helvetica-Bold').text(c.signatory.name || 'Authorised signatory', L, sy + 6);
  doc.font('Helvetica').fillColor(grey).fontSize(10);
  if (c.signatory.title) doc.text(c.signatory.title, L);
  doc.text(`For ${c.company.legalName || c.company.name}`, L);
  doc.fontSize(8).text('Signature and company stamp', L + 300, sy - 2, { width: W - 300, align: 'right' });

  // Verification footer on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i += 1) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // writing inside the bottom margin must not start a new page
    const fy = doc.page.height - 48;
    doc.moveTo(L, fy - 6).lineTo(L + W, fy - 6).lineWidth(0.5).strokeColor('#e5e9f0').stroke();
    doc.font('Helvetica').fontSize(8).fillColor(grey)
      .text(`Check that this letter is genuine at ${c.verifyUrl}  ·  Verification code ${c.verifyCode}`, L, fy, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
}

function drawTable(doc, t, L, W, color) {
  doc.font('Helvetica').fontSize(11).fillColor('#0f1729').text(t.caption, L, doc.y, { width: W });
  doc.moveDown(0.5);
  const x = L + 16; const w = Math.min(380, W - 32); let y = doc.y;
  const row = ([k, v], bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).fillColor('#0f1729');
    doc.text(k, x + 8, y + 5, { width: w - 150 });
    doc.text(v, x + w - 140, y + 5, { width: 132, align: 'right' });
    y += 21;
  };
  doc.rect(x, y, w, 21 * (t.rows.length + 1)).lineWidth(0.6).strokeColor('#cbd5e1').stroke();
  t.rows.forEach((r) => row(r, false));
  doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).strokeColor(color).stroke();
  row(t.total, true);
  doc.y = y + 10;
  doc.x = L;
}
