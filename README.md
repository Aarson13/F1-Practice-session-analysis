# F1 Session Analyzer — Turn-by-Turn Driver & Team Analysis

Pick **any year, any Grand Prix, any session** and find out **which driver — and which team — is fastest through each turn/corner**.

Unlike the name suggests, this is **not limited to free practice**. The analyzer works for **every available session type**:

- Practice 1, Practice 2, Practice 3
- Qualifying
- Sprint Qualifying, Sprint
- Race

> **Only the session you select is analyzed.** One session in → one turn-by-turn report out.

## Zero-storage, live-data design

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

## Notes & limits

- OpenF1 historical data covers **2023 → present**; the free tier allows ~3 req/s and ~30 req/min. The app paces requests and retries on `429`, and you can limit analysis to the Top 10 / Top 5 fastest laps for speed.
- Data is unofficial (community project, not affiliated with Formula 1).
