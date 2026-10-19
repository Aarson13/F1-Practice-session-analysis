/* =====================================================================
 * F1 Session Analyzer — SERVICE WORKER
 * ---------------------------------------------------------------------
 * The site's first worker (the audit's "service-worker coverage is
 * absent on five sites" list included this one). It does two things and
 * nothing else:
 *
 *   1. caches the shell + the files a visit actually fetches, so a
 *      dropped connection still renders the controls instead of a
 *      browser error page;
 *   2. gives the page a new worker to *see* — deliberately without
 *      calling skipWaiting() in install — so components.js can offer the
 *      update bar and swap only when Reload is pressed. A deploy that
 *      swaps itself silently is the failure mode the prompt exists to
 *      prevent.
 *
 * VERSION is the cache name. Bump it on every deploy that changes a
 * file listed in SHELL; the activate step deletes every other
 * `f1-analyzer-` cache, so bumping it is the whole migration.
 *
 * The two heavy vendor libraries are NOT in SHELL: app.js injects
 * Tabulator and ECharts only when an analysis needs them, and
 * precaching 1.5 MB here would undo that. They are picked up the first
 * time they are fetched, through the runtime path at the bottom.
 *
 * Live data is never cached: every request to api.openf1.org is
 * cross-origin and ignored, and the site's own /api/feedback is a write.
 * ===================================================================== */
'use strict';

const VERSION = 'f1-analyzer-v1';
const SHELL = [
  '/',
  '/styles.css',
  '/components.css',
  '/app.js',
  '/animations.js',
  '/components.js',
  '/fonts.css'
];

self.addEventListener('install', (event) => {
  // No skipWaiting(), on purpose: the new worker waits so the page can
  // announce it. components.js posts SKIP_WAITING from the Reload button.
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION && key.indexOf('f1-analyzer-') === 0).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // The live OpenF1 reads are cross-origin and must never be answered from a
  // cache; the feedback POST is excluded by the method check above already.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  if (request.mode === 'navigate') {
    // Network first, so a deploy is picked up on the next visit; the cached
    // copy is the offline fallback, not the default answer.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put('/', copy));
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
