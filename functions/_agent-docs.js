/* ---------------------------------------------------------------------------
 * F1 Session Analyzer — the agent-facing documents.
 *
 * `_router.js` serves these. Nothing here touches the analysis engine or the
 * OpenF1 API: the browser app stays the source of truth for live data, and this
 * module is the stable description an agent can read without executing it.
 *
 * The one thing an agent cannot get from a static file is the current session
 * list, because OpenF1 is queried directly from the browser. The documents say
 * that plainly rather than pretending there is a server-side data endpoint.
 * ------------------------------------------------------------------------ */

export const SITE = "https://f1-practice-session-analysis.pages.dev";
export const EMAIL = "soni.soni.parth@gmail.com";
export const REPO = "https://github.com/Aarson13/F1-Practice-session-analysis";

const lines = (...parts) => parts.join("\n").trim() + "\n";

export const HOME_MARKDOWN = lines(
  "# F1 Session Analyzer",
  "",
  "**F1 Session Analyzer** is a browser-based tool for turn-by-turn analysis of any Formula 1",
  "session: Practice 1–3, Qualifying, Sprint Qualifying, Sprint and Race. Pick a year, Grand",
  "Prix and session, and it compares each driver's best lap at the same point on track to show",
  "who is fastest through every corner — for drivers and for teams.",
  "",
  "- **Live site:** https://f1-practice-session-analysis.pages.dev/",
  "- **Author:** Parth Soni",
  "- **Contact:** soni.soni.parth@gmail.com",
  "- **Source:** https://github.com/Aarson13/F1-Practice-session-analysis",
  "- **Data:** live from the [OpenF1 API](https://openf1.org); nothing is stored by this site.",
  "",
  "## When to use this",
  "",
  "Use the analyzer when the task is one of these:",
  "",
  "- **Compare two drivers corner by corner.** Open the Head-to-Head tab after analyzing a",
  "  session; it ranks the speed delta at every corner and draws the duel on a track map.",
  "- **Find the fastest driver and team through each turn.** The Corners and Drivers & Teams",
  "  tabs rank every corner window and count corner wins per team.",
  "- **Read a session's official classification.** The Classification tab shows the result and",
  "  the Drivers tab shows best-lap times, compounds and gaps.",
  "- **Look at race pace and tyre degradation.** For a Race, the Race Pace tab gives stint",
  "  averages and a least-squares degradation slope, excluding out-laps and incident laps.",
  "- **See how a weekend changed.** The Weekend tab analyses every session of the selected Grand",
  "  Prix and compares which team owned each corner, session by session.",
  "- **Inspect speed traces or sectors.** The Traces and Sectors tabs show overlaid speed against",
  "  lap progress, sector splits and speed traps.",
  "",
  "Do **not** use it as an official timing source, a race result feed, a prediction engine or a",
  "live telemetry service. It analyses a completed session after OpenF1 has published the data.",
  "",
  "## How to call it",
  "",
  "The product is an interactive browser app, not a JSON API. There is no server-side session or",
  "lap endpoint here; the app fetches OpenF1 directly from the visitor's browser. To read the",
  "site as an agent:",
  "",
  "- Request HTML at `/`, `/about`, `/contact` or `/privacy` for a browser.",
  "- Request the same URL with `Accept: text/markdown` for Markdown.",
  "- `/index.md`, `/about.md`, `/contact.md` and `/privacy.md` always return Markdown.",
  "- Read `/llms.txt` for a compact guide and `/sitemap.xml` for the published pages.",
  "",
  "A shared analysis is a fragment on the homepage, not a separate route:",
  "`/#y=2024&m=<meeting_key>&s=<session_key>`. The app restores the selectors and runs the",
  "analysis when that fragment is present. `COMBINED` as the session key pools FP1–FP3.",
  "",
  "```bash",
  "curl -sS -H 'Accept: text/markdown' https://f1-practice-session-analysis.pages.dev/",
  "curl -sS https://f1-practice-session-analysis.pages.dev/llms.txt",
  "```",
  "",
  "## What the analysis does",
  "",
  "For each selected driver the app takes the fastest non-pit-out lap of the chosen session,",
  "integrates the speed samples into distance travelled, and resamples the lap to 1,000 evenly",
  "spaced points so every driver is compared at the same piece of asphalt. Official circuit",
  "geometry supplies each corner apex; a corner is a window of roughly ±1.2% of lap distance",
  "around that apex, ranked by average speed. A team's score is the mean of its drivers, and",
  "\"corners won\" counts the windows a team topped.",
  "",
  "## Data source, freshness and limits",
  "",
  "Meetings, sessions, drivers, laps, car data, stints, results and circuit geometry come from",
  "the public OpenF1 API at request time. The site stores no F1 data and has no database. OpenF1",
  "is unofficial and its coverage varies by session: a session that has not been published yet",
  "cannot be analyzed, and telemetry gaps can remove a driver from a comparison. The free API",
  "allows roughly three requests per second, so an all-drivers run takes about a minute; the app",
  "paces and retries its requests, but a rate limit can still make a run fail.",
  "",
  "This project is independent and is not affiliated with Formula 1, the FIA, any team, OpenF1",
  "or the championship. Times and rankings are derived from published telemetry, not official",
  "timing, and should not be treated as a result or as a prediction.",
  "",
  "## Pages",
  "",
  "- [Analyzer](https://f1-practice-session-analysis.pages.dev/) — pick a session and analyze it.",
  "- [About](https://f1-practice-session-analysis.pages.dev/about) — method, sources and limits.",
  "- [Contact](https://f1-practice-session-analysis.pages.dev/contact) — corrections and bugs.",
  "- [Privacy](https://f1-practice-session-analysis.pages.dev/privacy) — requests and local state.",
  "- [Sitemap](https://f1-practice-session-analysis.pages.dev/sitemap.xml)",
  "- [Agent guide](https://f1-practice-session-analysis.pages.dev/llms.txt)",
  ""
);

export const ABOUT_MARKDOWN = lines(
  "# About F1 Session Analyzer",
  "",
  "**Last updated:** 21 October 2026",
  "",
  "F1 Session Analyzer is an independent, browser-based tool for looking past the headline lap",
  "time of a Formula 1 session. It compares every driver's best lap at the same point on track and",
  "shows who is quickest through each corner, which team owns each part of the lap, and how the",
  "picture changes between sessions of the same weekend.",
  "",
  "The project is built and maintained by **Parth Soni**. It is not affiliated with Formula 1,",
  "the FIA, any team, any circuit or OpenF1. The analysis is derived from public telemetry; it is",
  "not official timing and it is not a prediction of a race result.",
  "",
  "## What it covers",
  "",
  "- **Session analysis:** Practice 1–3, Qualifying, Sprint Qualifying, Sprint and Race, from 2023",
  "  onward, subject to OpenF1's published coverage.",
  "- **Turn-by-turn ranking:** the fastest driver and team at every corner, with the top three and",
  "  their gaps, plus a track map coloured by the fastest team per segment.",
  "- **Head-to-head:** any two analyzed drivers, corner by corner, with a duel map and speed deltas.",
  "- **Drivers and teams:** best laps, tyre compounds, gaps, corner wins and per-team averages.",
  "- **Sectors, traps and traces:** intermediate splits, finish-line speed traps and overlaid speed",
  "  traces against lap progress.",
  "- **Race pace:** stint-average pace and a least-squares tyre-degradation slope, with out-laps and",
  "  incident laps excluded.",
  "- **Weekend view:** a lighter top-five analysis of every session of the selected Grand Prix,",
  "  showing how corner dominance shifted from practice to qualifying to the race.",
  "- **Classification and CSV:** the official session result and CSV export from every table.",
  "",
  "## Where the data comes from",
  "",
  "The browser calls the public [OpenF1 API](https://openf1.org) for meetings, sessions, drivers,",
  "laps, car data, stints, results and the circuit geometry URL. No F1 data is stored by this site",
  "and no server-side database is involved. OpenF1 is an independent community project, so its",
  "coverage, field names and availability can change; a session that has not been published yet",
  "will not analyze.",
  "",
  "## How the comparison works",
  "",
  "Speed samples arrive over time, and drivers reach the same corner at different times. The app",
  "integrates speed into distance travelled and resamples each best lap to 1,000 evenly spaced",
  "points, so point 500 is the same piece of asphalt for every driver. Apex positions come from the",
  "circuit geometry; each corner is a window of about ±1.2% of lap distance around its apex. The",
  "ranking within that window is average speed, so a higher number means the driver carried more",
  "speed through the turn. A team's score is the mean of its drivers, and corner wins count the",
  "windows a team topped.",
  "",
  "## What it is not",
  "",
  "This is a fan-built analysis tool, not an official timing service. It does not show live",
  "telemetry, predict qualifying or race outcomes, or account for fuel load, tyre age, engine modes,",
  "track evolution or team instructions that are not in the public data. Treat small gaps with",
  "care: a few tenths can be noise from telemetry sampling, traffic or a driver's out-lap. For an",
  "official result, use Formula 1's own timing and classification.",
  "",
  "Corrections and bug reports: soni.soni.parth@gmail.com or the",
  "[GitHub issue tracker](https://github.com/Aarson13/F1-Practice-session-analysis/issues).",
  "More detail: https://f1-practice-session-analysis.pages.dev/contact",
  ""
);

export const CONTACT_MARKDOWN = lines(
  "# Contact and corrections",
  "",
  "F1 Session Analyzer is a personal project, so there is no support desk and no guaranteed",
  "response time. Reproducible bugs and corrections that can be checked against the public data",
  "are usually looked at first.",
  "",
  "## Where to send it",
  "",
  "- **Email:** soni.soni.parth@gmail.com — best for a data correction, a privacy question or a",
  "  general note.",
  "- **GitHub issues:** https://github.com/Aarson13/F1-Practice-session-analysis/issues — best for",
  "  a reproducible bug in the analyzer, a chart, a table or the Pages function.",
  "",
  "## What makes a report actionable",
  "",
  "Include the **year, Grand Prix and session**, and the share fragment from the address bar",
  "(`#y=…&m=…&s=…`) if you have one. For a chart or table problem, name the tab and the driver or",
  "team, and say what you expected instead. A screenshot and the browser name help. For a missing",
  "session, check whether OpenF1 has published it before reporting it here — the analyzer can only",
  "use what the API returns.",
  "",
  "## What not to send",
  "",
  "Do not send passwords, payment details, identity documents or other sensitive personal data.",
  "Nothing in this project needs them. The site has no accounts and no private case data.",
  "",
  "## Privacy",
  "",
  "The analyzer fetches OpenF1 directly from your browser and stores no analysis on a server. See",
  "https://f1-practice-session-analysis.pages.dev/privacy for the requests the page makes, the",
  "local browser state it keeps and how to contact the maintainer about it.",
  ""
);

export const PRIVACY_MARKDOWN = lines(
  "# Privacy notice — F1 Session Analyzer",
  "",
  "**Last updated:** 21 October 2026",
  "",
  "F1 Session Analyzer has no accounts, no sign-in, no advertising and no analytics product. This",
  "page explains the small amount of data involved when you use it: the requests your browser",
  "makes, the state it keeps locally, and the choices you have.",
  "",
  "## What happens in your browser",
  "",
  "When you analyze a session, your browser calls the public OpenF1 API directly for meetings,",
  "sessions, drivers, laps, telemetry, stints, results and circuit geometry. Those requests go from",
  "your device to `api.openf1.org`; OpenF1 can see your IP address, user agent and the requested",
  "URL, under its own privacy terms. This site does not proxy or store the responses. The circuit",
  "images and driver photos shown in the interface are loaded from the URLs OpenF1 publishes.",
  "",
  "The page also loads its fonts from Google Fonts (`fonts.googleapis.com` and",
  "`fonts.gstatic.com`), so Google receives the request metadata needed to serve them. Everything",
  "else — the app, its styles, charts, grids, icons and feedback code — is served from this site.",
  "",
  "## Local state and sharing",
  "",
  "The analyzer does not use cookies, `localStorage` or `sessionStorage` to keep an analysis. A",
  "share link puts the selected year, meeting and session in the URL fragment (`#y=…&m=…&s=…`).",
  "Fragments are not sent to the server in an HTTP request; they stay in the address bar and in the",
  "link you copy. Clearing the fragment or pressing Reset removes it.",
  "",
  "CSV exports are generated in your browser and downloaded to your device. Nothing is uploaded.",
  "",
  "## Hosting and server logs",
  "",
  "The site is hosted on Cloudflare Pages with a small Pages Function. Cloudflare processes the",
  "request needed to serve a page or the feedback route, including IP address, URL, user agent and",
  "timestamp, under its own privacy terms, and may keep security and operational logs. The",
  "maintainer does not run an analytics product over those logs, does not build visitor profiles",
  "and does not sell or share them.",
  "",
  "## Feedback",
  "",
  "The feedback route accepts a message only when the deployment has its feedback store bound;",
  "otherwise it returns an error instead of silently losing the message. A stored message includes",
  "the text you submit and the route's anti-abuse metadata. It is used to improve the analyzer and",
  "is not published. There is no feedback form in the current interface, so this only applies if a",
  "form is added later or the route is called directly.",
  "",
  "## Email",
  "",
  "If you email soni.soni.parth@gmail.com, the message and your address are processed by Gmail so",
  "it can be delivered and answered. They are used to reply and keep a record of the conversation;",
  "they are not added to a marketing list and are not sold. Ask for a message to be deleted and it",
  "will be, unless a legal obligation requires it to be kept.",
  "",
  "## Your rights and changes",
  "",
  "Under the GDPR you can ask what personal data is held about you, request a copy, ask for",
  "correction or erasure, or object to processing. Use soni.soni.parth@gmail.com. You also have the",
  "right to complain to the Irish Data Protection Commission (https://www.dataprotection.ie/). If",
  "this notice changes, the date at the top changes with it.",
  ""
);

export function notFoundMarkdown(pathname) {
  const path = pathname && pathname !== "/" ? String(pathname).replace(/`/g, "'") : "this address";
  return lines(
    "# Page not found",
    "",
    `Nothing is published at \`${path}\` on f1-practice-session-analysis.pages.dev. The page may`,
    "have moved, or the link may be mistyped.",
    "",
    "Start from the [analyzer](https://f1-practice-session-analysis.pages.dev/). Every published",
    "page is listed in the [sitemap](https://f1-practice-session-analysis.pages.dev/sitemap.xml),",
    "and [llms.txt](https://f1-practice-session-analysis.pages.dev/llms.txt) explains what the",
    "site does and when to use it.",
    ""
  );
}

export const NOT_ACCEPTABLE_MARKDOWN = lines(
  "# Not acceptable",
  "",
  "This site publishes HTML and Markdown. The request's `Accept` header excludes both, so no",
  "representation can be returned.",
  "",
  "Ask for `text/html` or `text/markdown`. The Markdown home page is at",
  "https://f1-practice-session-analysis.pages.dev/index.md, and",
  "https://f1-practice-session-analysis.pages.dev/llms.txt describes the site.",
  ""
);

/* ---------------------------------------------------------------------------
 * Content negotiation (RFC 9110 §12.5.1).
 *
 * Markdown is selected only when `text/markdown` is named explicitly and its
 * quality is at least the quality of `text/html`. Browsers send HTML plus a
 * wildcard and keep getting HTML; curl's default wildcard does too. Wildcards
 * contribute quality but never select Markdown on their own.
 * ------------------------------------------------------------------------ */

function parseAccept(header) {
  return header
    .split(",")
    .map((part) => {
      const [rawType, ...params] = part.trim().split(";");
      const [type, subtype] = rawType.trim().toLowerCase().split("/");
      if (!type || !subtype) return null;
      let q = 1;
      for (const param of params) {
        const [key, value] = param.trim().split("=");
        if (key && key.trim().toLowerCase() === "q") {
          const parsed = Number.parseFloat(value);
          q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
        }
      }
      return { type, subtype, q };
    })
    .filter(Boolean);
}

function qualityFor(type, subtype, ranges) {
  let best = null;
  for (const range of ranges) {
    if (range.type !== "*" && range.type !== type) continue;
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    const specificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
    if (!best || specificity > best.specificity) best = { specificity, q: range.q };
  }
  return best ? best.q : 0;
}

/**
 * @param {string | null} header the request's Accept header
 * @returns {"markdown" | "html" | "not-acceptable"}
 */
export function negotiate(header) {
  if (!header || !header.trim()) return "html";
  const ranges = parseAccept(header);
  if (ranges.length === 0) return "html";

  const namedMarkdown = ranges.some(
    (range) => range.type === "text" && range.subtype === "markdown"
  );
  const markdown = qualityFor("text", "markdown", ranges);
  const html = qualityFor("text", "html", ranges);

  if (namedMarkdown && markdown > 0 && markdown >= html) return "markdown";
  if (html > 0) return "html";
  if (!namedMarkdown && markdown > 0) return "markdown";
  return "not-acceptable";
}

export const DOCUMENTS = new Map([
  ["/", { markdown: HOME_MARKDOWN, alternate: "/index.md", file: "/index.html" }],
  ["/about", { markdown: ABOUT_MARKDOWN, alternate: "/about.md", file: "/about.html" }],
  ["/contact", { markdown: CONTACT_MARKDOWN, alternate: "/contact.md", file: "/contact.html" }],
  ["/privacy", { markdown: PRIVACY_MARKDOWN, alternate: "/privacy.md", file: "/privacy.html" }],
]);

export const MARKDOWN_ALIASES = new Map([
  ["/index.md", HOME_MARKDOWN],
  ["/about.md", ABOUT_MARKDOWN],
  ["/contact.md", CONTACT_MARKDOWN],
  ["/privacy.md", PRIVACY_MARKDOWN],
]);

/** Add Accept to a Vary header without dropping what is already there. */
export function mergeVary(headers) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Accept");
    return headers;
  }
  if (current.trim() === "*") return headers;
  const values = current.split(",").map((value) => value.trim().toLowerCase());
  if (!values.includes("accept")) headers.set("Vary", `${current}, Accept`);
  return headers;
}

export function markdownResponse(body, status = 200, method = "GET") {
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
