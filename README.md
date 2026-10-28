# F1 Session Analyzer - Turn-by-Turn Driver & Team Analysis

**Live:** https://f1-practice-session-analysis.pages.dev

Pick any year, any Grand Prix, any session, and find out which driver - and which team - is fastest through each turn of the lap.

Works for every session type the data covers: Practice 1–3, Qualifying, Sprint Qualifying, Sprint and Race. Only the session you choose is analysed: one session in, one turn-by-turn report out.

## What you get

- **Overview** - session summary, plus track and air temperature, wind, rain and the flag timeline
- **Track map** - coloured by fastest team per segment, numbered apexes, a best-lap replay, and click-an-apex ↔ table-row linking
- **Corners** - the best driver and team at every turn, with the top three and their gaps
- **Head-to-head** - any two drivers, corner by corner, on a duel map
- **Drivers & teams** - best laps with photos and tyre compounds, and a per-team table of corners won
- **Sectors, Race pace, Weekend and Traces** - sector times and speed traps, per-stint degradation, every session of the weekend compared corner by corner, and overlaid speed traces
- **Classification and CSV** - the official result, and a CSV export on every table
- **Share links** - a copied link re-opens the same analysis; **Combined practice** pools FP1–FP3 into one ranking
- **Guide** - a methodology explainer on the page itself

## How it works

On **Analyze**, the page fetches everything live from the [OpenF1 API](https://openf1.org) - meetings, sessions, drivers, laps, car data and results - along with the circuit's official corner geometry. Each driver's best lap is compared at the same point on track, and corners are ranked by average speed through the window. All processing happens in the browser and **no F1 data is stored**.

## For agents and readers without JavaScript

The analyzer is an interactive app, but its public surface does not require the bundle to be
executed. `/`, `/about`, `/contact` and `/privacy` negotiate `Accept: text/markdown` against
`text/html` (with `Vary: Accept` and a `Link` alternate); `/index.md`, `/about.md`, `/contact.md`
and `/privacy.md` always return Markdown. An unmatched path returns a Markdown 404 when Markdown
is requested. [`llms.txt`](public/llms.txt) explains when to use the site, how a shared analysis
is addressed, and what the data cannot tell you.

The trust pages are real HTML documents and the homepage carries a footer description, so a
crawler or a reader without JavaScript still gets the product description and the links to
[About](public/about.html), [Contact](public/contact.html) and [Privacy](public/privacy.html).

Run the agent-surface tests with:

```bash
node --test tests/agent-docs.test.mjs
```

## Notes

- OpenF1's free tier allows roughly 3 requests a second, so an all-drivers analysis takes about a minute; Top 10 and Top 5 are quicker.
- Data is unofficial and not affiliated with Formula 1.

## Built with

Plain HTML, CSS and JavaScript with **Shoelace**, **Tabulator** and **Apache ECharts** vendored and self-hosted, on **Cloudflare Pages**. A custom canvas draws the track and duel maps.
