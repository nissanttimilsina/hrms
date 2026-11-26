/**
 * Consistent formatting helpers. NPR uses the South Asian digit grouping
 * (1,23,456.00) that Nepali users expect. Bikram Sambat display will be added
 * with the calendar library in Phase 4; dates are stored and passed as UTC/ISO.
 */
export function formatNPR(amount, { decimals = 0, symbol = 'NPR' } = {}) {
  if (amount == null || Number.isNaN(Number(amount))) return '—';
  const n = new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(Number(amount));
  return symbol ? `${symbol} ${n}` : n;
}

export function formatDate(value, { timeZone = 'Asia/Kathmandu', locale = 'en-GB' } = {}) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric', timeZone }).format(new Date(value));
}
