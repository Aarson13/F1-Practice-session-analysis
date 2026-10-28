# F1 Session Analyzer - DESIGN.md

Working design notes for the timing-screen concept. Stack: keep the
project's own engine (static HTML + vanilla JS + canvas, zero build)
plus three pinned CDN components: Shoelace 2.18 (controls), Tabulator 6.3
(data grids, sorting, CSV), ECharts 5.5 (traces, zoom, legend toggles).
All three are vendored under `vendor/` and served same-origin: the app
fully works with third-party CDNs blocked (proven by test). Shoelace needs
`data-shoelace="/vendor/shoelace"` on its script tag - without it, dynamic
imports resolve against the document and 404 silently (swallowed by the
autoloader's allSettled). Init gates on `sl-select` definition with an 8s
timeout fallback so a missing library explains itself instead of hanging.
Per the creative brief: borrow the rules of F1 broadcast timing graphics.

## Concept Card

- Idea: the timing screen, weaponized for fan arguments.
- Metaphor: pit-wall timing and broadcast graphics (condensed italic type,
  slant ticks, carbon dark, one red accent, team colors as data only).
- Signature: the head-to-head duel map. Two colors fight over one lap.
  Everything else stays quiet and precise.
- Emotion: race control at night. Serious tool, zero clutter.
- Motion verb: snap and settle. Fast ease-outs, nothing ambient.
- Screenshot: duel map with two speed traces and per-corner delta table.

## System (locked)

- Palette: ground `#07080c`, ink `#f2f4f9`, muted `#9aa5bc`, line `#242e48`,
  accent F1 red `#e10600` (singular; team colors are data, never chrome).
- Type: Barlow Condensed italic 700 for display, Barlow for body,
  tabular numerals in every table.
- Shape rule: cards 16px, controls 10px, pills 999px.
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)`. Transform and opacity only.
- Reduced motion: all animation collapses to static. Replay is
  user-triggered playback (like a video player), never ambient.
- Copy: sentence case, specific nouns, true numbers only. No decorative
  dashes in prose; the tabular dash stays inside data cells only.

## Decisions

- No framework migration: looks come from design, and a rewrite risks the
  tested analysis engine plus the zero-build Pages deploy.
- No loader theatrics, no WebGL, no scroll hijack. Theatre budget goes to
  the duel map, the replay, and hover/click linking between map and tables.
- Phone layout is composed (single column, scrolling tables), not squished.
- Idle page is still. Progress shimmer runs only while loading.
- Tabulator theming note: v6 scopes table bg at 0,3,0
  (`.tabulator .tabulator-tableholder .tabulator-table`), so overrides must
  outbid it (see `.grid.tabulator ...` rules). Verified by computed-style
  probe, not by eye.
- QA: Playwright-driven full analysis (Singapore 2024 FP1, top 5) with
  screenshots of every state; axe clean; no console/page/network errors
  except OpenF1 429s absorbed by the app's own retry pacing.
- Tabulator a11y repair (verified live, not by eye): its async header nests
  rowgroup-in-rowgroup and its scroll holder is a focusable roleless div,
  both fatal to axe ownership rules. makeGrid re-roles the inner wrapper to
  row and drops the holder tabindex (harmless: tables are auto-height, the
  page scrolls), re-applied on tableBuilt + renderComplete. Full analyzed
  state: axe CLEAN, sorting + sort arrows verified working.
