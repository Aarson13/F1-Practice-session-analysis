# F1 Session Analyzer — Turn-by-Turn Driver & Team Analysis

Pick **any year, any Grand Prix, any session** and find out **which driver — and which team — is fastest through each turn/corner**.

Unlike the name suggests, this is **not limited to free practice**. Both engines below work for **every available session type**:

- Practice 1, Practice 2, Practice 3
- Qualifying
- Sprint Qualifying / Sprint Shootout, Sprint
- Race

> **Only the session you select is analyzed.** One session in → one turn-by-turn report out.

## Two engines — which is better?

| | 🌐 Website (`index.html` + `app.js`) | 🐍 FastF1 analyzer (`fastf1/`) |
|---|---|---|
| Data source | OpenF1 API (2023 → present) | FastF1 / official F1 live timing (2018 → present) |
| Telemetry | Speed @ ~3.7 Hz | Speed, throttle, brake, gear @ higher rate |
| Corner mapping | Official apexes mapped to lap progress (±1.2% window) | Official apexes at exact track distances (±50 m window) |
| Runs where | Any browser, zero install | Any machine with Python 3.10+ |
| Hosting | Free static hosting (GitHub Pages / Netlify / Vercel) | Local machine / any Python host |
| Storage | None — all in-browser, live on Analyze | None — temp cache auto-deleted on exit |
| Best for | Sharing, quick answers, race-weekend use | Deep analysis, research, pre-2023 seasons |

**Verdict: keep both.** The website is the better *product* (no install, no backend, free hosting, live on page load — exactly matching the zero-storage goal). FastF1 is the better *measurement instrument* (richer telemetry, exact corner distances, seasons back to 2018). Both implement the same analysis contract: best lap per driver → corner windows ranked by average speed → team scores as the mean of their drivers.

## Engine 1 — Website (live, zero storage)

To save space, this app **stores no F1 data at all** — no CSVs, no databases, no downloaded files:

1. When you press **Analyze**, the page fetches everything **live from the [OpenF1 API](https://openf1.org)** (`meetings → sessions → drivers → laps → car_data → session_result`).
2. Official corner geometry comes live from the meeting's `circuit_info_url` (MultiViewer).
3. All processing (lap-distance resampling, corner ranking, team aggregation, track map, charts) happens **in your browser, on page load**.
4. Close the tab and nothing remains — run it again any time for fresh live data.

Open the app with any static server (or just open `index.html`), e.g.:

```sh
npx serve .
# or
python -m http.server
```

Then deploy anywhere static sites live (GitHub Pages, Netlify, Vercel — no backend needed).

## How the analysis works

1. **Best lap per driver** — the fastest non-pit-out lap of the selected session (from the `laps` endpoint).
2. **Best-lap telemetry** — `car_data` (speed @ ~3.7 Hz) for each driver's best-lap window.
3. **Speed vs lap distance** — distance is integrated from speed-over-time and each lap is resampled to 1000 progress bins, so drivers are compared at the same point on track.
4. **Corner apexes** — official apex coordinates mapped onto the lap (fallback: auto-detected speed minima if circuit data is unreachable).
5. **Ranking** — each corner window (±1.2% of lap distance around the apex) is ranked by **average speed**; the team score is the mean of its drivers. Higher average speed through the corner = better.

## What you get

- 📋 Session summary (fastest lap, corner kings)
- 🗺️ Track map coloured by **fastest team per segment**, with numbered corner apexes
- ↩️ Turn-by-turn table (best driver, best team, top 3 + gaps per corner)
- 🏎️ Per-driver table (best lap, top/avg speed, corners won, avg corner deficit)
- 🏆 Per-team table (avg best lap, corners won, avg corner speed, strongest turn)
- 📈 Overlaid best-lap speed traces with corner guides
- 🏁 Official session classification

## Notes & limits (website)

- OpenF1 historical data covers **2023 → present**; the free tier allows ~3 req/s and ~30 req/min. The app paces requests and retries on `429`, and you can limit analysis to the Top 10 / Top 5 fastest laps for speed.
- Data is unofficial (community project, not affiliated with Formula 1).

## Engine 2 — FastF1 Python analyzer (deep analysis, still zero storage)

Same turn-by-turn contract, deeper data: high-rate telemetry with throttle/brake/gear, official corner apexes at exact track distances, and seasons back to **2018**.

```sh
cd fastf1
pip install -r requirements.txt
python corner_analysis.py --year 2024 --gp Singapore --session FP1
python corner_analysis.py --year 2024 --gp Singapore --session Q --top 10 --plots
```

Options: `--session FP1|FP2|FP3|Q|SQ|S|R`, `--top N` (fastest N laps only),
`--plots` (interactive track map + speed traces), `--save-plots DIR` (opt-in file output).

**Zero-storage how:** FastF1 writes a requests-cache sqlite file even when its cache is "disabled", so the script points the cache at a temp directory, closes the sqlite handle on exit, and deletes the directory — verified: full FP1 + Qualifying runs leave nothing behind (no `fastf1` cache dir, no temp dirs). Data is fetched live on every run.

Validated live: 2024 Singapore FP1 top 3 (LEC 1:31.763, NOR 1:31.839, SAI 1:31.952) and Qualifying top 3 (NOR 1:29.525 = real pole, PIA 1:29.640, VER 1:29.680) match official times exactly.
