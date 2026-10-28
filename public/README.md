# This path is not part of the site

`/README.md` is not published by this deployment, and this file exists only to
hold the path.

The project's first Cloudflare Pages deployment uploaded the repository root, so
the repository's own README was reachable at this URL. Moving the site into
`public/` took it out of the deployment, and the edge went on serving the old
copy anyway - measured on 14 Oct 2026: `200` with the old body,
`CF-Cache-Status: HIT`, `Age` ~42,000s, `Cache-Control: public,
s-maxage=604800`, while the same path with any query string answered `404`. Pages
retains removed assets; a redeploy does not evict them.

The documentation lives in the repository, which is public:
<https://github.com/Aarson13/F1-Practice-session-analysis>

The site itself is <https://f1-practice-session-analysis.pages.dev/> - its
publish set is the `public/` directory, and nothing else in the repository is
part of it. This file is one of three path-holders like it (`DESIGN.md` and
`.assetsignore` are the others, and they say the same thing), so those paths
answer with a statement rather than with the documents the first deployment
published.
