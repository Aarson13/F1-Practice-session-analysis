/**
 * F1 Session Analyzer — the routing half of this site's Pages Function.
 *
 * One API route: `/api/feedback`. Everything else is served by `env.ASSETS`,
 * the same static upload Pages served before this function existed — with an
 * agent layer on top: `/`, `/about`, `/contact` and `/privacy` negotiate
 * `text/markdown`, their `.md` aliases always answer Markdown, and an unmatched
 * path gets a Markdown 404 when one is requested. The bodies and negotiation
 * live in `_agent-docs.js`; the app's own delivery is unchanged.
 *
 * The KV namespace is handed to the feedback module the same way the sibling
 * RBI site does it: a namespace is an object, not a string, so it cannot ride
 * on `process.env` — `setStore()` takes it directly. Until the shared
 * `site-feedback` namespace is bound to this Pages project the route answers
 * 503 and says so, which is the honest answer: a form that silently accepted
 * feedback it could not store would lose every message.
 */

import feedbackModule from './api/feedback.js';
import {
  DOCUMENTS,
  MARKDOWN_ALIASES,
  NOT_ACCEPTABLE_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from './_agent-docs.js';

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

/** Fetch a negotiated HTML document, falling back to its .html file if the
 *  assets layer does not resolve the clean URL itself. */
async function fetchDocument(env, request, document) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && document.file) {
    const url = new URL(request.url);
    url.pathname = document.file;
    response = await env.ASSETS.fetch(new Request(url, request));
  }
  return response;
}

function withDocHeaders(response, document) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  if (response.status >= 200 && response.status < 300) {
    headers.set(
      'Link',
      `<${document.alternate}>; rel="alternate"; type="text/markdown", ` +
        `</llms.txt>; rel="describedby"; type="text/plain"`
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withVary(response) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function serveDocument(request, env, pathname) {
  const alias = MARKDOWN_ALIASES.get(pathname);
  if (alias) return markdownResponse(alias, 200, request.method);

  const document = DOCUMENTS.get(pathname);
  if (!document) return null;

  const choice = negotiate(request.headers.get('Accept'));
  if (choice === 'markdown') return markdownResponse(document.markdown, 200, request.method);
  if (choice === 'not-acceptable') {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method);
  }
  return withDocHeaders(await fetchDocument(env, request, document), document);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname];
    if (!mod) {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const document = await serveDocument(request, env, url.pathname);
        if (document) return document;

        const response = await env.ASSETS.fetch(request);
        if (response.status === 404) {
          if (negotiate(request.headers.get('Accept')) === 'markdown') {
            return markdownResponse(notFoundMarkdown(url.pathname), 404, request.method);
          }
          return withVary(response);
        }
        return response;
      }
      return env.ASSETS.fetch(request);
    }

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
