"""Part 7 verification for the F1 Session Analyzer upgrade.
Serves public/ locally, drives Chromium (Python Playwright) and checks:
assets, playback, sections/IDs, menu, reduced-motion, analyze flow, replay,
H2H, traces, CSV, share, scroll perf. Prints PASS/FAIL per check + summary.
"""
import functools
import http.server
import json
import os
import socketserver
import sys
import threading

# Windows console is cp1252: never let a unicode race name kill the harness.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

REPO = r"C:\Users\Parth\Desktop\Github\F1-Practice-session-analysis"
PUB = os.path.join(REPO, "public")
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), str(detail)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}")


def serve():
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=PUB)
    srv = socketserver.TCPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/"


def main():
    import time
    from playwright.sync_api import sync_playwright

    # ---- static asset checks ----
    for f, cap in (("bg.mp4", 3 * 1024 * 1024), ("bg.webm", 3 * 1024 * 1024)):
        p = os.path.join(PUB, "assets", f)
        sz = os.path.getsize(p)
        check(f"asset {f} exists + <={cap}B", os.path.exists(p) and sz <= cap, f"{sz}B")
    check("asset bg-poster.jpg exists",
          os.path.exists(os.path.join(PUB, "assets", "bg-poster.jpg")),
          f"{os.path.getsize(os.path.join(PUB, 'assets', 'bg-poster.jpg'))}B")

    srv, base = serve()
    with sync_playwright() as pw:
        b = pw.chromium.launch(
            executable_path=r"C:\Users\Parth\AppData\Local\ms-playwright\chromium-1248\chrome-win64\chrome.exe",
            args=["--autoplay-policy=no-user-gesture-required"])

        # ---- desktop pass ----
        pg = b.new_page(viewport={"width": 1280, "height": 800})
        errors = []
        pg.on("pageerror", lambda e: (errors.append(str(e)), print("PAGEERROR:", str(e)[:200])))
        pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        pg.on("console", lambda m: print("CONSOLE-WARN:", m.text[:160])
              if m.type == "warning" and "tab refresh failed" in m.text else None)
        pg.goto(base, wait_until="networkidle")
        pg.wait_for_timeout(2500)

        ticks = pg.eval_on_selector_all(".card .tick > span", "els => els.map(e => e.textContent.trim())")
        check("13 sections in order 01..13", ticks == [f"{i:02d}" for i in range(1, 14)], ticks)

        need_ids = ["yearSelect", "gpSelect", "sessionSelect", "driverLimitSelect",
                    "analyzeBtn", "copyLinkBtn", "resetBtn", "statusBox", "statusText",
                    "errorBox", "results", "resultTabs", "trackMap", "h2hMap",
                    "speedChart", "bgVideo", "bgToggle", "menuBtn", "navLinks",
                    "scrollProgress", "backToTop", "toastHost", "loader",
                    "cornerGrid", "driverGrid", "teamGrid", "sectorGrid",
                    "paceGrid", "resultGrid"]
        missing = [i for i in need_ids if not pg.evaluate(f"!!document.getElementById('{i}')")]
        check("all JS-used element IDs present", not missing, f"missing={missing}")

        v = pg.evaluate("""() => { const v = document.getElementById('bgVideo');
            return { rs: v.readyState, paused: v.paused, t0: v.currentTime,
                     src: (v.currentSrc || '').split('/').pop() }; }""")
        pg.wait_for_timeout(1500)
        t1 = pg.evaluate("document.getElementById('bgVideo').currentTime")
        check("video visibly plays behind content",
              v["rs"] >= 2 and not v["paused"] and t1 > v["t0"], f"{v} -> t={t1:.2f}")

        # toggle
        pg.click("#bgToggle")
        wrap_hidden = pg.evaluate("getComputedStyle(document.querySelector('.bg-video-wrap')).display === 'none'")
        lbl = pg.text_content("#bgToggle")
        check("Background toggle hides video", wrap_hidden and "Off" in lbl, lbl)
        pg.click("#bgToggle")

        # reveal on scroll
        pg.evaluate("document.getElementById('controlsCard').scrollIntoView()")
        pg.wait_for_timeout(800)
        check("scroll reveal adds .in once",
              pg.evaluate("document.getElementById('controlsCard').classList.contains('in')"))

        # ---- analyze flow (Top 5, first GP, qualifying-ish session) ----
        pg.evaluate("""() => {
            window.__pick = (id, prefer) => {
                const s = document.getElementById(id);
                const opts = [...s.querySelectorAll('sl-option')]
                    .filter(o => (o.getAttribute('value') || '') !== ''
                        && !/loading|pick |no .*found|select/i.test(o.textContent));
                if (!opts.length) return null;
                const pick = (prefer && opts.find(o => prefer.test(o.textContent))) || opts[0];
                s.value = pick.getAttribute('value');
                s.dispatchEvent(new CustomEvent('sl-change', {bubbles: true}));
                return pick.textContent.trim();
            };
        }""")
        pg.evaluate("document.getElementById('hero').scrollIntoView()")
        pg.wait_for_function("document.querySelectorAll('#yearSelect sl-option').length > 0", timeout=30000)
        pg.evaluate("window.__pick('yearSelect')")
        pg.wait_for_function(
            "() => [...document.querySelectorAll('#gpSelect sl-option')].some(o => "
            "(o.getAttribute('value')||'') !== '' && !/loading/i.test(o.textContent))", timeout=60000)
        print("   gp under test:", pg.evaluate("window.__pick('gpSelect', /grand prix/i)"))
        pg.wait_for_function(
            "() => [...document.querySelectorAll('#sessionSelect sl-option')].some(o => "
            "(o.getAttribute('value')||'') !== '' && !/loading/i.test(o.textContent))", timeout=60000)
        sess = pg.evaluate("window.__pick('sessionSelect', /qualifying|sprint/i)")
        pg.evaluate("""() => {
            const d = document.getElementById('driverLimitSelect');
            d.value = '5'; d.dispatchEvent(new CustomEvent('sl-change', {bubbles: true}));
        }""")
        print("   session under test:", sess)
        pg.wait_for_function("!document.getElementById('analyzeBtn').disabled", timeout=15000)
        # sampler: loader-visible + video-paused states during the run, toast counter
        pg.evaluate("""() => {
            window.__sawLoader = false; window.__sawPaused = false; window.__toasts = 0;
            setInterval(() => {
                try {
                    if (!document.getElementById('loader').hidden) window.__sawLoader = true;
                    if (document.getElementById('bgVideo').paused) window.__sawPaused = true;
                } catch (e) {}
            }, 400);
            new MutationObserver((m) => { window.__toasts += m.reduce((a, x) => a + x.addedNodes.length, 0); })
                .observe(document.getElementById('toastHost'), { childList: true });
        }""")
        pg.click("#analyzeBtn")
        try:
            pg.wait_for_function("!document.getElementById('results').hidden", timeout=600000)
        except Exception as e:
            check("analyze completes", False, f"timeout; status={pg.text_content('#statusText')[:120]}")
            raise SystemExit(1)
        check("analyze completes, results shown", True)
        pg.wait_for_timeout(1500)
        samp = pg.evaluate("({loader: window.__sawLoader, paused: window.__sawPaused, toasts: window.__toasts})")
        check("video paused during Analyze", samp["loader"] and samp["paused"], samp)
        check("video resumes after Analyze",
              pg.evaluate("document.getElementById('bgVideo').paused === false"))
        check("Analysis-complete toast fired", samp["toasts"] >= 1, samp)
        pg.evaluate("document.documentElement.style.scrollBehavior = ''")
        # NOTE: vendored sl-tab-group has no .show() method (verified), so tabs
        # are switched with real mouse clicks exactly like a user does.
        def diag(where):
            print("DIAG " + where + ": " + pg.evaluate("""() => {
                const g = customElements.get('sl-tab-group'), t = customElements.get('sl-tab');
                const tab = document.querySelector('#resultTabs sl-tab[panel="corners"]');
                const grid = document.getElementById('cornerGrid');
                const gr = grid ? grid.getBoundingClientRect() : {height: -1};
                return JSON.stringify({ defGroup: !!g, defTab: !!t,
                    tabUpgraded: !!(t && tab instanceof t),
                    tabActive: tab ? tab.hasAttribute('active') : null,
                    gridH: Math.round(gr.height),
                    err: (document.getElementById('errorBox').textContent || '').slice(0, 60) });
            }"""))
        def show_tab(name):
            # real mouse click (hit-tests into the shadow button); center the
            # tab instantly first (no smooth-scroll race), verify [active].
            for attempt in range(3):
                pg.evaluate(f"""() => {{
                    document.documentElement.style.scrollBehavior = 'auto';
                    document.querySelector('#resultTabs sl-tab[panel="{name}"]')
                        .scrollIntoView({{block: 'nearest', inline: 'center'}});
                }}""")
                pg.wait_for_timeout(400)
                pg.click(f'#resultTabs sl-tab[panel="{name}"]', timeout=30000)
                try:
                    pg.wait_for_function(
                        f"document.querySelector('#resultTabs sl-tab[panel=\"{name}\"]').hasAttribute('active')",
                        timeout=10000)
                    return
                except Exception:
                    diag(f"retry-{attempt}-{name}")
                    pg.wait_for_timeout(1000)
            pg.screenshot(path=os.environ.get("TEMP", ".") + f"\\tabfail-{name}.png")
            raise RuntimeError(f"tab {name} never became active")
        diag("post-results")
        # corners tab must be shown before Tabulator renders rows (lazy tab builds)
        show_tab("corners")
        pg.wait_for_function("document.querySelectorAll('#cornerGrid .tabulator-row').length > 0",
                             timeout=120000)
        n_rows = pg.evaluate("document.querySelectorAll('#cornerGrid .tabulator-row').length")
        check("corners grid populated", n_rows > 0, f"{n_rows} rows")

        # replay (map outline comes from an external fetch, so wait for the
        # legend first, then poll for status — no fixed sleeps on network)
        show_tab("track")
        try:
            pg.wait_for_function(
                "document.getElementById('mapLegend').textContent.trim().length > 0",
                timeout=90000)
        except Exception:
            pass
        pg.click("#replayBtn")
        rs = ""
        for _ in range(20):
            pg.wait_for_timeout(1000)
            rs = pg.text_content("#replayStatus") or ""
            if rs.strip():
                break
        check("track-map replay runs", len(rs.strip()) > 0, rs.strip()[:80])
        pg.click("#replayBtn")  # stop
        pg.wait_for_timeout(500)

        # head-to-head
        show_tab("duel")
        h2h = pg.evaluate("""() => {
            const a = document.getElementById('h2hA'), b = document.getElementById('h2hB');
            const oa = [...a.querySelectorAll('sl-option')], ob = [...b.querySelectorAll('sl-option')];
            if (oa.length < 2) return 'no-options';
            a.value = oa[0].getAttribute('value'); a.dispatchEvent(new CustomEvent('sl-change', {bubbles: true}));
            b.value = ob[1].getAttribute('value'); b.dispatchEvent(new CustomEvent('sl-change', {bubbles: true}));
            return 'set';
        }""")
        pg.wait_for_timeout(2000)
        h2htxt = pg.text_content("#h2hResult") or ""
        check("head-to-head renders deltas", h2h == "set" and len(h2htxt.strip()) > 20, h2htxt.strip()[:80])

        # traces zoom/drag
        show_tab("traces")
        pg.wait_for_timeout(500)
        box = pg.evaluate("""() => { const r = document.getElementById('speedChart').getBoundingClientRect();
            return {x: r.left + r.width/2, y: r.top + r.height/2}; }""")
        pg.mouse.move(box["x"] - 100, box["y"])
        pg.mouse.down()
        pg.mouse.move(box["x"] + 100, box["y"], steps=10)
        pg.mouse.up()
        pg.wait_for_timeout(500)
        check("speed-trace zoom/drag no crash", True)

        # CSV export
        show_tab("corners")
        with pg.expect_download() as dl:
            pg.click("#cornerCsvBtn")
        path = dl.value.path()
        check("CSV export downloads", os.path.getsize(path) > 100, f"{os.path.getsize(path)}B")

        # share link
        ctx0 = b.new_context(viewport={"width": 1280, "height": 800},
                             permissions=["clipboard-read", "clipboard-write"])
        pg2 = ctx0.new_page()
        pg2.goto(pg.url, wait_until="networkidle")
        pg2.wait_for_timeout(2000)
        pg2.click("#copyLinkBtn")
        pg2.wait_for_timeout(800)
        clip = pg2.evaluate("navigator.clipboard.readText().catch(() => '')")
        check("share link copies URL with #y=&m=&s=",
              "#y=" in clip and "&m=" in clip and "&s=" in clip, clip[:80])
        check("no page/console errors on desktop", not errors, errors[:3])
        pg.close()

        # ---- mobile 390px ----
        m = b.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        merrs = []
        m.on("pageerror", lambda e: merrs.append(str(e)))
        m.goto(base, wait_until="networkidle")
        m.wait_for_timeout(2500)
        mv = m.evaluate("""() => { const v = document.getElementById('bgVideo');
            return { playing: v.readyState >= 2 && !v.paused }; }""")
        check("video plays on 390px mobile (no gating)", mv["playing"], mv)
        check("menu button visible on mobile",
              m.evaluate("getComputedStyle(document.getElementById('menuBtn')).display !== 'none'"))
        m.click("#menuBtn")
        check("menu opens nav links",
              m.evaluate("document.getElementById('navbar').classList.contains('nav-open')"))
        for w in (360, 768):
            m.set_viewport_size({"width": w, "height": 844})
            m.wait_for_timeout(600)
            over = m.evaluate("document.documentElement.scrollWidth - window.innerWidth")
            check(f"no horizontal scroll at {w}px", over <= 1, f"overflow={over}px")
        check("no page errors on mobile", not merrs, merrs[:3])
        m.close()

        # ---- reduced motion: poster only ----
        r = b.new_page(viewport={"width": 1280, "height": 800}, reduced_motion="reduce")
        r.goto(base, wait_until="networkidle")
        r.wait_for_timeout(2000)
        check("reduced-motion shows poster only (video removed)",
              r.evaluate("!document.querySelector('.bg-video-wrap video') && "
                         "getComputedStyle(document.body).backgroundImage.includes('bg-poster')"))
        r.close()

        # ---- 5s scroll perf: fps + longtasks ----
        p = b.new_page(viewport={"width": 1280, "height": 800})
        p.goto(base, wait_until="networkidle")
        p.wait_for_timeout(1500)
        perf = p.evaluate("""() => new Promise((resolve) => {
            const tasks = [];
            try { new PerformanceObserver((l) => l.getEntries().forEach(e => tasks.push(e.duration)))
                .observe({entryTypes: ['longtask']}); } catch (e) {}
            const ts = []; let frames = 0;
            function tick(t) { ts.push(t); frames++;
                if (t - ts[0] < 5000) requestAnimationFrame(tick);
                else {
                    const d = ts.slice(1).map((x, i) => x - ts[i]);
                    d.sort((a, b) => a - b);
                    resolve({ fps: (1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1),
                              p95: d[Math.floor(d.length * 0.95)].toFixed(1),
                              longtasks: tasks.filter(x => x > 50).length,
                              maxTask: tasks.length ? Math.max(...tasks).toFixed(0) : 0 });
                } }
            const h = document.documentElement.scrollHeight - innerHeight;
            let y = 0; const step = () => { y = (y + h / 60) % (h || 1); scrollTo(0, y);
                if (performance.now() - ts[0] < 5000 || !ts.length) setTimeout(step, 80); };
            requestAnimationFrame(tick); step();
        })""")
        check("scroll ~60fps, no >50ms UI longtasks",
              float(perf["fps"]) >= 50 and perf["longtasks"] == 0, perf)
        p.close()
        b.close()

    srv.shutdown()
    fails = [r for r in RESULTS if not r[1]]
    print(f"\n==== {len(RESULTS) - len(fails)}/{len(RESULTS)} checks passed ====")
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
