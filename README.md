# F1 Session Analyzer — Turn-by-Turn Driver & Team Analysis

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
cd C:\Users\Parth\Desktop\Github\F1-Practice-session-analysis
python -m http.server 8000
```

**Option B — Node:**

```powershell
cd C:\Users\Parth\Desktop\Github\F1-Practice-session-analysis
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
4. You get: session summary, track map coloured by fastest team per segment,
   turn-by-turn table, per-driver table, per-team table, speed traces, and the
   official classification.

## Zero-storage, live-data design

To save space, this app **stores no F1 data at all** — no CSVs, no databases, no downloads:

1. On **Analyze**, the page fetches everything **live from the [OpenF1 API](https://openf1.org)** (`meetings → sessions → drivers → laps → car_data → session_result`).
2. Official corner geometry comes live from the meeting's `circuit_info_url` (MultiViewer).
3. All processing happens **in your browser**; close the tab and nothing remains.

Deploy anywhere static sites live (GitHub Pages, Netlify, Vercel — no backend needed).

## How the analysis works

1. **Best lap per driver** — fastest non-pit-out lap of the selected session.
2. **Best-lap telemetry** — `car_data` speed (~3.7 Hz) for each driver's best-lap window.
3. **Speed vs lap distance** — distance integrated from speed-over-time, resampled to 1000 progress bins, so drivers are compared at the same point on track.
4. **Corner apexes** — official apex coordinates mapped onto the lap (fallback: auto-detected speed minima if circuit data is unreachable).
5. **Ranking** — each corner window (±1.2% of lap distance) ranked by **average speed**; team score = mean of its drivers. Higher avg speed through the corner = better.

## Hardened against real-world failures

- Request pacing + automatic retry on rate limits (`429`), server errors (`5xx`), bad responses, and timeouts (30 s per request).
- Friendly messages for: no Grands Prix in a year, no/cancelled sessions, sessions with no timed laps yet, drivers with missing telemetry (skipped, analysis continues with the rest).
- UI locks during analysis so selections can't change mid-run; minimum 2 drivers with telemetry required or it tells you to retry.
- Works with any Grand Prix 2023 → present (OpenF1 coverage).

## Notes & limits

- OpenF1 free tier: ~3 req/s, ~30 req/min — analyzing all 20 drivers takes ~1 min; Top 10/Top 5 is faster.
- Data is unofficial (community project, not affiliated with Formula 1).
