/* =====================================================================
 * F1 Session Analyzer — LIGHT UI LAYER  (animations.js)
 * ---------------------------------------------------------------------
 * PERF rewrite. UI-ONLY: this file never touches data fetching (OpenF1),
 * analysis logic, chart/track-map rendering, element IDs, JS-used class
 * names, CSV export or share links. It only adds presentation on top of
 * the app's own state (extra listeners/observers — app handlers untouched).
 *
 * Removed outright (see git history for the old motion build):
 *   PERF: custom cursor (dot/ring, mousemove + rAF loop) — deleted.
 *   PERF: tsParticles ember canvas — deleted.
 *   PERF: Vanilla-Tilt 3D tilt — deleted.
 *   PERF: Lenis smooth-scroll — deleted; native scroll-behavior: smooth.
 *   PERF: GSAP + ScrollTrigger (only used by the removed effects) — deleted.
 *   PERF: CountUp.js KPI animation — deleted; final numbers render as-is.
 *   PERF: Splitting.js letter reveal + Typed.js subtitle — deleted; the hero
 *         title uses one CSS fade-in and the subtitle is static text.
 *   PERF: scroll-linked parallax / scrub animations — deleted.
 * No third-party scripts remain; this local file is deferred.
 *
 * What this file still does (all cheap):
 *   1. environment + video gating helpers
 *   2. lightweight background video (load after paint, pause when busy)
 *   3. one-time section reveals via IntersectionObserver
 *   4. one passive rAF-throttled scroll handler (progress bar, navbar, top)
 *   5. tab-aware anchor links (native smooth scroll)
 *   6. loader + skeleton + toasts hooked to existing app state
 *   7. click ripple + team-colour chip glow (static, once per render)
 * ===================================================================== */
(function () {
  "use strict";

  /* -------------------- 1. environment + gating -------------------- */
  var reduced = false;
  try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  var saveData = !!connection.saveData;
  var motionOK = !reduced;
  var navEl = document.getElementById("navbar");
  var navH = 64;

  /* PERF: rAF throttle shared by the single scroll/resize handler below. */
  function rafThrottle(fn) {
    var queued = false, lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn.apply(null, lastArgs); });
    };
  }
  function on(el, ev, fn, opt) { if (el) el.addEventListener(ev, fn, opt); }

  /* PERF: user toggle lives in a JS variable only (no localStorage). */
  var bgUserOn = true;
  var analyzing = false;

  function videoAllowed() {
    if (!bgUserOn || reduced) return false;
    if (window.innerWidth < 768) return false;
    if (saveData) return false;
    /* PERF: skip the video on slow networks and weak CPUs entirely. */
    var et = "";
    try { et = connection.effectiveType || ""; } catch (e) {}
    if (et === "slow-2g" || et === "2g" || et === "3g") return false;
    var cores = 0;
    try { cores = navigator.hardwareConcurrency || 0; } catch (e) {}
    if (cores && cores <= 4) return false;
    return true;
  }

  /* -------------------- 2. lightweight background video -------------------- */
  function setupVideo() {
    var v = document.getElementById("bgVideo");

    /* PERF: gated-out devices get the poster image only (or the solid dark
       background), and the <video> element is dropped so nothing downloads. */
    if (!videoAllowed()) {
      document.body.style.backgroundImage = "url('assets/bg-poster.jpg')";
      document.body.style.backgroundSize = "cover";
      document.body.style.backgroundPosition = "center";
      document.body.style.backgroundAttachment = "fixed";
      if (v) v.remove();
      return;
    }
    if (!v) return;
    var toggle = document.getElementById("bgToggle");

    function paintToggle() {
      if (!toggle) return;
      toggle.textContent = bgUserOn ? "Background: On" : "Background: Off";
      toggle.setAttribute("aria-pressed", bgUserOn ? "true" : "false");
    }
    function tryPlay() {
      if (!videoAllowed() || analyzing || document.hidden) return;
      try {
        var p = v.play();
        if (p && p.catch) p.catch(function () { /* autoplay blocked → poster stays */ });
      } catch (e) {}
    }

    /* PERF: preload="none" in markup + start loading only after window
       'load' + 1s, so the video never blocks first paint or API calls. */
    function kickOff() {
      if (!videoAllowed()) return;
      try { v.load(); } catch (e) {}
      tryPlay();
    }
    if (document.readyState === "complete") setTimeout(kickOff, 1000);
    else { on(window, "load", function () { setTimeout(kickOff, 1000); }); }

    /* PERF: pause when the tab is hidden (cheap visibility hook). */
    on(document, "visibilitychange", function () {
      if (document.hidden) { try { v.pause(); } catch (e) {} }
      else tryPlay();
    });

    if (toggle) on(toggle, "click", function () {
      bgUserOn = !bgUserOn;
      paintToggle();
      if (!bgUserOn) { try { v.pause(); } catch (e) {} v.style.display = "none"; }
      else { v.style.display = ""; tryPlay(); }
    });
    paintToggle();

    /* PERF: pause/resume during Analyze is driven by setLoader() below
       (single source of truth), not by a separate event channel. */
    videoCtl.v = v;
    videoCtl.tryPlay = tryPlay;
  }

  /* Shared video pause/resume used by the loader (Analyze running). */
  var videoCtl = { v: null, tryPlay: null };
  function pauseVideoForWork() {
    analyzing = true;
    try { if (videoCtl.v) videoCtl.v.pause(); } catch (e) {}
  }
  function resumeVideoAfterWork() {
    analyzing = false;
    try { if (videoCtl.tryPlay) videoCtl.tryPlay(); } catch (e) {}
  }

  /* -------------------- 3. one-time section reveals -------------------- */
  /* PERF: a single IntersectionObserver, once per section, then unobserve.
     No ScrollTrigger, no scrub, no per-frame work. Map/chart containers
     (.map-wrap, .chart, canvas) are never animated — only the section
     cards fade/translate via the .is-revealed class. */
  function initReveals() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    if (!motionOK || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("is-revealed"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.add("is-revealed");
        io.unobserve(en.target);
      });
    }, { root: null, rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    els.forEach(function (el) { io.observe(el); });
  }

  /* -------------------- 4. single scroll/resize handler -------------------- */
  /* PERF: exactly one scroll listener + one resize listener, both passive
     and rAF-throttled. Progress uses transform: scaleX (compositor-only);
     no layout reads/writes per frame besides cheap cached rect math. */
  function setupScrollChrome() {
    var bar = document.getElementById("scrollProgress");
    var btt = document.getElementById("backToTop");
    var ring = btt ? btt.querySelector(".btt-progress") : null;
    var CIRC = 119.4;

    var update = rafThrottle(function () {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      var docH = document.documentElement.scrollHeight - window.innerHeight;
      var pct = docH > 0 ? Math.min(1, Math.max(0, y / docH)) : 0;

      if (bar) bar.style.transform = "scaleX(" + pct.toFixed(4) + ")";
      if (navEl) navEl.classList.toggle("is-shrunk", y > 80);

      if (btt) {
        var show = y > 600;
        btt.hidden = false;
        btt.classList.toggle("is-visible", show);
        if (ring) ring.style.strokeDashoffset = String(CIRC * (1 - pct));
      }
    });
    on(window, "scroll", update, { passive: true });
    on(window, "resize", update, { passive: true });
    update();

    if (btt) on(btt, "click", function () {
      (document.getElementById("hero") || document.body)
        .scrollIntoView({ behavior: motionOK ? "smooth" : "auto", block: "start" });
    });

    /* PERF: active nav link via IntersectionObserver (no scroll math). */
    try {
      var links = Array.prototype.slice.call(document.querySelectorAll(".nav-link"));
      var byId = {};
      links.forEach(function (l) {
        var sel = l.getAttribute("data-scroll") || l.getAttribute("href");
        if (sel && sel.charAt(0) === "#") {
          var t = document.querySelector(sel);
          if (t) byId[sel.slice(1)] = l;
        }
      });
      var seen = Object.keys(byId).map(function (id) { return document.getElementById(id); })
        .filter(function (el) { return el; });
      if ("IntersectionObserver" in window && seen.length) {
        var navIO = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            var link = byId[en.target.id];
            if (!link) return;
            links.forEach(function (l) { l.classList.toggle("is-active", l === link); });
          });
        }, { rootMargin: "-30% 0px -60% 0px", threshold: 0 });
        seen.forEach(function (el) { navIO.observe(el); });
      }
    } catch (e) {}
  }

  /* -------------------- 5. tab-aware anchor links -------------------- */
  function scrollToEl(el) {
    if (!el) return;
    /* PERF: native smooth scroll (html { scroll-behavior: smooth }); the
       scroll-margin-top rules offset the fixed navbar. No Lenis. */
    el.scrollIntoView({ behavior: motionOK ? "smooth" : "auto", block: "start" });
  }
  function wireAnchor(link) {
    on(link, "click", function (e) {
      var tab = link.getAttribute("data-tab");
      var sel = link.getAttribute("data-scroll") || link.getAttribute("href");
      var results = document.getElementById("results");
      var target = sel && sel.charAt(0) === "#" ? document.querySelector(sel) : null;

      /* tab-backed links: activate the tab first (only when results exist) */
      if (tab) {
        e.preventDefault();
        if (results && !results.hidden) {
          var tg = document.getElementById("resultTabs");
          if (tg && typeof tg.show === "function") tg.show(tab);
        } else {
          target = document.getElementById("controlsCard");
        }
        setTimeout(function () { scrollToEl(target); }, 320);
        return;
      }
      /* plain anchors use the browser default (no preventDefault). */
    });
  }
  function setupAnchors() {
    document.querySelectorAll("[data-scroll], .nav-link[data-tab]").forEach(wireAnchor);
  }

  /* -------------------- 6. loader + skeleton + toasts -------------------- */
  function makeToast(msg) {
    var host = document.getElementById("toastHost");
    if (!host) return;
    var t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.innerHTML = '<span class="toast-dot"></span><span></span>';
    t.lastChild.textContent = msg;
    host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("is-in"); });
    setTimeout(function () {
      t.classList.remove("is-in"); t.classList.add("is-out");
      setTimeout(function () { t.remove(); }, 400);
    }, 2800);
  }

  function setLoader(on) {
    var el = document.getElementById("loader");
    if (!el) return;
    if (on) {
      /* PERF: loader ON also parks the background video so the CPU/GPU is
         free for the fetch + analysis; resume when the loader clears. */
      pauseVideoForWork();
      el.hidden = false;
      requestAnimationFrame(function () { el.classList.add("is-on"); });
    } else {
      el.classList.remove("is-on");
      setTimeout(function () { el.hidden = true; }, 260);
      resumeVideoAfterWork();
    }
  }
  function setSkeletons(on) {
    /* PERF: skeleton shimmer only exists while a fetch is running, on the
       table/chart shells — never on live canvases mid-render. */
    document.querySelectorAll(".grid, .chart").forEach(function (el) {
      if (on) el.classList.add("skeleton");
      else el.classList.remove("skeleton");
    });
  }

  function setupStateHooks() {
    var statusBox = document.getElementById("statusBox");
    var statusText = document.getElementById("statusText");
    var results = document.getElementById("results");
    var errorBox = document.getElementById("errorBox");
    var wasLoading = false;
    var idleTimer = null;

    /* PERF: the app leaves its status box visible as a "Done" receipt, and
       tab-switch redraws ("Drawing track map…") also flash it — neither
       means a fetch is running. So the loader clears on the FIRST of:
       status box hidden, results shown, error shown, or 2s with no progress-
       text change (idle watchdog). It can never stick on and block input. */
    function loadingDone() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (!wasLoading) return;
      wasLoading = false;
      setLoader(false);
      setSkeletons(false);
    }
    function loadingActive() {
      if (!wasLoading) {
        wasLoading = true;
        setLoader(true);
        setSkeletons(true);
      }
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(loadingDone, 2000);
    }

    /* loading ↔ loader + skeletons + video pause, from the app's status box */
    if (statusBox) {
      new MutationObserver(function () {
        if (!statusBox.hidden) loadingActive();
        else loadingDone();
      }).observe(statusBox, { attributes: true, attributeFilter: ["hidden"] });
    }
    if (statusText) {
      new MutationObserver(function () {
        if (statusBox && !statusBox.hidden) loadingActive();
      }).observe(statusText, { childList: true, characterData: true, subtree: true });
    }

    /* analysis complete → toast + loader off (count-up animation removed) */
    var wasHidden = results ? results.hidden : true;
    if (results) {
      new MutationObserver(function () {
        if (!(results.hidden === false && wasHidden === true)) { wasHidden = results.hidden; return; }
        wasHidden = results.hidden;
        loadingDone();
        setTimeout(function () { makeToast("Analysis complete"); }, 500);
      }).observe(results, { attributes: true, attributeFilter: ["hidden"] });
    }

    /* errors → toast + loader off (never replaces the app's inline message) */
    if (errorBox) {
      new MutationObserver(function () {
        if (errorBox.hidden) return;
        loadingDone();
        var txt = (errorBox.textContent || "").trim();
        if (txt) makeToast(txt.slice(0, 90));
      }).observe(errorBox, { attributes: true, attributeFilter: ["hidden"] });
    }

    /* hook the EXISTING buttons with extra listeners (logic untouched) */
    on(document.getElementById("copyLinkBtn"), "click", function () { makeToast("Share link copied"); });
    ["cornerCsvBtn", "driverCsvBtn", "teamCsvBtn", "sectorCsvBtn", "paceCsvBtn"].forEach(function (id) {
      on(document.getElementById(id), "click", function () { makeToast("CSV downloaded"); });
    });
  }

  /* -------------------- 7. ripple + chip glow (static, rare) -------------------- */
  /* PERF: one-shot ripple span per click only — no loops, no listeners held. */
  function addRipple(e) {
    var el = e.currentTarget, rect = el.getBoundingClientRect();
    var size = Math.max(rect.width, rect.height);
    var s = document.createElement("span");
    s.className = "ripple";
    s.style.width = s.style.height = size + "px";
    s.style.left = (e.clientX - rect.left - size / 2) + "px";
    s.style.top = (e.clientY - rect.top - size / 2) + "px";
    el.appendChild(s);
    setTimeout(function () { s.remove(); }, 650);
  }
  function setupRipple() {
    document.querySelectorAll(".hero-cta, .btn-race").forEach(function (el) { on(el, "click", addRipple); });
  }

  /* soft glow on team-colour swatches wherever drivers/teams are listed
     (static inline style, applied once per render — no animation) */
  function glowSwatches(root) {
    (root || document).querySelectorAll(".swatch").forEach(function (s) {
      if (s.dataset.glow === "1") return;
      s.dataset.glow = "1";
      try {
        var c = getComputedStyle(s).backgroundColor;
        if (c && c !== "transparent" && c !== "rgba(0, 0, 0, 0)") s.style.boxShadow = "0 0 9px 0 " + c;
      } catch (e) {}
    });
  }

  function setupTabIntegration() {
    var tg = document.getElementById("resultTabs");
    if (!tg) return;
    /* PERF: on tab switch just refresh the static chip glow. No
       ScrollTrigger.refresh, no reveal re-init (the IO handles it). */
    on(tg, "sl-tab-show", function () { glowSwatches(tg); });
    var results = document.getElementById("results");
    if (results) {
      new MutationObserver(function () {
        if (!results.hidden) glowSwatches(results);
      }).observe(results, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  /* -------------------- boot -------------------- */
  function boot() {
    setupVideo();
    setupScrollChrome();
    setupAnchors();
    setupStateHooks();
    setupRipple();

    initReveals();
    setupTabIntegration();
    glowSwatches(document);

    /* tables/charts often overflow on phones — keep them scrollable in place */
    document.querySelectorAll(".grid, .chart").forEach(function (el) {
      el.style.overflowX = "auto";
    });

    window.__f1MotionReady = true;
  }

  if (document.readyState === "loading") on(document, "DOMContentLoaded", boot);
  else boot();
})();
