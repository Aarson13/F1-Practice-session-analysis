# This path is not part of the site

`/DESIGN.md` is not published by this deployment, and this file exists only to
hold the path: the project's first Pages deployment uploaded the repository root,
so its design notes were reachable here, and the edge kept serving that copy
after the site moved into `public/` (measured 14 Oct 2026 — `200`,
`CF-Cache-Status: HIT`, `Age` ~42,000s — while the same path with a query string
answered `404`).

The notes live at <https://github.com/Aarson13/F1-Practice-session-analysis>,
next to the code they describe. Nothing here is site content.
