/**
 * F1 Session Analyzer — the routing half of this site's Pages Function.
 *
 * One route, deliberately: `POST /api/feedback` (the feedback box in
 * `public/components.js`). Anything else — every page, stylesheet, script,
 * font, asset and the 404 document — is served by `env.ASSETS`, which is the
 * same static upload Pages served before this function existed. No request for
 * `public/` goes through any handler here, so nothing about the app's own
 * delivery changed.
 *
 * The KV namespace is handed to the feedback module the same way the sibling
 * RBI site does it: a namespace is an object, not a string, so it cannot ride
 * on `process.env` — `setStore()` takes it directly. Until the shared
 * `site-feedback` namespace is bound to this Pages project the route answers
 * 503 and says so, which is the honest answer: a form that silently accepted
 * feedback it could not store would lose every message.
 */

import feedbackModule from './api/feedback.js';

const ROUTES = {
  '/api/feedback': feedbackModule,
};

function wireBindings(env) {
  feedbackModule.setStore(env.SITE_FEEDBACK);
}

/** Build the handler's event shape out of this request, as the siblings do. */
async function toEvent(request, url) {
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  if (!headers['x-forwarded-for'] && headers['cf-connecting-ip']) {
    headers['x-forwarded-for'] = headers['cf-connecting-ip'];
  }
  const method = request.method;
  const event = {
    httpMethod: method,
    headers,
    path: url.pathname,
    rawUrl: url.toString(),
    queryStringParameters: Object.fromEntries(url.searchParams),
  };
  if (method !== 'GET' && method !== 'HEAD') event.body = await request.text();
  return event;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname];
    if (!mod) return env.ASSETS.fetch(request);

    wireBindings(env);

    try {
      const result = await mod.handler(await toEvent(request, url));
      return new Response(result.body, {
        status: result.statusCode || 200,
        headers: result.headers || {},
      });
    } catch (error) {
      console.error(`${url.pathname} failed:`, (error && error.stack) || error);
      return new Response(JSON.stringify({ error: String((error && error.message) || error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }
  },
};
