import NepaliDateModule from 'nepali-date-converter';

const NepaliDate = NepaliDateModule.default ?? NepaliDateModule;
export const BS_MONTHS = ['Baisakh', 'Jestha', 'Asar', 'Shrawan', 'Bhadra', 'Asoj', 'Kartik', 'Mangsir', 'Poush', 'Magh', 'Falgun', 'Chaitra'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** 'YYYY-MM-DD' business date of an instant in the tenant's timezone. */
export function localDate(instant = new Date(), tz = 'Asia/Kathmandu') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}
/** Minutes since local midnight. */
export function localMinutes(instant, tz = 'Asia/Kathmandu') {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant).split(':').map(Number);
  return h * 60 + m;
}
export const timeToMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
export const weekday = (ymd) => DAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
export const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export function* eachDate(from, to) { for (let d = from; d <= to; d = addDays(d, 1)) yield d; }

/** AD 'YYYY-MM-DD' → { year, month (0-11), day, formatted } in Bikram Sambat. */
export function toBS(ymd) {
  const nd = new NepaliDate(new Date(`${ymd}T06:00:00Z`));
  return { year: nd.getYear(), month: nd.getMonth(), day: nd.getDate(), formatted: nd.format('YYYY-MM-DD'), monthName: BS_MONTHS[nd.getMonth()] };
}
/** BS date → AD 'YYYY-MM-DD'. month is 0-based. */
export function fromBS(year, month, day) {
  const d = new NepaliDate(year, month, day).toJsDate();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** AD date range covered by a BS month (used for payroll periods). */
export function bsMonthRange(year, month) {
  const start = fromBS(year, month, 1);
  const nextStart = month === 11 ? fromBS(year + 1, 0, 1) : fromBS(year, month + 1, 1);
  return { start, end: addDays(nextStart, -1) };
}
/** Nepal fiscal year (Shrawan 1 – Asar end) label for an AD date, e.g. '2083/84'. */
export function fiscalYear(ymd) {
  const bs = toBS(ymd);
  const startYear = bs.month >= 3 ? bs.year : bs.year - 1; // Shrawan = index 3
  return `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`;
}
export function fiscalYearRange(label) {
  const y = Number(label.split('/')[0]);
  return { start: fromBS(y, 3, 1), end: addDays(fromBS(y + 1, 3, 1), -1) };
}
