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
| `public/styles.css` | the site's own design tokens and layout |
| `public/_headers` | caching + the strict CSP |
| `functions/` | Pages Functions: `[[path]].js` → `_router.js` |
| `tools/` | verification and asset helpers |


## URL contract

`/` + in-page section anchors. `#y=<year>&m=<meeting>&s=<session>` restores an
exact analysis (`app.js` `saveShareHash` / `loadFromHash`); Reset strips the
hash with `replaceState`. Result tabs are UI state, not routes — do not give them
hashes.

## Commands

```
node --check public/app.js && node --check public/animations.js
python tools/check_csp_hashes.py
npx wrangler pages deploy public   # or Misc/pages-deploy.sh f1
```

No build step, no package.json, no test runner in this repo. The repository
belongs to another GitHub account, so Cloudflare's Git integration is not
connected; deploys are manual until that authorization exists.

