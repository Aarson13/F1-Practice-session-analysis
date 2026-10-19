# F1 Session Analyzer — repo notes

Live: https://f1-practice-session-analysis.pages.dev · Cloudflare Pages project
`f1-practice-session-analysis`, publishing **`public/`** (`wrangler.toml`).

This repo had no `CLAUDE.md` before the redesign batch; this is that file. It
covers how the site is shaped, the rules any change here has to keep, and the
checks that are deliberately deferred.

## Layout

| Path | What it is |
|---|---|
| `public/` | the whole site — the only directory Pages publishes |
| `public/index.html` | one static SPA page: hero, session controls, SEO copy, 11 result tabs, footer |
| `public/app.js` | OpenF1 fetching, pacing/retry, telemetry math, Tabulator grids, ECharts traces, canvas maps, CSV, share hash |
| `public/animations.js` | presentation only — video backdrop, reveals, nav, toasts, loader; no data |
| `public/components.js` | the design-system layer (below), loaded last |
| `public/components.css` | every class the component layer uses |
| `public/styles.css` | the site's own design tokens and layout |
| `public/_headers` | caching + the strict CSP |
| `public/sw.js` | service worker (`f1-analyzer-v1`) and the waiting-worker update path |
| `functions/` | Pages Functions: `[[path]].js` → `_router.js` → `api/feedback.js` |
| `tools/` | font vendoring, CSP-hash check, background-video generator |

`app.js` and `animations.js` own the app; `components.js` never fetches,
never computes an analysis and never replaces an app template. Everything it
adds is an idempotent upgrade with a `data-ct-done` guard, so a tab re-render or
a second pass cannot install a component twice.

## URL contract

`/` + in-page section anchors. `#y=<year>&m=<meeting>&s=<session>` restores an
exact analysis (`app.js` `saveShareHash` / `loadFromHash`); Reset strips the
hash with `replaceState`. Result tabs are UI state, not routes — do not give them
hashes. `/?components=1` is the **unlinked component surface**, added with the
redesign batch (the Portfolio batch's `/?admin=1` is the same idea); it must not
be linked from the page, and it must never rewrite the hash.

## Component layer (25 components)

`public/components.js` implements the manifest's 25 F1 components. Ten have a
live home:

`gooey-nav` (top nav) · `warm-tooltip` (nav + CSV buttons) · `animated-counter`
(session-summary figures) · `stepper` (drivers to analyze) · `rubber-segment`
(replay speed) · `switch-mode` (background toggle) · `dynamic-button` (Analyze) ·
`inline-disclosure-menu` (Track map actions) · `scroll-island` (Guide panel) ·
`feedback` (footer form).

The other fifteen are hosted on `/?components=1`, each wired to the live
`state.analysis` in memory or to the `f1-settings:v1` store — never a demo value:

`glide-select` · `jelly-radio` · `filter-disclosure` · `fluid-tabs` · `skiper68` ·
`skiper74` · `analytics-chart` · `expandable-profile-card` · `time-undo-action` ·
`inline-table-control` · `swipe-row` · `transaction-list` · `fund-widget` ·
`github-activity` (display-only: this site has no contribution feed) ·
`inline-disclosure-menu`'s host panel.

`budget-card` and `accordion-gallery` are not assigned to this site in
`design-system/coverage.manifest.json`.

Rules for anything added here:

- `data-component` on every component instance (the helper `mark()` does it);
- class-only styling. Runtime geometry goes through CSSOM / custom properties.
  A `style=""` attribute in a template is refused by the CSP and the element
  silently loses it;
- team colours are runtime data, so they are `data-colour` attributes painted
  by `paintSwatches()` — not inline styles;
- reduced motion is implemented both from the system preference and from the
  stored `reduceMotion` preference (`html.f1-reduce-motion`);
- touch targets: `.touch-target` plus one `@media (pointer: coarse)` rule;
- do not persist analysis data. `f1-settings:v1` holds preferences only; the
  site's zero-storage promise is a feature.

## Strict CSP

`public/_headers` sends `style-src 'self'` (no `'unsafe-inline'`) and
`script-src 'self'` plus the two remaining inline scripts pinned by SHA-256.
After editing either inline `<script>` in `index.html` (the reduced-motion
bootstrap and the UI boot check), run:

```
python tools/check_csp_hashes.py
```

and paste the hashes it reports into the policy. The data-grid and chart
libraries are not in the document any more: `app.js` injects `vendor/tabulator.min.js`
and `vendor/echarts.min.js` the first time a grid or trace needs them. Keep that
boundary — the whole point is that a visitor who never runs an analysis never
downloads 1.5 MB.

## Feedback

`POST /api/feedback` is a Pages Function (`functions/api/feedback.js`) storing
anonymous reports in the shared `site-feedback` KV namespace with a 90-day TTL.
It answers `503` until `SITE_FEEDBACK` is bound to this Pages project; that is
deliberate, not a bug to paper over. The form lives in the footer
(`components.js`) and reads the status code rather than assuming success.
No F1 data, no IP, no account.

## Service worker

`public/sw.js` precaches the shell only (`/`, the four scripts, the two
stylesheets, `fonts.css`), never the vendor libraries and never OpenF1 or
`/api/*`. It does **not** call `skipWaiting()` in `install`; `components.js`
offers the update bar and posts `SKIP_WAITING` when Reload is pressed. Bump
`VERSION` on any deploy that changes a shell file — the activate step deletes
every other `f1-analyzer-` cache.

## Commands

```
node --check public/app.js && node --check public/animations.js
python tools/check_csp_hashes.py
npx wrangler pages deploy public   # or Misc/pages-deploy.sh f1
```

No build step, no package.json, no test runner in this repo. The repository
belongs to another GitHub account, so Cloudflare's Git integration is not
connected; deploys are manual until that authorization exists.
