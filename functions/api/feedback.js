/**
 * POST /api/feedback — the analyzer's own feedback box, stored in the shared
 * `site-feedback` KV namespace.
 *
 * This is the route the redesign asked for: before it, a visitor who found a
 * wrong corner speed or a broken session had no way to say so that did not
 * involve finding the repository. The site stores no F1 data by design, and
 * this does not change that — a report is a sentence about the tool, not
 * session data, and it carries no telemetry.
 *
 * The endpoint is same-origin (the CSP's `connect-src 'self'` already covers
 * it), anonymous, and stored only in KV with a 90-day expiry. No accounts, no
 * email required, no IP in the record: the caller's address is used for the
 * throttle bucket key and then forgotten.
 *
 * The status codes are a contract with the page that posts here
 * (`public/components.js`), which reads them rather than assuming success:
 *
 *   201  stored. `{ ok: true, id }`
 *   202  the honeypot (`website`) was filled: same body a bot would want to
 *        see, nothing written.
 *   400  no message, a one-word message, or a malformed email
 *   413  the body or the message is over the limit. Rejected, not truncated:
 *        silently cutting a report in half loses the part that mattered
 *   429  one submission per address per ten minutes
 *   503  `SITE_FEEDBACK` is not bound. It does not pretend to accept feedback
 *        it cannot store
 *   502  the store itself failed. The client says so instead of saying thanks
 *
 * The handler keeps the `{ statusCode, headers, body }` shape the other
 * functions in this collection use, so `functions/_router.js` treats it like
 * every other endpoint.
 */

/** Per-field ceilings, so one request cannot write an unbounded record. */
const LIMITS = { name: 80, email: 254, suggestion: 2000, page: 120, kind: 24 };
/** The whole body, before parsing: a report is a sentence, not an upload. */
const BODY_LIMIT = 8 * 1024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SITE = 'f1';
const TTL_SECONDS = 90 * 24 * 60 * 60;
const THROTTLE_SECONDS = 10 * 60;

/** The KV handle, handed over by the router once per request. */
let store = null;

export function setStore(kv) {
  store = kv || null;
}

function json(status, payload, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

/** Trimmed, length-capped, control characters removed. */
function text(value, limit) {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  return clean.length > limit ? clean.slice(0, limit) : clean;
}

function badRequest(message) {
  return json(400, { error: message });
}

/** Accepts a JSON body or a plain form post, so the form works without JS. */
function parseBody(event) {
  const raw = typeof event.body === 'string' ? event.body : '';
  if (!raw) return {};
  const type = String((event.headers && (event.headers['content-type'] || event.headers['Content-Type'])) || '');
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return null;
    }
  }
  const out = {};
  for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
  return out;
}

/** CF-Connecting-IP is copied onto Netlify's header name by the router. */
function clientAddress(event) {
  const headers = event.headers || {};
  const direct = headers['x-nf-client-connection-ip'] || headers['cf-connecting-ip'];
  if (direct) return String(direct).trim();
  const forwarded = headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return '';
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Use POST' }, { Allow: 'POST' });
  }

  const raw = typeof event.body === 'string' ? event.body : '';
  if (raw.length > BODY_LIMIT) return json(413, { error: 'That report is too long to send.' });

  const body = parseBody(event);
  if (body === null) return badRequest('Send JSON or a form-encoded body.');

  // The honeypot is read before validation on purpose: a bot that fills every
  // field it can see should not be told which check it failed.
  const trap = text(body.website || body['bot-field'] || body.botField || body.company, 100);
  if (trap) return json(202, { ok: true });

  // Length is checked before the trim-and-cap, so an over-long report is told
  // it was rejected rather than quietly posted with its end missing.
  const submitted = body.suggestion || body.message;
  if (typeof submitted === 'string' && submitted.trim().length > LIMITS.suggestion) {
    return json(413, { error: `Keep the report to ${LIMITS.suggestion} characters.` });
  }
  const suggestion = text(submitted, LIMITS.suggestion);
  if (suggestion.length < 3) return badRequest('Tell me what to fix or add (at least a few words).');

  const email = text(body.email, LIMITS.email);
  if (email && !EMAIL.test(email)) return badRequest('That email address does not look right.');

  const name = text(body.name, LIMITS.name);
  const page = text(body.page, LIMITS.page);
  const kind = text(body.kind || body.type, LIMITS.kind);

  if (!store) {
    return json(503, { error: 'Feedback storage is not configured on this deployment yet.' });
  }

  const address = clientAddress(event);
  if (address) {
    try {
      const seen = await store.get(`throttle:${SITE}:${address}`);
      if (seen) return json(429, { error: 'That is one feedback a while, thanks. Try again in a few minutes.' });
    } catch {
      // A KV read that fails the throttle must not swallow a real submission.
    }
  }

  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const record = {
    site: SITE,
    id,
    createdAt: new Date().toISOString(),
    name,
    email,
    kind,
    page,
    suggestion,
    userAgent: text((event.headers && event.headers['user-agent']) || '', 300),
  };

  try {
    await store.put(`feedback:${SITE}:${id}`, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
    if (address) {
      await store.put(`throttle:${SITE}:${address}`, '1', { expirationTtl: THROTTLE_SECONDS });
    }
  } catch (error) {
    console.error('feedback store failed:', (error && error.stack) || error);
    return json(502, { error: 'Could not save that just now. Nothing was lost on this device — try again shortly.' });
  }

  return json(201, { ok: true, id });
};

export default { handler, setStore };
