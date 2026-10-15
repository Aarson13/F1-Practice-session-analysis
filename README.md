# F1 Session Analyzer — Turn-by-Turn Driver & Team Analysis

**Live:** https://f1-practice-session-analysis.pages.dev

Pick **any year, any Grand Prix, any session** and find out **which driver — and which team — is fastest through each turn/corner**.

Not limited to free practice — works for **every available session type**:

- Practice 1, Practice 2, Practice 3
- Qualifying
- Sprint Qualifying / Sprint Shootout, Sprint
- Race

> **Only the session you select is analyzed.** One session in → one turn-by-turn report out.

## Run it on your local machine

No install, no build, no backend. Just serve the folder and open it in a browser:

**Option A — Python (you already have it):**

```powershell
cd C:\Users\Parth\Desktop\Github\F1-Practice-session-analysis\public
python -m http.server 8000
```

**Option B — Node:**

```powershell
cd C:\Users\Parth\Desktop\Github\F1-Practice-session-analysis\public
npx serve .
```

Then open **http://localhost:8000** (or the address `serve` prints) in Chrome/Edge/Firefox.

> Why a server and not double-clicking `index.html`? Browsers restrict `file://`
> pages; a tiny local server avoids any issue. No F1 data is ever stored — the
> page just needs `http://` to run properly.

**Using it:**

1. Pick **Year** → **Grand Prix** → **Session** (all lists load live from the API).
2. Optionally narrow to Top 10 / Top 5 fastest laps (faster, fewer API requests).
3. Press **Analyze selected session** and watch the progress bar.
4. Share it — **🔗 Copy share link** gives a URL that re-opens the exact same analysis.

## What you get per analysis

Results open in tabs (Overview, Track Map, Corners, Head-to-Head, Drivers & Teams, Sectors, Race Pace, Weekend, Traces, Classification, Guide) — each view builds when first opened. The Overview shows the selected circuit's track photo.

- 📋 Session summary + 🌦️ context strip (track/air temp, wind, rain, flag timeline)
- 🗺️ Track map coloured by fastest team per segment, numbered apexes, **best-lap replay** (animated dots), click-an-apex ↔ table-row linking
- ↩️ Turn-by-turn table (best driver/team per corner, top 3 + gaps) — hover a row to spotlight the corner on the map
- ⚔️ **Head-to-head**: any 2 drivers, per-corner deltas across the whole lap, fought out on a two-color **duel track map**
- 🏎️ Per-driver table with **photos + tyre compound** of each best lap
- 🏎️ Per-driver table with **photos + tyre compound** of each best lap
- 🏆 Per-team table (avg best lap, corners won, strongest turn)
- ⏱️ Sectors & speed traps from each best lap
- 🏁 Race pace & tyre degradation per stint (Race/Sprint sessions)
- 🗓️ **Weekend view**: every session of the GP compared corner-by-corner
- 📈 Overlaid best-lap speed traces (zoomable, legend toggles), 🏁 official classification, ⬇️ CSV export on every table
- ❓ "How this works" methodology explainer on the page
- 🔀 **Combined practice mode**: a session-dropdown entry (Grand Prix weekends only — no pre-season testing) that pools FP1+FP2+FP3 (whichever exist) and ranks every corner on each driver's overall-best practice lap

## Frontend components (self-hosted, no build)

- [Shoelace 2.18](https://shoelace.style/) — selects + buttons (dark theme, red primary tokens)
- [Tabulator 6.3](http://tabulator.info/) — every data grid: sorting, rich cells, one-click CSV
- [Apache ECharts 5.5](https://echarts.apache.org/) — speed traces with tooltips, zoom + legend filtering
- Custom canvas — track map, duel map, best-lap replay (no library draws F1 track maps)

All component files live in `public/vendor/` and are served with the site — no third-party CDN is required at runtime (verified with jsDelivr fully blocked). `public/_headers` sends `no-store` for the app's own files (unversioned names, replaced on every deploy, so a redeploy can never serve a stale mix) and a week's cache for `public/vendor/` and `public/assets/`, which are large and change a few times a year rather than per deploy. Each path states its own policy: Cloudflare joins the `Cache-Control` of every matching rule, so a catch-all carrying `no-store` silently cancels the long-cache rules underneath it — which is what an earlier version of this file did.

## Light UI layer (Ferrari theme, performance pass)

The presentation layer — lightweight video backdrop, hero, sticky navbar,
scroll progress, racing loader, toasts, back-to-top, one-time section
reveals — is **additive and dependency-free**. `public/animations.js` is a
single local deferred script: **no third-party motion libraries at all**
(GSAP, ScrollTrigger, Lenis, Vanilla-Tilt, CountUp.js, tsParticles,
Splitting.js and Typed.js were all removed). Native `scroll-behavior: smooth`
plus one `IntersectionObserver` do the rest.

What was cut for speed: the custom cursor, the particle canvas, 3D tilt,
smooth-scroll hijacking, the film-grain layer, `backdrop-filter` on every
surface (the navbar is solid, no blur at all), glow `box-shadow` transitions,
global `will-change`, parallax and scrub animations, and all infinite ambient
animations. Cards use a solid `rgba(18,18,22,.72)`; button hover is color +
`translateY(-1px)` in 150ms; sections fade in once via `IntersectionObserver`
and are then unobserved. Charts, track-map and duel-map containers are never
animated, transformed, filtered or scroll-listened.

Fonts (Google Fonts): **Rajdhani 600/700** (headings, numerals) + **Inter
400/600** (body), `display=swap`, system fallbacks.

Accessibility & performance: `prefers-reduced-motion: reduce` shows the poster
only and disables all non-essential animation. The video autoplays muted
(`preload="auto"`, in parallel, never blocking content), pauses while Analyze
runs and when the tab hides, and a bottom-left toggle (`Background: On/Off`,
JS variable only, 44px target) hides it on demand. No width/connection/CPU
gating — it plays on mobile too.

### Background video (self-hosted, swap freely)

`public/assets/bg.webm` · `public/assets/bg.mp4` · `public/assets/bg-poster.jpg`.
Spec: **854×480 (480p), 24 fps, 8–12 s seamless loop, no audio, ≤ 3 MB each**
(hard cap 5 MB; Pages caps a single file at 25 MiB). The WebM is listed first;
MP4 is the fallback. Current shipped weight: 182,458 B + 493,938 B + 14,507 B poster.

The clip is **procedurally generated — no external footage, no branding**: a
generic dark-red/black open-wheel car on a night track, rendered by
`tools/make_bg_video.py` (numpy + Pillow → ffmpeg; 240 loop-safe frames at
1280×720, then scaled to 854×480). Tweak speed, colours and duration via the
constants at the top of that script (`DURATION`, `FPS`, `SPEED`,
`ACCENT_COLOR`, `CAR_COLOR`), then re-run it — it re-encodes both formats,
re-grabs the poster, verifies the 3 MB budget (auto-bumping CRF if needed),
deletes the temp frames, and prints the final sizes.

Compression commands from the performance spec (replace `input.mp4` with your clip):

```bash
ffmpeg -i input.mp4 -an -t 10 -vf "scale=854:-2,fps=24" -c:v libx264 -crf 30 -preset slow -movflags +faststart assets/bg.mp4
ffmpeg -i input.mp4 -an -t 10 -vf "scale=854:-2,fps=24" -c:v libvpx-vp9 -crf 40 -b:v 0 assets/bg.webm
```

**To swap the clip:** drop your files into `public/assets/` using the same names
(`bg.webm`, `bg.mp4`, `bg-poster.jpg`) — no code changes needed. To use
different filenames, edit the `<source>`/`poster` attributes on the `#bgVideo`
element in `public/index.html`.

## Zero-storage, live-data design

To save space, this app **stores no F1 data at all** — no CSVs, no databases, no downloads:

1. On **Analyze**, the page fetches everything **live from the [OpenF1 API](https://openf1.org)** (`meetings → sessions → drivers → laps → car_data → session_result`).
2. Official corner geometry comes live from the meeting's `circuit_info_url` (MultiViewer).
3. All processing happens **in your browser**; close the tab and nothing remains.

Deploy anywhere static sites live (point the host at `public/` — no backend needed).

## Deploys (Cloudflare Pages + GitHub auto-builds)

The published site is the **`public/` directory**. Nothing else in the repository
is part of it: `README.md`, `DESIGN.md` and the git plumbing stay at the root,
where no deploy reaches them.

**Three of the paths those root files used to occupy are held deliberately.** The
first deployment of this project uploaded the repository root, so `/README.md`,
`/DESIGN.md` and `/.assetsignore` were published then. Moving the site into
`public/` took them out of the deployment — and the host went on serving the old
copies anyway: measured on 14 Oct 2026, all three answered `200` with their old
bodies, `CF-Cache-Status: HIT`, `Age` ~42,000s, `Cache-Control: public,
s-maxage=604800`, while the same paths with any query string answered `404`.
Pages retains removed assets; a redeploy does not evict them, and there is no
cache purge to reach for, because the account holds no zone for a `*.pages.dev`
hostname. So `public/README.md`, `public/DESIGN.md` and `public/.assetsignore`
exist to hold those three paths and say what they are. A deployment's own file
takes a path back — measured, the next deploy replaced all three — which means
the site answers with a statement instead of a document it does not publish.
`Misc/pages-functions-test.mjs` now asks every site for these clean URLs, which
is the check that would have caught it: the suite's own `?probe=` requests read
the deployment and passed while a stranger could still read the file.

A directory rather than an include-list, on purpose. Cloudflare Pages reads no
ignore file — measured: a probe deployment carrying `.assetsignore` served
`/secret.txt` *and* `/.assetsignore` itself — so the only thing deciding what a
Pages build publishes is its **build output directory**. Making that directory the
site is how the repository states what it publishes, instead of depending on a
host to honour a file it may not read.

- Production URL: https://f1-practice-session-analysis.pages.dev
- Manual deploy: `./Misc/pages-deploy.sh f1` (stages `public/` and uploads it), or
  `npx wrangler pages deploy public --project-name=f1-practice-session-analysis`.
- **GitHub auto-deploys:** connect the repo once in the Cloudflare dashboard —
  Workers & Pages → `f1-practice-session-analysis` → Settings → Builds &
  deployments → **Connect to Git** → authorize GitHub → select
  `Aarson13/F1-Practice-session-analysis`, production branch `main`, **leave the
  build command blank** (there is no build step), **build output directory
  `public`**. Every push to `main` then rebuilds and redeploys automatically.

One consequence of connecting, from Cloudflare's own docs: a Git-integrated
project cannot be switched back to Direct Upload later. Wrangler deploys keep
working (turn automatic deployments off if you want them to stop firing), but the
project's type is a one-way door — so `public/` is settled first, above.

### Before you deploy

The deploy has no build step and no checks of its own, and this site's two silent
failure modes both show up only in a browser, so run these first — all three are
what `.github/workflows/check.yml` runs on a push:

```
python tools/check_csp_hashes.py     # the CSP pins both inline scripts by hash
node --check public/app.js && node --check public/animations.js
```

`public/_headers` carries a Content-Security-Policy, and `script-src` pins the two
inline `<script>` blocks in `public/index.html` by SHA-256. Edit either block and
the hash must be regenerated: the browser refuses a script whose hash is not in
the policy, which looks like a page that renders but has lost a piece of its
behaviour, not like an error. The checker prints the exact directives to paste
and also fails on a hash left behind by a deleted script.

The policy's `connect-src` also carries `data:` for a reason worth keeping: the
vendored Shoelace components fetch their own icons as `data:image/svg+xml,…` URLs,
and without it the console fills with refusals and the selects lose their chevrons
and checkmarks.

One thing still open on this site, deliberately: the fonts are fetched from
`fonts.googleapis.com` / `fonts.gstatic.com`, and `style-src`/`font-src` allow
those two origins. Self-hosting them (`public/fonts/`) is the better fix and the
only one that lets those origins leave the policy; it is not done here because
`public/index.html` and `public/styles.css` carry in-progress work in the working
tree, and editing a file mid-change is how two authors end up fighting.

## How the analysis works

1. **Best lap per driver** — fastest non-pit-out lap of the selected session.
2. **Best-lap telemetry** — `car_data` speed (~3.7 Hz) for each driver's best-lap window.
3. **Speed vs lap distance** — distance integrated from speed-over-time, resampled to 1000 progress bins, so drivers are compared at the same point on track.
4. **Corner apexes** — official apex coordinates mapped onto the lap (fallback: auto-detected speed minima if circuit data is unreachable).
5. **Ranking** — each corner window (±1.2% of lap distance) ranked by **average speed**; team score = mean of its drivers. Higher avg speed through the corner = better.

### Weekend view (what it does)

One click runs a lite analysis (top 5 drivers per session) of **every session of the weekend** — FP1, FP2, FP3, Qualifying, Sprint, Race — and builds a matrix of **which team owned each corner in each session**, plus each session's fastest lap. It answers "how did corner dominance shift as the track evolved." It takes a few minutes (dozens of live API requests); progress is shown per session and the main controls lock until it finishes.

## Hardened against real-world failures

- Request pacing + automatic retry on rate limits (`429`), server errors (`5xx`), bad responses, and timeouts (30 s per request). Concurrent requests are serialized through a shared pace gate (a `Promise.all` burst used to fire 6-wide and trip the limiter); `429`s back off exponentially with jitter, honor the server's `Retry-After`, and set a shared cooldown so later requests wait out the window instead of re-tripping it.
- Friendly messages for: no Grands Prix in a year, no/cancelled sessions, sessions with no timed laps yet, drivers with missing telemetry (skipped, analysis continues with the rest).
- UI locks during analysis so selections can't change mid-run; minimum 2 drivers with telemetry required or it tells you to retry.
- Works with any Grand Prix 2023 → present (OpenF1 coverage).

## Notes & limits

- OpenF1 free tier: ~3 req/s, ~30 req/min — analyzing all 20 drivers takes ~1 min; Top 10/Top 5 is faster.
- Data is unofficial (community project, not affiliated with Formula 1).
