/* ---------------------------------------------------------------------------
 * The Pages Function this site is served by.
 *
 * Until this batch F1 was the only site in the collection with no
 * `functions/` directory at all: it is a static app, and its one dynamic path
 * used to be nothing. The feedback box added with the redesign is the reason
 * this exists - `POST /api/feedback` has to land somewhere, and on Cloudflare
 * Pages that is a Pages Function, compiled from this directory beside
 * `pages_build_output_dir = "public"`.
 *
 * `[[path]].js` is the catch-all route, so every request arrives here and
 * `_router.js` decides: `/api/feedback` goes to the handler, everything else
 * goes straight to `env.ASSETS` (the `public/` upload) with its own caching
 * and CSP headers untouched.
 *
 * Two files rather than one for the same reason the sibling site has two: Pages
 * compiles every file in this directory as a route, so the `_` prefix is what
 * keeps `_router.js` a private module instead of a path of its own.
 * ------------------------------------------------------------------------ */
import router from './_router.js';

export const onRequest = (context) => router.fetch(context.request, context.env, context);
