import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { BadRequest } from '../../utils/errors.js';

/**
 * Payment provider adapters. Rule for every provider: a browser redirect is
 * NEVER proof of payment. Success is only accepted after a server-to-server
 * verification call (eSewa status API / Khalti lookup API) confirms the exact
 * transaction, amount and status.
 */

// Injectable HTTP client (tests replace it; production uses global fetch with a timeout).
let http = async (url, { method = 'GET', headers = {}, body } = {}) => {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
};
export const setHttpClient = (fn) => { http = fn; };

const money = (n) => Number(n).toFixed(2).replace(/\.00$/, ''); // eSewa expects "100" or "100.5"

// --------------------------------------------------------------------------- eSewa ePay v2
export const esewa = {
  sign(fields, names) {
    const message = names.map((n) => `${n}=${fields[n]}`).join(',');
    return crypto.createHmac('sha256', env.ESEWA_SECRET_KEY).update(message).digest('base64');
  },

  /** Fields for an auto-submitting POST form to eSewa. */
  buildCheckout({ payment, successUrl, failureUrl }) {
    const fields = {
      amount: money(payment.amount), tax_amount: '0', product_service_charge: '0', product_delivery_charge: '0',
      total_amount: money(payment.amount), transaction_uuid: payment.reference, product_code: env.ESEWA_PRODUCT_CODE,
      success_url: successUrl, failure_url: failureUrl,
      signed_field_names: 'total_amount,transaction_uuid,product_code',
    };
    fields.signature = esewa.sign(fields, fields.signed_field_names.split(','));
    return { method: 'POST', action: env.ESEWA_FORM_URL, fields };
  },

  /** Decode and authenticate the ?data= payload eSewa appends to success_url. */
  parseCallback(data) {
    let payload;
    try { payload = JSON.parse(Buffer.from(String(data), 'base64').toString('utf8')); } catch { throw BadRequest('Malformed eSewa response'); }
    const names = String(payload.signed_field_names || '').split(',').filter(Boolean);
    if (!names.length || !payload.signature) throw BadRequest('Unsigned eSewa response');
    const expected = esewa.sign(payload, names);
    const a = Buffer.from(expected); const b = Buffer.from(String(payload.signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw BadRequest('eSewa signature mismatch');
    return payload; // { transaction_code, status, total_amount, transaction_uuid, product_code, ... }
  },

  /** Authoritative server-side status check. */
  async verify({ reference, amount }) {
    const url = `${env.ESEWA_STATUS_URL}?product_code=${encodeURIComponent(env.ESEWA_PRODUCT_CODE)}&total_amount=${money(amount)}&transaction_uuid=${encodeURIComponent(reference)}`;
    const { status, json } = await http(url);
    const ok = status === 200 && json.status === 'COMPLETE' && json.transaction_uuid === reference && Number(json.total_amount) === Number(amount);
    return { ok, pending: ['PENDING', 'AMBIGUOUS'].includes(json.status), providerRef: json.ref_id ?? null, data: json };
  },
};

// --------------------------------------------------------------------------- Khalti ePayment (KPG-2)
export const khalti = {
  headers() {
    if (!env.KHALTI_SECRET_KEY) throw BadRequest('Khalti is not configured');
    return { Authorization: `Key ${env.KHALTI_SECRET_KEY}`, 'Content-Type': 'application/json' };
  },

  async initiate({ payment, invoice, tenant, returnUrl, websiteUrl, customer }) {
    const { status, json } = await http(`${env.KHALTI_BASE_URL}/epayment/initiate/`, {
      method: 'POST', headers: khalti.headers(),
      body: JSON.stringify({
        return_url: returnUrl, website_url: websiteUrl,
        amount: Math.round(Number(payment.amount) * 100), // paisa
        purchase_order_id: payment.reference, purchase_order_name: `${tenant.name} — ${invoice.number}`.slice(0, 100),
        customer_info: customer,
      }),
    });
    if (status !== 200 || !json.pidx || !json.payment_url) throw BadRequest('Khalti could not start the payment. Please try another method.', json);
    return { pidx: json.pidx, paymentUrl: json.payment_url, data: json };
  },

  async verify({ pidx, amount }) {
    const { status, json } = await http(`${env.KHALTI_BASE_URL}/epayment/lookup/`, {
      method: 'POST', headers: khalti.headers(), body: JSON.stringify({ pidx }),
    });
    const ok = status === 200 && json.status === 'Completed' && json.pidx === pidx && Number(json.total_amount) === Math.round(Number(amount) * 100);
    return { ok, pending: ['Pending', 'Initiated'].includes(json.status), providerRef: json.transaction_id ?? pidx, data: json };
  },
};
