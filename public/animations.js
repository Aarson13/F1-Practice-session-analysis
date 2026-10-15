/* =====================================================================
 * F1 Session Analyzer — CINEMATIC MOTION LAYER  (animations.js)
 * ---------------------------------------------------------------------
 * UI-ONLY. This file never touches data fetching, analysis, chart/map
 * rendering, element IDs, JS-used class names, CSV export or share links.
 * It only adds presentation: scroll reveals, the hero, the video backdrop,
 * navbar/scroll chrome, toasts, the loader, the custom cursor and small
 * hooks onto the EXISTING buttons (added as extra listeners — the app's
 * own handlers are left untouched).
 *
 * Every library is optional and feature-detected: if a CDN is blocked the
 * page still renders and behaves, just without that one effect.
 *
 * Blocks:
 *   1. environment + helpers
 *   2. background video
 *   3. Lenis + GSAP/ScrollTrigger boot
 *   4. hero (Splitting / Typed / tsParticles / parallax)
 *   5. scroll reveals + heading underline + count-up KPIs
 *   6. chrome (navbar · progress · back-to-top · dividers)
 *   7. smooth-scroll anchors (nav + hero CTA, tab-aware)
 *   8. loaders + skeletons + toasts (hooked to existing app state)
 *   9. custom cursor + ripple + team-colour chip glow
 * ===================================================================== */
(function () {
  "use strict";

  /* -------------------- 1. environment + helpers -------------------- */
  var reduced = false;
  try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
  var saveData = !!connection.saveData;
  var finePointer = false;
  try { finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) {}
  var hasGsap = !!(window.gsap && window.ScrollTrigger);
  var navEl = document.getElementById("navbar");
  var navH = 64;

  function raf(fn) {
    var queued = false, lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn.apply(null, lastArgs); });
    };
  }
  function on(el, ev, fn, opt) { if (el) el.addEventListener(ev, fn, opt); }
  function prefersNoMotion() { return reduced; }

  /* Motion is allowed only when the user hasn't asked to reduce it. */
  var motionOK = !reduced;

  /* -------------------- 2. background video -------------------- */
  function setupVideo() {
    var v = document.getElementById("bgVideo");
    var minWidth = 640;
    var skip = saveData || window.innerWidth < minWidth || reduced;

    if (skip) {
      /* show the poster image only, then drop the <video> (spec) */
      document.body.style.backgroundImage = "url('assets/hero-poster.jpg')";
      document.body.style.backgroundSize = "cover";
      document.body.style.backgroundPosition = "center";
      document.body.style.backgroundAttachment = "fixed";
      if (v) v.remove();
      return;
    }
    if (!v) return;
    try { v.muted = true; } catch (e) {}
    var p = v.play();
    if (p && p.catch) p.catch(function () { /* autoplay blocked → poster stays */ });
    on(document, "visibilitychange", function () {
      if (document.hidden) { try { v.pause(); } catch (e) {} }
      else { var pp = v.play(); if (pp && pp.catch) pp.catch(function () {}); }
    });
  }

  /* -------------------- 3. Lenis + ScrollTrigger boot -------------------- */
  var lenis = null;
  function setupSmoothScroll() {
    if (!motionOK || typeof window.Lenis === "undefined" || !hasGsap) return;
    try {
      lenis = new window.Lenis({
        duration: 1.1,
        smoothWheel: true,
        wheelMultiplier: 1,
        touchMultiplier: 1.6
      });
      lenis.on("scroll", window.ScrollTrigger.update);
      window.gsap.ticker.add(function (t) { lenis.raf(t * 1000); });
      window.gsap.ticker.lagSmoothing(0);
      document.documentElement.classList.add("lenis-active");
    } catch (e) { lenis = null; }
  }
  function scrollToEl(el) {
    if (!el) return;
    if (lenis) { lenis.scrollTo(el, { offset: -navH - 12, duration: 1.1 }); return; }
    el.scrollIntoView({ behavior: motionOK ? "smooth" : "auto", block: "start" });
  }

  /* -------------------- 4. hero -------------------- */
  function setupHero() {
    var title = document.getElementById("heroTitle");
    var chars = [];

    /* letter-by-letter reveal (Splitting.js + GSAP) */
    if (title) {
      if (motionOK && typeof window.Splitting !== "undefined" && hasGsap) {
        try {
          var res = window.Splitting({ target: title, by: "chars" });
          chars = (res && res[0] && res[0].chars) || [];
        } catch (e) {}
      }
      if (chars.length && hasGsap) {
        window.gsap.set(title, { opacity: 1 });
        window.gsap.from(chars, {
          opacity: 0, y: 34, rotateX: -60, duration: 0.7, ease: "power3.out",
          stagger: 0.028, delay: 0.15, transformOrigin: "50% 100%"
        });
      }
    }

    /* rotating subtitle (Typed.js) — static single line if unavailable/reduced */
    var sub = document.getElementById("heroSubtitle");
    if (sub) {
      var lines = ["Turn-by-turn corner analysis", "Live OpenF1 data", "Every session. Every corner."];
      if (motionOK && typeof window.Typed !== "undefined") {
        try {
          new window.Typed("#heroSubtitle", {
            strings: lines, typeSpeed: 42, backSpeed: 24, backDelay: 1600,
            loop: true, smartBackspace: true, showCursor: true
          });
        } catch (e) { sub.textContent = lines[0]; }
      } else {
        sub.textContent = lines[0];
      }
    }

    /* embers / sparks in the hero only; disabled below 768px (spec) */
    var host = document.getElementById("heroParticles");
    if (host && motionOK && window.innerWidth >= 768 && window.tsParticles) {
      try {
        window.tsParticles.load("heroParticles", {
          fullScreen: { enable: false },
          detectRetina: true,
          fpsLimit: 60,
          particles: {
            number: { value: 30 },
            color: { value: ["#dc0000", "#ff2a2a", "#ff7a45"] },
            opacity: { value: 0.4 },
            size: { value: { min: 1, max: 3 } },
            move: { enable: true, speed: 0.7, direction: "top", outModes: { default: "out" } },
            life: { duration: { sync: false, value: 8 }, count: 1 }
          },
          interactivity: { events: { onHover: { enable: false }, onClick: { enable: false }, resize: true } }
        });
      } catch (e) {}
    }
  }

  function setupParallax() {
    if (!motionOK || !hasGsap) return;
    var overlay = document.querySelector(".bg-overlay");
    if (!overlay) return;
    /* overlay drifts at 0.3× scroll speed (hero parallax) */
    window.gsap.to(overlay, {
      yPercent: 18, ease: "none",
      scrollTrigger: { trigger: document.documentElement, start: "top top", end: "bottom bottom", scrub: true }
    });
  }

  /* -------------------- 5. reveals + count-up -------------------- */
  function revealInstant(el) {
    el.classList.add("is-revealed");
    if (hasGsap) window.gsap.set(el, { opacity: 1, y: 0 });
    else { el.style.opacity = "1"; el.style.transform = "none"; }
  }
  function initReveal(el) {
    if (el.dataset.revealInit === "1") return;
    el.dataset.revealInit = "1";
    if (!motionOK || !hasGsap) { revealInstant(el); return; }
    try {
      var kids = Array.prototype.filter.call(el.children, function (c) {
        return !c.classList.contains("card-head") || true;
      });
      window.gsap.to(el, {
        opacity: 1, y: 0, duration: 0.7, ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 88%", once: true },
        onStart: function () { el.classList.add("is-revealed"); }
      });
      if (kids.length) {
        window.gsap.from(kids, {
          opacity: 0, y: 24, duration: 0.55, ease: "power2.out", stagger: 0.08,
          scrollTrigger: { trigger: el, start: "top 88%", once: true }
        });
      }
    } catch (e) { revealInstant(el); }
  }
  function initReveals(root) {
    (root || document).querySelectorAll(".reveal").forEach(initReveal);
  }

  var countUpDone = false;
  function animateCountsIn(root) {
    if (!root || countUpDone) return;
    countUpDone = true;
    if (!motionOK || !(window.countUp && window.countUp.CountUp)) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
    var nodes = [], n;
    while ((n = walker.nextNode())) {
      if (/\d/.test(n.nodeValue) && n.nodeValue.indexOf(":") === -1 && n.nodeValue.length < 40) nodes.push(n);
    }
    nodes.forEach(function (node) {
      var text = node.nodeValue;
      var m = text.match(/-?\d[\d,]*(?:\.\d+)?/);
      if (!m) return;
      var token = m[0];
      var numStr = token.replace(/,/g, "");
      var num = parseFloat(numStr);
      if (!isFinite(num)) return;
      var decimals = (numStr.split(".")[1] || "").length;
      var prefix = text.slice(0, m.index), suffix = text.slice(m.index + token.length);
      var span = document.createElement("span");
      span.textContent = token;
      var after = document.createTextNode(suffix);
      node.nodeValue = prefix;
      node.parentNode.insertBefore(span, node.nextSibling);
      node.parentNode.insertBefore(after, span.nextSibling);
      try {
        var c = new window.countUp.CountUp(span, num, {
          duration: 1.6, decimalPlaces: decimals, separator: ",", useEasing: true
        });
        if (!c.error) c.start(); else span.textContent = token;
      } catch (e) { span.textContent = token; }
    });
  }

  /* -------------------- 6. chrome -------------------- */
  function setupScrollChrome() {
    var bar = document.getElementById("scrollProgress");
    var btt = document.getElementById("backToTop");
    var ring = btt ? btt.querySelector(".btt-progress") : null;
    var CIRC = 119.4;
    var navLinks = Array.prototype.slice.call(document.querySelectorAll(".nav-link"));
    var scrollTargets = navLinks.map(function (l) {
      var id = l.getAttribute("data-scroll") || l.getAttribute("href");
      return { link: l, el: id ? document.querySelector(id) : null };
    }).filter(function (t) { return t.el; });

    var update = raf(function () {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      var docH = document.documentElement.scrollHeight - window.innerHeight;
      var pct = docH > 0 ? (y / docH) : 0;

      if (bar) bar.style.width = (pct * 100).toFixed(2) + "%";
      if (navEl) navEl.classList.toggle("is-shrunk", y > 80);

      if (btt) {
        var show = y > 600;
        btt.hidden = false;
        btt.classList.toggle("is-visible", show);
        if (ring) ring.style.strokeDashoffset = String(CIRC * (1 - pct));
      }

      /* active nav link = last target whose top has passed under the navbar */
      var active = null;
      for (var i = 0; i < scrollTargets.length; i++) {
        var el = scrollTargets[i].el;
        if (!el || el.offsetParent === null) continue;
        var r = el.getBoundingClientRect();
        if (r.top <= navH + 90) active = scrollTargets[i].link;
      }
      navLinks.forEach(function (l) { l.classList.toggle("is-active", l === active); });
    });
    on(window, "scroll", update, { passive: true });
    on(window, "resize", update, { passive: true });
    update();

    /* back-to-top progress ring is part of .is-visible; scroll on click */
    if (btt) on(btt, "click", function () { scrollToEl(document.getElementById("hero") || document.body); });
  }

  /* -------------------- 7. smooth-scroll anchors -------------------- */
  function wireAnchor(link) {
    on(link, "click", function (e) {
      var tab = link.getAttribute("data-tab");
      var sel = link.getAttribute("data-scroll") || link.getAttribute("href");
      var results = document.getElementById("results");
      var target = sel && sel.charAt(0) === "#" ? document.querySelector(sel) : null;

      /* tab-backed links: activate the tab first (only when results exist) */
      if (tab) {
        if (results && !results.hidden) {
          var tg = document.getElementById("resultTabs");
          if (tg && typeof tg.show === "function") {
            e.preventDefault();
            tg.show(tab);
            setTimeout(function () { scrollToEl(target); }, 320);
            return;
          }
        } else {
          /* no analysis yet — send them to the controls instead of a dead tab */
          e.preventDefault();
          scrollToEl(document.getElementById("controlsCard"));
          return;
        }
      }
      if (target) { e.preventDefault(); scrollToEl(target); }
    });
  }
  function setupAnchors() {
    document.querySelectorAll("[data-scroll], .nav-link[data-tab]").forEach(wireAnchor);
  }

  /* -------------------- 8. loaders + skeletons + toasts -------------------- */
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
      el.hidden = false;
      requestAnimationFrame(function () { el.classList.add("is-on"); });
    } else {
      el.classList.remove("is-on");
      setTimeout(function () { el.hidden = true; }, 260);
    }
  }
  function setSkeletons(on) {
    document.querySelectorAll(".grid, .chart, .map-wrap").forEach(function (el) {
      if (on) { if (!el.dataset.hadContent) el.classList.add("skeleton"); }
      else el.classList.remove("skeleton");
    });
  }

  function setupStateHooks() {
    var statusBox = document.getElementById("statusBox");
    var results = document.getElementById("results");
    var summaryChips = document.getElementById("summaryChips");
    var errorBox = document.getElementById("errorBox");
    var wasLoading = false;

    /* loading ↔ loader + skeletons, driven by the app's own status box */
    if (statusBox) {
      new MutationObserver(function () {
        var loading = !statusBox.hidden;
        if (loading === wasLoading) return;
        wasLoading = loading;
        setLoader(loading);
        setSkeletons(loading);
      }).observe(statusBox, { attributes: true, attributeFilter: ["hidden"] });
    }

    /* analysis complete ↔ toast + KPI count-up */
    var wasHidden = results ? results.hidden : true;
    if (results) {
      new MutationObserver(function () {
        if (!(results.hidden === false && wasHidden === true)) { wasHidden = results.hidden; return; }
        wasHidden = results.hidden;
        setTimeout(function () {
          makeToast("Analysis complete");
          try { if (summaryChips) animateCountsIn(summaryChips); } catch (e) {}
        }, 500);
      }).observe(results, { attributes: true, attributeFilter: ["hidden"] });
    }

    /* errors → toast (never replaces the app's own inline message) */
    if (errorBox) {
      new MutationObserver(function () {
        if (errorBox.hidden) return;
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

  /* -------------------- 9. cursor + ripple + chip glow -------------------- */
  function setupCursor() {
    var dot = document.getElementById("cursorDot");
    var ring = document.getElementById("cursorRing");
    if (!dot || !ring || !finePointer || !motionOK) return;
    document.documentElement.classList.add("cursor-on");

    var mx = window.innerWidth / 2, my = window.innerHeight / 2, rx = mx, ry = my;
    var move = raf(function () { dot.style.transform = "translate(" + mx + "px," + my + "px)"; });
    on(window, "mousemove", function (e) { mx = e.clientX; my = e.clientY; move(); }, { passive: true });

    (function loop() {
      rx += (mx - rx) * 0.18; ry += (my - ry) * 0.18;
      ring.style.transform = "translate(" + rx + "px," + ry + "px)";
      requestAnimationFrame(loop);
    })();

    on(document, "mouseover", function (e) {
      var hot = e.target.closest && e.target.closest("a, button, sl-button, sl-select, sl-option, input, [role='tab']");
      ring.classList.toggle("is-hot", !!hot);
    });
    on(document, "mouseleave", function () { dot.style.opacity = "0"; ring.style.opacity = "0"; });
    on(document, "mouseenter", function () { dot.style.opacity = ""; ring.style.opacity = ""; });
  }

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

  /* soft glow on team-colour swatches wherever drivers/teams are listed */
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

  /* -------------------- tab + resize integration -------------------- */
  function setupTabIntegration() {
    var tg = document.getElementById("resultTabs");
    if (!tg) return;
    on(tg, "sl-tab-show", function () {
      var panels = tg.querySelectorAll("sl-tab-panel[active], sl-tab-panel");
      panels.forEach(function (p) {
        if (p.hasAttribute("active") || p.getAttribute("active") !== null) initReveals(p);
      });
      initReveals(tg);
      if (window.ScrollTrigger) window.ScrollTrigger.refresh();
      glowSwatches(tg);
    });
    /* results appearing (analysis done) → wire that panel's reveals */
    var results = document.getElementById("results");
    if (results) {
      new MutationObserver(function () {
        if (!results.hidden) {
          initReveals(results);
          glowSwatches(results);
          if (window.ScrollTrigger) window.ScrollTrigger.refresh();
        }
      }).observe(results, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  /* -------------------- boot -------------------- */
  function boot() {
    setupVideo();
    setupSmoothScroll();
    setupScrollChrome();
    setupAnchors();
    setupStateHooks();
    setupRipple();

    if (hasGsap) {
      try { window.gsap.registerPlugin(window.ScrollTrigger); } catch (e) {}
    }

    if (motionOK) {
      setupHero();
      setupParallax();
    } else {
      /* reduced motion: show the static hero copy, no motion at all */
      var sub = document.getElementById("heroSubtitle");
      if (sub) sub.textContent = "Turn-by-turn corner analysis";
    }

    initReveals(document);
    setupTabIntegration();
    setupCursor();
    glowSwatches(document);

    /* tables/charts often overflow on phones — keep them scrollable in place */
    document.querySelectorAll(".grid, .chart").forEach(function (el) {
      el.style.overflowX = "auto";
    });

    if (window.ScrollTrigger) setTimeout(function () { window.ScrollTrigger.refresh(); }, 400);
    if (window.ScrollTrigger) on(window, "load", function () { window.ScrollTrigger.refresh(); });

    window.__f1MotionReady = true;
  }

  if (document.readyState === "loading") on(document, "DOMContentLoaded", boot);
  else boot();
})();
