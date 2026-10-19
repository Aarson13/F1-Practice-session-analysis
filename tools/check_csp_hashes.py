#!/usr/bin/env python3
"""Keep the Content-Security-Policy's inline-script hashes in step with index.html.

Usage:
    python tools/check_csp_hashes.py

This site was the one host in the collection with no Content-Security-Policy at
all (measured 15 Oct 2026: it sent referrer-policy, x-content-type-options and
cache-control only), while its siblings send strict ones. `public/_headers` now
pins each inline <script> in `public/index.html` by SHA-256.

Two ways that pair goes wrong, and both are silent on the deployed site rather
than visible locally (a plain static server sends no CSP at all):

  * an inline script is edited and its hash is not — the browser refuses to run
    it, so the page renders and part of its behaviour is simply missing. This
    page boots from two inline blocks (the reduced-motion guard and the UI-library
    boot check), so a missing hash is a page that half-works;
  * a hash is left behind after the script it described is gone — a dead
    allowance nobody notices, and the next script edited into that slot is
    allowed by accident.

Run this after touching either inline block, then paste the hashes it reports
into `public/_headers`. It fails instead of reporting a stale list, which is why
it belongs in CI: a pushed deploy is a published CSP.

The hash is over the script's SOURCE TEXT, which is not quite the file's bytes:
HTML's input-stream preprocessing turns CRLF into LF before the tokenizer sees
it, so a script written with Windows line endings is still hashed by every
browser in its LF form. That is not a detail this file can guess at — computing
it from the raw bytes produced hashes the browser then refused (measured in this
collection: Irish's index.html is CRLF, and its directives were rejected with the
LF hashes quoted as the expected ones). So the hash is taken over `\r\n` → `\n`,
and lone `\r` → `\n` with it, the other half of the same rule.

It also fails if `script-src` carries `'unsafe-inline'`. That directive is what
this file exists to keep out: with it, a hash list is decoration, because every
inline script the page can be made to contain already runs.

Exit codes: 0 = in step, 1 = out of step, 2 = setup problem.
"""
import base64
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
INDEX = ROOT / "public" / "index.html"
HEADERS = ROOT / "public" / "_headers"

SCRIPT_RE = re.compile(r"<script\b(?P<attrs>[^>]*)>(?P<body>.*?)</script>",
                       re.DOTALL | re.IGNORECASE)
JS_TYPES = {"text/javascript", "application/javascript", "module"}


def read_raw(path):
    """Read a file with its line endings left exactly as they are on disk.

    The bytes themselves are what the deploy serves, so nothing here may
    rewrite them; the one transformation a CSP hash needs (CRLF → LF) belongs
    to the browser's parser, and `inline_scripts` applies it to the script's
    source text where it is visible in the code rather than hidden in a read.
    """
    with open(path, "r", encoding="utf-8", newline="") as fh:
        return fh.read()


def inline_scripts(html):
    """[(hash, where, snippet)] for every inline, JS-typed script block."""
    found = []
    for m in SCRIPT_RE.finditer(html):
        attrs = m.group("attrs")
        if re.search(r"\bsrc\s*=", attrs, re.IGNORECASE):
            continue  # external script: 'self' covers it, no hash applies
        t = re.search(r"type\s*=\s*[\"']([^\"']+)[\"']", attrs, re.IGNORECASE)
        if t and t.group(1).strip().lower() not in JS_TYPES:
            continue  # JSON-LD and other non-executable payloads are not script
        line = html.count("\n", 0, m.start()) + 1
        # The source text the browser hashes, not the file's bytes (see above).
        source = m.group("body").replace("\r\n", "\n").replace("\r", "\n")
        digest = base64.b64encode(hashlib.sha256(source.encode("utf-8")).digest()).decode()
        snippet = " ".join(source.split())[:48]
        found.append((digest, f"inline script at line {line}", snippet))
    return found


def main():
    for path in (INDEX, HEADERS):
        if not path.is_file():
            print(f"error: {path} not found", file=sys.stderr)
            return 2

    html = read_raw(INDEX)
    headers = read_raw(HEADERS)

    scripts = inline_scripts(html)
    if not scripts:
        print(f"error: no inline script blocks found in {INDEX.name}", file=sys.stderr)
        return 2

    csp = re.search(r"^[ \t]*Content-Security-Policy:[ \t]*(.+)$", headers, re.MULTILINE)
    if not csp:
        print("error: no Content-Security-Policy found in _headers", file=sys.stderr)
        return 2
    policy = csp.group(1)

    declared = {m.group(1) for m in re.finditer(r"'sha256-([A-Za-z0-9+/=]+)'", policy)}
    actual = {digest for digest, _, _ in scripts}

    problems = []
    for digest, where, snippet in scripts:
        if digest not in declared:
            problems.append(f"MISSING  sha256-{digest}  ({where}: \"{snippet}…\") — "
                            "the browser will refuse to run it")
    for digest in sorted(declared - actual):
        problems.append(f"STALE    sha256-{digest}  matches no inline script — "
                        "left over from an edit, and an allowance for whatever lands there next")

    script_src = re.search(r"script-src([^;]*)", policy)
    if not script_src:
        problems.append("script-src is missing from the policy, so scripts fall back to default-src")
    elif "'unsafe-inline'" in script_src.group(1):
        problems.append("script-src carries 'unsafe-inline' — it makes the hash list decoration, "
                        "because every inline script the page can be made to contain then runs")

    # The external origin this page uses is the live session data, and a host that
    # disappears from the policy is a fetch that silently stops working in the
    # browser — so it is named here rather than left to memory.
    if "https://api.openf1.org" not in policy:
        problems.append("https://api.openf1.org is not in the policy — the browser will "
                        "block the live session data it serves")

    # The fonts, on the other hand, must not be named any more. They are served
    # from /fonts/ (see tools/self-host-fonts.mjs, which writes public/fonts.css),
    # so `font-src 'self'` is the whole of what the policy needs for them. A Google
    # origin left here is a stale allowance, and the same origin coming *back* to
    # index.html would be a <link> the policy no longer permits — both directions
    # fail quietly on the page, in a fallback face nobody would call a bug, which
    # is exactly why both are asserted.
    for origin in ("fonts.googleapis.com", "fonts.gstatic.com"):
        if origin in policy:
            problems.append(f"{origin} is still in the policy — the fonts are self-hosted "
                            "(public/fonts/, written by tools/self-host-fonts.mjs), so this "
                            "allowance is either stale or a Google <link> that came back")

    if problems:
        print(f"check_csp_hashes: {len(problems)} problem(s):", file=sys.stderr)
        for problem in problems:
            print("  " + problem, file=sys.stderr)
        return 1

    print(f"OK: {len(scripts)} inline script block(s) hashed in the CSP, "
          "no stale hashes, no 'unsafe-inline' in script-src")
    return 0


if __name__ == "__main__":
    sys.exit(main())
