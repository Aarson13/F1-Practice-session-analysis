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

All component files live in `public/vendor/` and are served with the site — no third-party CDN is required at runtime (verified with jsDelivr fully blocked). `public/_headers` disables caching so redeploys can never serve a stale mix of files.

## Cinematic UI layer (Ferrari-inspired, optional)

The presentation layer — cinematic video backdrop, hero, sticky glass navbar,
scroll progress, racing loader, toasts, custom cursor, back-to-top, scroll
reveals — is **additive and entirely optional**. Every library is loaded with
`defer` (never blocking first paint) and feature-detected in
`public/animations.js`, so if a CDN is blocked the app still works, just without
the effects. All libraries are free & open source:

| Library | Version | CDN (pinned) | Used for |
| --- | --- | --- | --- |
| GSAP + ScrollTrigger | 3.12.5 | `cdn.jsdelivr.net/npm/gsap@3.12.5/…` | scroll reveals, hero, parallax |
| Lenis | 1.1.18 | `cdn.jsdelivr.net/npm/lenis@1.1.18/…` | smooth inertial scrolling |
| Vanilla-Tilt | 1.8.1 | `cdn.jsdelivr.net/npm/vanilla-tilt@1.8.1/…` | 3D tilt on summary card |
| CountUp.js | 2.8.0 | `cdn.jsdelivr.net/npm/countup.js@2.8.0/…` | KPI number animation |
| tsParticles | 2.12.0 | `cdn.jsdelivr.net/npm/tsparticles@2.12.0/…` | hero embers (≥768px) |
| Splitting.js | 1.0.6 | `cdn.jsdelivr.net/npm/splitting@1.0.6/…` | hero title letter reveal |
| Typed.js | 2.1.0 | `cdn.jsdelivr.net/npm/typed.js@2.1.0/…` | rotating hero subtitle |

Fonts (Google Fonts): **Orbitron** (numerals), **Rajdhani** (headings), **Inter** (body).

Accessibility & performance: `prefers-reduced-motion: reduce` disables the video,
parallax, particles, tilt and scroll animations and shows static content;
Save-Data or viewport < 640px drops the video for the poster image only; the tab
stays light (no layout shift — the navbar and video are fixed).

### Background video (self-hosted, swap freely)

`public/assets/bg.webm` · `public/assets/bg.mp4` · `public/assets/hero-poster.jpg`.
Target: **1280×720, 24–30 fps, no audio, ≤ 8 MB** each (Cloudflare Pages caps a
single file at 25 MiB). The WebM is listed first; MP4 is the fallback.

Compression commands (replace `input.mov` with your clip):

```bash
# VP9 WebM (preferred — listed first)
ffmpeg -i input.mov -vf "scale=1280:720,vignette=PI/4" -r 30 -an \
  -c:v libvpx-vp9 -crf 38 -b:v 0 -pix_fmt yuv420p bg.webm

# H.264 MP4 (fallback)
ffmpeg -i input.mov -vf "scale=1280:720,vignette=PI/4" -r 30 -an \
  -c:v libx264 -profile:v high -crf 30 -pix_fmt yuv420p -movflags +faststart bg.mp4

# poster frame (first frame of the same grade)
ffmpeg -i input.mov -vf "scale=1280:720,vignette=PI/4" -frames:v 1 hero-poster.jpg
```

**To swap the clip:** drop your files into `public/assets/` using the same names
(`bg.webm`, `bg.mp4`, `hero-poster.jpg`) — no code changes needed. To use
different filenames, edit the `<source>`/`poster` attributes on the `#bgVideo`
element in `public/index.html`.

> The repo currently ships a small **placeholder** clip (an abstract dark
> Ferrari-red loop, ~95 KB) plus its poster, so the site is cinematic
> out-of-the-box. Replace both with your footage whenever you're ready.

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

## How the analysis works

1. **Best lap per driver** — fastest non-pit-out lap of the selected session.
2. **Best-lap telemetry** — `car_data` speed (~3.7 Hz) for each driver's best-lap window.
3. **Speed vs lap distance** — distance integrated from speed-over-time, resampled to 1000 progress bins, so drivers are compared at the same point on track.
4. **Corner apexes** — official apex coordinates mapped onto the lap (fallback: auto-detected speed minima if circuit data is unreachable).
5. **Ranking** — each corner window (±1.2% of lap distance) ranked by **average speed**; team score = mean of its drivers. Higher avg speed through the corner = better.

### Weekend view (what it does)

One click runs a lite analysis (top 5 drivers per session) of **every session of the weekend** — FP1, FP2, FP3, Qualifying, Sprint, Race — and builds a matrix of **which team owned each corner in each session**, plus each session's fastest lap. It answers "how did corner dominance shift as the track evolved." It takes a few minutes (dozens of live API requests); progress is shown per session and the main controls lock until it finishes.

## Hardened against real-world failures

- Request pacing + automatic retry on rate limits (`429`), server errors (`5xx`), bad responses, and timeouts (30 s per request).
- Friendly messages for: no Grands Prix in a year, no/cancelled sessions, sessions with no timed laps yet, drivers with missing telemetry (skipped, analysis continues with the rest).
- UI locks during analysis so selections can't change mid-run; minimum 2 drivers with telemetry required or it tells you to retry.
- Works with any Grand Prix 2023 → present (OpenF1 coverage).

## Notes & limits

- OpenF1 free tier: ~3 req/s, ~30 req/min — analyzing all 20 drivers takes ~1 min; Top 10/Top 5 is faster.
- Data is unofficial (community project, not affiliated with Formula 1).
