/* =====================================================
   F1 SESSION ANALYZER — COMPONENT LAYER

   The 25 design-system components this site carries, as an
   idempotent upgrade over the page app.js/animations.js
   already render. Loaded last, so it enhances instead of
   replacing: it never fetches, never computes an analysis
   and never owns a template the app depends on.

   Strict CSP: no inline script, no style attribute. Runtime
   geometry (nav blob, segment pill, island ring, swipe
   offset) is written through CSSOM / custom properties,
   which style-src 'self' does not govern.

   Ten live on the surfaces they belong to — the nav, the
   session controls, the map card, the result summary, the
   Guide panel and the footer. The rest are hosted on the
   unsanctioned-but-unlinked components surface at
   /?components=1 (the same pattern the Portfolio batch
   used): each one is wired to the `f1-settings:v1` store
   the page reads or to the live analysis in memory, never
   to a demo value.
   ===================================================== */
(function () {
  'use strict';

  var KEY = 'f1-settings:v1';
  var DEFAULTS = {
    limit: '10',
    tab: 'overview',
    tooltipDelay: 100,
    replaySpeed: '2',
    filter: 'adopted',
    reduceMotion: false,
    contrast: false
  };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function load() {
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      for (var j in raw) if (Object.prototype.hasOwnProperty.call(DEFAULTS, j)) out[j] = raw[j];
    } catch (e) { /* private mode / no storage */ }
    return out;
  }

  var store = load();

  function save(patch) {
    for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) store[k] = patch[k];
    try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
    apply();
  }

  function mark(node, id) {
    if (!node) return node;
    var existing = (node.getAttribute('data-component') || '').split(/\s+/).filter(Boolean);
    if (existing.indexOf(id) === -1) existing.push(id);
    node.setAttribute('data-component', existing.join(' '));
    node.setAttribute('data-ct-done', '1');
    return node;
  }

  function fresh(selector, scope) {
    return $$(selector, scope).filter(function (node) { return !node.hasAttribute('data-ct-done'); });
  }

  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function text(node) { return node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  function say(node, message) {
    if (!node) return;
    node.textContent = message;
    window.clearTimeout(node._f1Timer);
    node._f1Timer = window.setTimeout(function () { node.textContent = ''; }, 5000);
  }

  function reduced() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches || !!store.reduceMotion; } catch (e) { return !!store.reduceMotion; }
  }

  function afterPaint(fn) {
    if (typeof requestAnimationFrame !== 'function') { window.setTimeout(fn, 0); return; }
    requestAnimationFrame(function () { requestAnimationFrame(fn); });
  }

  function copy(value, done) {
    var fallback = function () {
      try {
        var field = document.createElement('textarea');
        field.value = value;
        field.setAttribute('readonly', 'readonly');
        field.className = 'f1-copy-field';
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        document.body.removeChild(field);
        if (done) done(true);
      } catch (e) { if (done) done(false); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () { if (done) done(true); }, fallback);
    } else fallback();
  }

  /* The analysis in memory, read defensively: this file must work on a cold
     page as well as one that just rendered results. `state` is a top-level
     `const` in app.js, so it is an identifier here, not a window property. */
  function analysis() {
    try { return typeof state !== 'undefined' && state && state.analysis ? state.analysis : null; } catch (e) { return null; }
  }
  function sessions() {
    try { return typeof state !== 'undefined' && state && state.sessions ? state.sessions : []; } catch (e) { return []; }
  }
  function tabGroup() { return document.getElementById('resultTabs'); }

  /* ── 1. Gooey nav ─────────────────────────────────────────────── */
  function installNav() {
    var nav = $('.nav-links');
    if (!nav) return;
    nav.classList.add('f1-gooey');
    mark(nav, 'gooey-nav');
    var blob = el('span', 'f1-gooey-blob');
    blob.setAttribute('aria-hidden', 'true');
    nav.appendChild(blob);

    function place() {
      var active = nav.querySelector('.nav-link.is-active') || nav.querySelector('.nav-link');
      if (!active || !active.offsetWidth) return;
      nav.style.setProperty('--f1-blob-x', active.offsetLeft + 'px');
      nav.style.setProperty('--f1-blob-w', active.offsetWidth + 'px');
    }
    place();
    var later = function () { afterPaint(place); window.setTimeout(place, 0); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, { passive: true });
    nav.addEventListener('click', later);
    window.addEventListener('hashchange', later);
  }

  /* ── 2. Warm tooltips ─────────────────────────────────────────── */
  var tipSeq = 0;
  function installTooltips() {
    // Plain elements only: appending the tooltip inside a Shoelace <sl-button>
    // would put it in the button's default slot and change its label. The nav
    // links and any explicitly tagged control are the triggers.
    var triggers = $$('.nav-link').concat($$('[data-tip]'));
    var open = null;
    var timer = null;
    function close() {
      window.clearTimeout(timer);
      if (!open) return;
      open.tip.classList.remove('is-open');
      open.tip.setAttribute('aria-hidden', 'true');
      open = null;
    }
    triggers.forEach(function (trigger) {
      if (trigger.hasAttribute('data-ct-done')) return;
      var label = trigger.getAttribute('data-tip') || trigger.getAttribute('title') || text(trigger);
      if (!label) return;
      var tip = el('span', 'f1-tip', label);
      // One counter for the whole document: the surface is built after the
      // first pass, and restarting the index at 0 produced a duplicate id
      // whose aria-describedby pointed at the navigation's tooltip instead.
      tip.id = 'f1-tip-' + (++tipSeq);
      tip.setAttribute('role', 'tooltip');
      tip.setAttribute('aria-hidden', 'true');
      trigger.classList.add('f1-tip-trigger');
      trigger.setAttribute('aria-describedby', tip.id);
      trigger.appendChild(tip);
      mark(trigger, 'warm-tooltip');
      function show() {
        window.clearTimeout(timer);
        timer = window.setTimeout(function () {
          close();
          tip.classList.add('is-open');
          tip.setAttribute('aria-hidden', 'false');
          open = { trigger: trigger, tip: tip };
        }, Number(store.tooltipDelay) || 0);
      }
      trigger.addEventListener('mouseenter', show);
      trigger.addEventListener('focus', show);
      trigger.addEventListener('mouseleave', close);
      trigger.addEventListener('blur', close);
      trigger.addEventListener('keydown', function (event) { if (event.key === 'Escape') close(); });
    });
  }

  /* ── 3. Animated counters (summary figures) ───────────────────── */
  function installCounters() {
    var meta = document.getElementById('sessionMeta');
    if (!meta) return;
    function decorate() {
      fresh('div', meta).forEach(function (row) {
        var value = row.lastChild;
        if (!value || value.nodeType !== 3 || !/\d/.test(value.nodeValue || '')) return;
        var raw = value.nodeValue;
        row.setAttribute('data-ct-done', '1');
        var wrap = el('span', 'f1-counter', raw);
        wrap.setAttribute('data-component', 'animated-counter');
        row.replaceChild(wrap, value);
        if (!reduced()) {
          wrap.classList.remove('f1-tick');
          void wrap.offsetWidth;
          wrap.classList.add('f1-tick');
        }
      });
    }
    decorate();
    if (window.MutationObserver) new MutationObserver(decorate).observe(meta, { childList: true, subtree: true });
  }

  /* ── 4. Stepper (drivers to analyze) ──────────────────────────── */
  function installStepper() {
    var select = document.getElementById('driverLimitSelect');
    if (!select || select.parentNode.querySelector('.f1-stepper')) return;
    var values = $$('sl-option', select).map(function (option) { return option.getAttribute('value'); }).filter(Boolean);
    if (values.length < 2) return;
    var wrap = el('span', 'f1-stepper');
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', 'Drivers to analyze');
    var readout = el('span', 'f1-stepper-val');
    function sync() {
      var index = values.indexOf(String(select.value));
      readout.textContent = index < 0 ? '—' : text($$('sl-option', select)[index]);
    }
    function step(delta) {
      var index = values.indexOf(String(select.value));
      if (index < 0) index = 0;
      var next = Math.max(0, Math.min(values.length - 1, index + delta));
      if (next === index) return;
      select.value = values[next];
      try { select.dispatchEvent(new CustomEvent('sl-change')); } catch (e) { /* ignore */ }
      sync();
    }
    [['−', -1, 'Fewer drivers'], ['+', 1, 'More drivers']].forEach(function (spec) {
      var button = el('button', 'f1-stepper-btn touch-target', spec[0]);
      button.type = 'button';
      button.setAttribute('aria-label', spec[2]);
      button.addEventListener('click', function () { step(spec[1]); });
      wrap.appendChild(button);
      if (spec[1] === -1) wrap.appendChild(readout);
    });
    select.parentNode.insertBefore(wrap, select.nextSibling);
    select.classList.add('f1-stepper-source');
    sync();
    if (window.MutationObserver) new MutationObserver(sync).observe(select, { attributes: true, attributeFilter: ['value'] });
    mark(wrap, 'stepper');
  }

  /* ── 5. Rubber segment (replay speed) ─────────────────────────── */
  function installSegment() {
    var select = document.getElementById('replaySpeed');
    if (!select || select.parentNode.querySelector('.f1-segment')) return;
    var options = $$('sl-option', select);
    if (options.length < 2) return;
    var wrap = el('div', 'f1-segment');
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', 'Replay speed');
    var pill = el('span', 'f1-segment-pill');
    pill.setAttribute('aria-hidden', 'true');
    var chips = [];
    function sync() {
      chips.forEach(function (chip) {
        var on = chip.getAttribute('data-value') === String(select.value);
        chip.setAttribute('aria-checked', String(on));
        chip.classList.toggle('f1-segment-on', on);
        if (on) place(chip);
      });
    }
    function place(chip) {
      if (!chip || !chip.offsetWidth) return;
      pill.style.width = chip.offsetWidth + 'px';
      pill.style.height = chip.offsetHeight + 'px';
      pill.style.transform = 'translateX(' + chip.offsetLeft + 'px)';
    }
    options.forEach(function (option) {
      var chip = el('button', 'f1-segment-opt touch-target', text(option));
      chip.type = 'button';
      chip.setAttribute('data-value', option.getAttribute('value'));
      chip.setAttribute('role', 'radio');
      chip.addEventListener('click', function () {
        select.value = chip.getAttribute('data-value');
        try { select.dispatchEvent(new CustomEvent('sl-change')); } catch (e) { /* ignore */ }
        sync();
      });
      chips.push(chip);
      wrap.appendChild(chip);
    });
    wrap.appendChild(pill);
    select.parentNode.insertBefore(wrap, select.nextSibling);
    select.classList.add('f1-segment-source');
    mark(wrap, 'rubber-segment');
    sync();
    window.addEventListener('resize', sync);
  }

  /* ── 6. Squish switch (component motion preference) ───────────── */
  function installSquish(host) {
    if (!host || host.querySelector('[data-component~="squish-switch"]')) return;
    var wrap = el('label', 'f1-switch');
    mark(wrap, 'squish-switch');
    var box = el('input', 'f1-switch-box');
    box.type = 'checkbox';
    box.checked = !!store.reduceMotion;
    var track = el('span', 'f1-switch-track');
    var label = el('span', 'f1-switch-label', 'Reduce component motion');
    wrap.appendChild(box);
    wrap.appendChild(track);
    wrap.appendChild(label);
    box.addEventListener('change', function () {
      save({ reduceMotion: box.checked });
      wrap.classList.remove('f1-squish');
      void wrap.offsetWidth;
      wrap.classList.add('f1-squish');
    });
    host.appendChild(wrap);
  }

  /* ── 7. Switch mode (background on/off) ───────────────────────── */
  function installSwitchMode() {
    var button = document.getElementById('bgToggle');
    if (!button || button.hasAttribute('data-ct-done')) return;
    mark(button, 'switch-mode');
    button.setAttribute('role', 'switch');
    function sync() {
      // animations.js owns the toggle; aria-pressed is its state, and a
      // role="switch" exposes aria-checked instead — the two disagreeing is
      // what axe flags, so the pressed value is mirrored, not invented.
      var on = button.getAttribute('aria-pressed') !== 'false';
      button.setAttribute('aria-checked', String(on));
      button.removeAttribute('aria-pressed');
      button.classList.toggle('f1-switch-on', on);
    }
    sync();
    button.addEventListener('click', function () { window.setTimeout(sync, 0); });
    if (window.MutationObserver) {
      new MutationObserver(sync).observe(button, { attributes: true, attributeFilter: ['aria-pressed', 'textContent'] });
    }
  }

  /* ── 8. Dynamic button (Analyze) ──────────────────────────────── */
  function installDynamicButton() {
    var button = document.getElementById('analyzeBtn');
    if (!button || button.hasAttribute('data-ct-done')) return;
    mark(button, 'dynamic-button');
    button.classList.add('f1-dyn');
    var original = text(button) || 'Analyze selected session';
    var label = el('span', 'f1-dyn-label', original);
    button.textContent = '';
    button.appendChild(label);
    function sync() {
      if (button.disabled && text(label).indexOf('Analyz') === -1) {
        label.textContent = 'Analyzing…';
        button.classList.add('f1-dyn-busy');
        return;
      }
      button.classList.remove('f1-dyn-busy');
      if (!button.disabled && text(label) !== original) label.textContent = original;
    }
    if (window.MutationObserver) {
      new MutationObserver(sync).observe(button, { attributes: true, attributeFilter: ['disabled'] });
    }
  }

  /* ── 9. Inline disclosure menu (map card actions) ─────────────── */
  function installRowMenu() {
    var card = $('.map-wrap') && $('.map-wrap').closest('.card');
    if (!card || card.querySelector('.f1-menu-wrap')) return;
    var heading = card.querySelector('h2');
    if (!heading) return;
    var wrap = el('div', 'f1-menu-wrap');
    var button = el('button', 'f1-menu-btn touch-target', '\u22ee');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', 'Track map actions');
    var menu = el('div', 'f1-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    function close(restore) {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (restore) button.focus();
    }
    [['Copy share link', function () { copy(window.location.href); }],
     ['Download corner CSV', function () { var b = document.getElementById('cornerCsvBtn'); if (b) b.click(); }],
     ['Open the Guide tab', function () { var g = tabGroup(); if (g && g.show) g.show('guide'); }]].forEach(function (spec) {
      var item = el('button', 'f1-menu-item', spec[0]);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', function () { close(true); spec[1](); });
      menu.appendChild(item);
    });
    button.addEventListener('click', function () {
      menu.hidden = !menu.hidden;
      button.setAttribute('aria-expanded', String(!menu.hidden));
      if (!menu.hidden) { var first = menu.querySelector('button'); if (first) first.focus(); }
    });
    menu.addEventListener('keydown', function (event) {
      var items = $$('button', menu);
      var index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); close(true); }
    });
    document.addEventListener('click', function (event) { if (!wrap.contains(event.target)) close(false); });
    wrap.appendChild(button);
    wrap.appendChild(menu);
    heading.appendChild(wrap);
    mark(wrap, 'inline-disclosure-menu');
  }

  /* ── 10. Scroll island (Guide panel) ──────────────────────────── */
  function installIsland() {
    var panel = document.querySelector('sl-tab-panel[name="guide"]');
    if (!panel) return;
    var island = el('div', 'f1-island');
    island.hidden = true;
    var ring = el('span', 'f1-island-ring');
    ring.setAttribute('aria-hidden', 'true');
    var list = el('nav', 'f1-island-list');
    list.setAttribute('aria-label', 'Guide sections');
    var topics = $$('h3, h4', panel).map(function (heading, i) {
      if (!heading.id) heading.id = 'guide-' + i;
      var link = el('button', 'f1-island-link touch-target', text(heading));
      link.type = 'button';
      link.addEventListener('click', function () { heading.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); });
      list.appendChild(link);
      return { heading: heading, link: link };
    });
    if (topics.length < 2) return;
    island.appendChild(ring);
    island.appendChild(list);
    document.body.appendChild(island);
    mark(island, 'scroll-island');

    function update() {
      var shown = panel.getAttribute('hidden') === null && panel.offsetParent !== null;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      ring.style.setProperty('--f1-ring', String(ratio));
      island.hidden = !shown;
      var current = null;
      topics.forEach(function (topic) {
        if (topic.heading.getBoundingClientRect().top <= 160) current = topic.link;
      });
      topics.forEach(function (topic) { topic.link.classList.toggle('f1-island-on', topic.link === current); });
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    var group = tabGroup();
    if (group) group.addEventListener('sl-tab-show', function () { window.setTimeout(update, 40); });
    update();
  }

  /* ── 11. Warm tooltips on the Guide anchor targets? (not needed) ── */

  /* ── 12. Feedback (footer form, real POST) ────────────────────── */
  function installFeedback() {
    var footer = $('.site-footer');
    if (!footer || footer.querySelector('[data-component~="feedback"]')) return;
    var box = el('section', 'f1-feedback');
    box.setAttribute('aria-labelledby', 'f1-feedback-title');
    var title = el('h2', 'f1-feedback-title', 'Was this analysis helpful?');
    var hint = el('p', 'f1-feedback-hint', 'Reports go to the shared feedback box for this collection. No F1 data is sent, and nothing is stored on this device.');
    var form = el('form', 'f1-feedback-form');
    form.setAttribute('novalidate', 'novalidate');
    var thumbs = el('div', 'f1-thumbs');
    thumbs.setAttribute('role', 'radiogroup');
    thumbs.setAttribute('aria-label', 'How did it go?');
    var choices = [['\uD83D\uDC4D', 'Helpful'], ['\uD83D\uDC4E', 'Not what I expected']];
    var chosen = '';
    choices.forEach(function (choice) {
      var button = el('button', 'f1-thumb touch-target', choice[0]);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', 'false');
      button.setAttribute('aria-label', choice[1]);
      button.addEventListener('click', function () {
        chosen = choice[1];
        $$('button', thumbs).forEach(function (other) { other.setAttribute('aria-checked', String(other === button)); });
      });
      thumbs.appendChild(button);
    });
    var message = el('textarea', 'f1-feedback-text');
    message.setAttribute('aria-label', 'What should be fixed or added?');
    message.setAttribute('placeholder', 'A wrong corner, a session that failed, something missing…');
    message.maxLength = 2000;
    var trap = el('input', 'f1-feedback-trap');
    trap.type = 'text';
    trap.name = 'website';
    trap.tabIndex = -1;
    trap.setAttribute('autocomplete', 'off');
    trap.setAttribute('aria-hidden', 'true');
    var send = el('button', 'f1-feedback-send touch-target', 'Send feedback');
    send.type = 'submit';
    var status = el('p', 'f1-status');
    status.setAttribute('role', 'status');
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var value = message.value.trim();
      if (value.length < 3) { say(status, 'Add a sentence about what to fix.'); return; }
      send.disabled = true;
      say(status, 'Sending…');
      fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: chosen || 'general',
          suggestion: value,
          page: window.location.pathname + window.location.search,
          website: trap.value
        })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (response.ok) {
            message.value = '';
            say(status, 'Thank you — that was stored.');
          } else if (response.status === 503) {
            say(status, data.error || 'Feedback storage is not configured on this deployment yet.');
          } else {
            say(status, data.error || 'Could not send that just now. Try again shortly.');
          }
        });
      }).catch(function () {
        say(status, 'Network error — the report was not sent.');
      }).then(function () { send.disabled = false; });
    });
    form.appendChild(thumbs);
    form.appendChild(message);
    form.appendChild(trap);
    form.appendChild(send);
    box.appendChild(title);
    box.appendChild(hint);
    box.appendChild(form);
    box.appendChild(status);
    footer.insertBefore(box, footer.firstChild);
    mark(box, 'feedback');
  }

  /* ── 13. Components surface (/?components=1) ──────────────────── */
  function panel(title, component) {
    var box = el('section', 'f1-panel');
    var heading = el('h3', null, title);
    box.appendChild(heading);
    if (component) mark(box, component);
    return box;
  }

  function pills(choices, value, onPick, component, groupLabel, jelly) {
    var wrap = el('div', jelly ? 'f1-pills f1-jelly' : 'f1-pills');
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', groupLabel);
    choices.forEach(function (choice) {
      var button = el('button', 'f1-pill touch-target', choice);
      button.type = 'button';
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(choice === value));
      button.addEventListener('click', function () {
        $$('button', wrap).forEach(function (other) { other.setAttribute('aria-checked', String(other === button)); });
        if (jelly) { button.removeAttribute('data-picked'); void button.offsetWidth; button.setAttribute('data-picked', ''); }
        onPick(choice);
      });
      wrap.appendChild(button);
    });
    if (component) mark(wrap, component);
    return wrap;
  }

  function toggle(label, checked, onChange) {
    var button = el('button', 'f1-switch-btn touch-target');
    button.type = 'button';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', String(checked));
    button.setAttribute('aria-label', label);
    var knob = el('span', 'f1-switch-knob');
    button.appendChild(knob);
    button.addEventListener('click', function () {
      var next = button.getAttribute('aria-checked') !== 'true';
      button.setAttribute('aria-checked', String(next));
      onChange(next);
    });
    return button;
  }

  function miniStepper(value, min, max, onChange) {
    var wrap = el('div', 'f1-mini-step');
    var down = el('button', 'touch-target', '\u2212');
    down.type = 'button';
    down.setAttribute('aria-label', 'Fewer');
    var out = el('output', null, String(value));
    var up = el('button', 'touch-target', '+');
    up.type = 'button';
    up.setAttribute('aria-label', 'More');
    function set(next) {
      var bounded = Math.min(max, Math.max(min, next));
      out.textContent = String(bounded);
      down.disabled = bounded <= min;
      up.disabled = bounded >= max;
      onChange(bounded);
    }
    down.addEventListener('click', function () { set(Number(out.textContent) - 1); });
    up.addEventListener('click', function () { set(Number(out.textContent) + 1); });
    down.disabled = value <= min;
    up.disabled = value >= max;
    wrap.appendChild(down); wrap.appendChild(out); wrap.appendChild(up);
    return wrap;
  }

  function glideSelect(options, value, onChange) {
    var wrap = el('div', 'f1-select');
    var button = el('button', 'f1-select-btn touch-target', value);
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    var list = el('div', 'f1-menu');
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    options.forEach(function (option) {
      var item = el('button', 'f1-menu-item', option);
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option === value));
      item.addEventListener('click', function () {
        button.textContent = option;
        list.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        button.focus();
        $$('button', list).forEach(function (other) { other.setAttribute('aria-selected', String(other === item)); });
        onChange(option);
      });
      list.appendChild(item);
    });
    button.addEventListener('click', function () {
      list.hidden = !list.hidden;
      button.setAttribute('aria-expanded', String(!list.hidden));
      if (!list.hidden) { var first = list.querySelector('button'); if (first) first.focus(); }
    });
    list.addEventListener('keydown', function (event) {
      var items = $$('button', list);
      var index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); list.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); }
    });
    wrap.appendChild(button);
    wrap.appendChild(list);
    return wrap;
  }

  function numberField(value, onChange) {
    var input = el('input', 'f1-num touch-target');
    input.type = 'text';
    input.setAttribute('inputmode', 'decimal');
    input.value = String(value);
    input.setAttribute('aria-label', 'Tooltip delay in milliseconds');
    input.addEventListener('change', function () {
      if (!/^\d{0,4}$/.test(input.value)) { input.value = String(store.tooltipDelay); return; }
      var next = Math.min(500, Math.max(0, Number(input.value) || 0));
      input.value = String(next);
      onChange(next);
    });
    return input;
  }

  /* GitHub activity — displayOnly on this site (the API is OpenF1, there is no
     contribution feed to read), so it renders a clearly labelled sample grid
     instead of pretending to be live data. */
  function activityFigure() {
    var holder = el('div', 'f1-figure');
    var grid = el('div', 'f1-activity-grid');
    grid.setAttribute('role', 'img');
    grid.setAttribute('aria-label', 'Sample contribution grid, 28 cells');
    for (var i = 0; i < 28; i++) {
      var cell = el('span', 'f1-activity-cell f1-level-' + ((i * 5) % 5));
      cell.setAttribute('aria-hidden', 'true');
      grid.appendChild(cell);
    }
    var note = el('p', 'f1-note', 'Sample grid — this site has no contribution feed; the component is hosted here to render and behave, not to report data.');
    holder.appendChild(grid);
    holder.appendChild(note);
    return holder;
  }

  function analyticsFigure() {
    var holder = el('div', 'f1-figure');
    var a = analysis();
    var series = [];
    if (a && a.driverStats && a.driverStats.length && a.traces && a.traces.size) {
      var first = a.driverStats[0];
      var trace = a.traces.get(first.num);
      if (trace) series = Array.prototype.slice.call(trace.trace, 0, 120).map(function (v) { return v; });
    }
    var live = series.length > 1;
    if (!live) series = [92, 91, 92.4, 91.2, 90.8, 91.5, 90.9, 90.2, 90.6, 90.1, 90.4, 89.9];
    var min = Math.min.apply(null, series), max = Math.max.apply(null, series);
    var span = max - min || 1;
    var points = series.map(function (value, i) {
      var x = (i / (series.length - 1)) * 100;
      var y = 34 - ((value - min) / span) * 28;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'f1-chart-svg');
    svg.setAttribute('viewBox', '0 0 100 40');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', live ? 'Speed trace of the fastest analyzed driver' : 'Labelled sample speed trace');
    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('class', 'f1-chart-line');
    poly.setAttribute('points', points);
    svg.appendChild(poly);
    holder.appendChild(svg);
    holder.appendChild(el('p', 'f1-note', live
      ? 'Live: the speed trace of ' + a.driverStats[0].info.acronym + ' from the analysis in memory.'
      : 'Sample trace — run an analysis and this redraws from the fastest driver\'s telemetry.'));
    return holder;
  }

  function timelineFigure() {
    var holder = el('div', 'f1-figure');
    var list = sessions();
    if (!list.length) {
      holder.appendChild(el('p', 'f1-note', 'Pick a Grand Prix and this becomes that weekend\'s real session timeline.'));
      return holder;
    }
    var strip = el('ol', 'f1-timeline');
    list.slice(0, 6).forEach(function (session) {
      var item = el('li', 'f1-timeline-item');
      var when = el('span', 'f1-timeline-when');
      try { when.textContent = new Date(session.date_start).toLocaleString(); } catch (e) { when.textContent = String(session.date_start || ''); }
      item.appendChild(el('strong', 'f1-timeline-name', session.session_name || 'Session'));
      item.appendChild(when);
      strip.appendChild(item);
    });
    holder.appendChild(strip);
    holder.appendChild(el('p', 'f1-note', 'Live: the sessions the app loaded for the selected Grand Prix.'));
    return holder;
  }

  function profileFigure() {
    var holder = el('div', 'f1-figure');
    var a = analysis();
    if (!a || !a.driverStats || !a.driverStats.length) {
      holder.appendChild(el('p', 'f1-note', 'Run an analysis and each analyzed driver gets a card here — team, best lap and corners won.'));
      return holder;
    }
    a.driverStats.slice(0, 4).forEach(function (driver) {
      var card = el('button', 'f1-profile touch-target');
      card.type = 'button';
      card.setAttribute('aria-expanded', 'false');
      var top = el('span', 'f1-profile-top');
      top.appendChild(el('strong', null, driver.info.acronym));
      top.appendChild(el('span', 'f1-muted', driver.info.team || ''));
      card.appendChild(top);
      var detail = el('span', 'f1-profile-detail');
      detail.hidden = true;
      detail.textContent = 'Best lap ' + (typeof fmtLap === 'function' ? fmtLap(driver.lap.lap_duration) : driver.lap.lap_duration) + ' · ' + driver.won + ' corners won · compound ' + (driver.compound || '—');
      card.appendChild(detail);
      card.addEventListener('click', function () {
        detail.hidden = !detail.hidden;
        card.setAttribute('aria-expanded', String(!detail.hidden));
      });
      holder.appendChild(card);
    });
    holder.appendChild(el('p', 'f1-note', 'Live: read from the analysis in memory, nothing stored.'));
    return holder;
  }

  function transactionFigure() {
    var holder = el('div', 'f1-figure');
    var a = analysis();
    var rows = [];
    if (a) {
      rows.push(['Session', (a.session.session_name || '') + ' (' + (a.session.session_type || '') + ')']);
      rows.push(['Event', a.meeting ? (a.meeting.meeting_name || '') : '—']);
      rows.push(['Drivers analyzed', String(a.driverStats.length)]);
      rows.push(['Corners', a.cornerResults.length + ' (' + a.cornerSource + ' apexes)']);
    } else {
      rows.push(['Session facts', 'appear here after an analysis']);
    }
    rows.forEach(function (row) {
      var item = el('div', 'f1-txn');
      var button = el('button', 'f1-txn-row touch-target');
      button.type = 'button';
      button.setAttribute('aria-expanded', 'false');
      button.appendChild(el('span', null, row[0]));
      button.appendChild(el('strong', null, row[1]));
      var detail = el('div', 'f1-txn-detail');
      detail.hidden = true;
      detail.textContent = row[0] + ': ' + row[1];
      button.addEventListener('click', function () {
        detail.hidden = !detail.hidden;
        button.setAttribute('aria-expanded', String(!detail.hidden));
      });
      item.appendChild(button);
      item.appendChild(detail);
      holder.appendChild(item);
    });
    return holder;
  }

  function fundFigure() {
    var wrap = el('div', 'f1-fund');
    var prev = el('button', 'touch-target', '\u2190');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Previous figure');
    var view = el('div', 'f1-fund-view');
    var label = el('p', 'f1-fund-label');
    var value = el('p', 'f1-fund-value');
    view.appendChild(label);
    view.appendChild(value);
    var next = el('button', 'touch-target', '\u2192');
    next.type = 'button';
    next.setAttribute('aria-label', 'Next figure');
    var index = 0;
    function funds() {
      var a = analysis();
      if (!a) return [{ label: 'Waiting for an analysis', value: '—' }];
      var fastest = a.driverStats[0];
      return [
        { label: 'Fastest lap', value: (fastest.info.acronym || '') + ' · ' + (typeof fmtLap === 'function' ? fmtLap(fastest.lap.lap_duration) : fastest.lap.lap_duration) },
        { label: 'Corners', value: String(a.cornerResults.length) + ' (' + a.cornerSource + ')' },
        { label: 'Drivers', value: String(a.driverStats.length) }
      ];
    }
    function show(i) {
      var list = funds();
      index = (i + list.length) % list.length;
      label.textContent = list[index].label;
      value.textContent = list[index].value;
    }
    prev.addEventListener('click', function () { show(index - 1); });
    next.addEventListener('click', function () { show(index + 1); });
    view.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowLeft') { event.preventDefault(); show(index - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); show(index + 1); }
    });
    wrap.appendChild(prev); wrap.appendChild(view); wrap.appendChild(next);
    show(0);
    return wrap;
  }

  function settingsTable() {
    var table = el('table', 'f1-table');
    var head = el('thead');
    var headRow = el('tr');
    ['Setting', 'Value'].forEach(function (name) {
      var th = el('th', null, name);
      th.setAttribute('scope', 'col');
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = el('tbody');
    var draft = { tooltipDelay: store.tooltipDelay, limit: store.limit };
    [['Tooltip delay (ms)', 'tooltipDelay'], ['Drivers to analyze', 'limit']].forEach(function (spec) {
      var row = el('tr');
      var nameCell = el('td');
      nameCell.appendChild(el('span', null, spec[0]));
      var valueCell = el('td');
      var input = el('input', 'f1-table-input touch-target');
      input.value = String(draft[spec[1]]);
      input.setAttribute('aria-label', spec[0]);
      input.addEventListener('input', function () { draft[spec[1]] = input.value; });
      valueCell.appendChild(input);
      row.appendChild(nameCell);
      row.appendChild(valueCell);
      body.appendChild(row);
    });
    table.appendChild(body);
    var apply = el('button', 'f1-action touch-target', 'Apply');
    apply.type = 'button';
    var status = el('p', 'f1-status');
    apply.addEventListener('click', function () {
      var patch = {};
      if (/^\d{0,4}$/.test(draft.tooltipDelay)) patch.tooltipDelay = Math.min(500, Math.max(0, Number(draft.tooltipDelay) || 0));
      if (String(draft.limit)) patch.limit = String(draft.limit);
      save(patch);
      var select = document.getElementById('driverLimitSelect');
      if (select && patch.limit) {
        var known = $$('sl-option', select).some(function (option) { return option.getAttribute('value') === patch.limit; });
        if (known) select.value = patch.limit;
      }
      say(status, 'Saved to ' + KEY + '.');
    });
    var holder = el('div', 'f1-figure');
    holder.appendChild(table);
    holder.appendChild(apply);
    holder.appendChild(status);
    return holder;
  }

  function swipeRows() {
    var holder = el('div', 'f1-figure');
    [['Tooltip delay', store.tooltipDelay + ' ms'], ['Drivers to analyze', store.limit], ['Replay speed', store.replaySpeed + '×']].forEach(function (pair) {
      var row = el('div', 'f1-swipe');
      mark(row, 'swipe-row');
      var inner = el('div', 'f1-swipe-row');
      inner.appendChild(el('span', null, pair[0]));
      var actions = el('div', 'f1-swipe-actions');
      var copyBtn = el('button', null, 'Copy');
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', 'Copy ' + pair[0]);
      copyBtn.addEventListener('click', function () { copy(pair[0] + ': ' + pair[1]); });
      actions.appendChild(copyBtn);
      var hideBtn = el('button', null, 'Hide');
      hideBtn.type = 'button';
      hideBtn.setAttribute('aria-label', 'Hide ' + pair[0]);
      hideBtn.addEventListener('click', function () { row.hidden = true; });
      actions.appendChild(hideBtn);
      inner.appendChild(actions);
      row.appendChild(inner);
      var startX = null;
      inner.addEventListener('pointerdown', function (event) { startX = event.clientX; });
      inner.addEventListener('pointerup', function (event) {
        if (startX === null) return;
        var delta = Math.min(0, event.clientX - startX);
        inner.style.setProperty('--f1-swipe-x', Math.max(-96, delta) + 'px');
        startX = null;
        window.setTimeout(function () { inner.style.setProperty('--f1-swipe-x', '0px'); }, 1800);
      });
      inner.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowLeft') { event.preventDefault(); inner.style.setProperty('--f1-swipe-x', '-96px'); }
        if (event.key === 'Escape') inner.style.setProperty('--f1-swipe-x', '0px');
      });
      holder.appendChild(row);
    });
    return holder;
  }

  function buildComponentsSurface() {
    var host = el('section', 'f1-surface');
    host.id = 'components';
    host.setAttribute('aria-labelledby', 'f1-surface-title');
    var title = el('h2', null, 'Component surface');
    title.id = 'f1-surface-title';
    var intro = el('p', 'f1-surface-intro', 'The unlinked local surface the 25 design-system components are hosted on, so every one renders and behaves against real state instead of a screenshot. Rows marked "Live" read the analysis in memory; the rest write ' + KEY + ' — nothing here is a stored analysis.');

    var grid = el('div', 'f1-grid');

    // Glide Select — tooltip delay preset (drives every tooltip)
    var p1 = panel('Tooltip delay', 'glide-select');
    var presets = ['Instant', 'Normal', 'Patient'];
    var preset = store.tooltipDelay < 60 ? 'Instant' : store.tooltipDelay > 180 ? 'Patient' : 'Normal';
    p1.appendChild(el('p', 'f1-note', 'Applies to every warm tooltip on the page.'));
    p1.appendChild(glideSelect(presets, preset, function (value) {
      save({ tooltipDelay: value === 'Instant' ? 0 : value === 'Patient' ? 250 : 100 });
    }));
    grid.appendChild(p1);

    // Jelly Radio — result tab
    var p2 = panel('Result tab', 'jelly-radio');
    p2.appendChild(el('p', 'f1-note', 'Switches the same Shoelace tab group the results use.'));
    var tabNames = $$('sl-tab', tabGroup() || document).map(function (tab) { return tab.getAttribute('panel'); }).filter(Boolean);
    p2.appendChild(pills(tabNames.length ? tabNames : ['overview', 'track', 'corners'], store.tab, function (value) {
      save({ tab: value });
      var group = tabGroup();
      if (group && group.show) group.show(value);
    }, null, 'Result tab', true));
    grid.appendChild(p2);

    // Stepper — driver count
    var p3 = panel('Drivers to analyze', 'stepper');
    p3.appendChild(miniStepper(Number(store.limit) === 99 ? 3 : Number(store.limit), 1, 30, function (value) {
      var asValue = value >= 30 ? '99' : String(value);
      save({ limit: asValue });
      var select = document.getElementById('driverLimitSelect');
      if (select) select.value = asValue;
    }));
    p3.appendChild(el('p', 'f1-note', 'Writes the same select the Analyze button reads; 30+ means all drivers.'));
    grid.appendChild(p3);

    // Rubber Segment — replay speed
    var p4 = panel('Replay speed', 'rubber-segment');
    p4.appendChild(pills(['1', '2', '4'], store.replaySpeed, function (value) {
      save({ replaySpeed: value });
      var select = document.getElementById('replaySpeed');
      if (select) select.value = value;
    }, null, 'Replay speed'));
    grid.appendChild(p4);

    // Skiper68 — exact delay
    var p5 = panel('Custom tooltip delay (ms)', 'skiper68');
    p5.appendChild(numberField(store.tooltipDelay, function (value) { save({ tooltipDelay: value }); }));
    grid.appendChild(p5);

    // Squish Switch + Switch Mode — two real preferences
    var p6 = panel('Component motion', 'squish-switch');
    var row6 = el('div', 'f1-switch-row');
    row6.appendChild(toggle('Reduce component motion', !!store.reduceMotion, function (value) { save({ reduceMotion: value }); }));
    row6.appendChild(el('span', 'f1-muted', store.reduceMotion ? 'Component motion is off.' : 'Component motion follows the system setting.'));
    p6.appendChild(row6);
    grid.appendChild(p6);

    var p7 = panel('High contrast', 'switch-mode');
    var row7 = el('div', 'f1-switch-row');
    row7.appendChild(toggle('High contrast hairlines', !!store.contrast, function (value) { save({ contrast: value }); }));
    row7.appendChild(el('span', 'f1-muted', store.contrast ? 'Stronger borders and ink.' : 'Default palette.'));
    p7.appendChild(row7);
    grid.appendChild(p7);

    // Dynamic Button — copy a share link, with real state
    var p8 = panel('Copy share link', 'dynamic-button');
    var dynamic = el('button', 'f1-action touch-target', 'Copy share link');
    dynamic.type = 'button';
    dynamic.addEventListener('click', function () {
      copy(window.location.href, function (ok) {
        dynamic.textContent = ok ? 'Copied' : 'Copy failed';
        window.setTimeout(function () { dynamic.textContent = 'Copy share link'; }, 1800);
      });
    });
    p8.appendChild(dynamic);
    grid.appendChild(p8);

    // Filter Disclosure — which panels show
    var p9 = panel('Panel filter', 'filter-disclosure');
    var details = el('details', 'f1-disclosure');
    var summary = el('summary', 'f1-pill touch-target', 'Filter: ' + store.filter);
    details.appendChild(summary);
    var menu9 = el('div', 'f1-menu');
    ['adopted', 'hosted', 'all'].forEach(function (choice) {
      var item = el('button', 'f1-menu-item', choice === 'all' ? 'All components' : choice === 'adopted' ? 'Adopted on the page' : 'Hosted here');
      item.type = 'button';
      item.addEventListener('click', function () {
        details.open = false;
        summary.textContent = 'Filter: ' + choice;
        save({ filter: choice });
        applyFilter();
      });
      menu9.appendChild(item);
    });
    details.appendChild(menu9);
    p9.appendChild(details);
    p9.appendChild(el('p', 'f1-note', 'Adopted panels are components that also live on the page or footer.'));
    grid.appendChild(p9);

    // Fluid Tabs — adopted vs hosted
    var p10 = panel('Component groups', 'fluid-tabs');
    var list = el('div', 'f1-tablist');
    list.setAttribute('role', 'tablist');
    ['adopted', 'hosted'].forEach(function (name, i) {
      var tab = el('button', 'f1-tab touch-target', name === 'adopted' ? 'Adopted on the page' : 'Hosted here');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(name === (store.filter === 'all' ? 'adopted' : store.filter)));
      tab.addEventListener('click', function () {
        $$('.f1-tab', list).forEach(function (other) { other.setAttribute('aria-selected', String(other === tab)); });
        save({ filter: name });
        applyFilter();
      });
      list.appendChild(tab);
    });
    p10.appendChild(list);
    grid.appendChild(p10);

    // Scroll Island — the surface's own section index
    var p11 = panel('Component index', 'scroll-island');
    p11.appendChild(el('p', 'f1-note', 'The floating island is on the Guide panel of the live page; this panel is the same component hosted here. Its list is filled once every panel exists.'));
    var islandList = el('div', 'f1-island-inline');
    p11.appendChild(islandList);
    grid.appendChild(p11);

    // Skiper74 — real session timeline
    var p12 = panel('Session timeline', 'skiper74');
    p12.appendChild(timelineFigure());
    grid.appendChild(p12);

    // Analytics Chart — live trace when there is one
    var p13 = panel('Speed trace', 'analytics-chart');
    p13.appendChild(analyticsFigure());
    grid.appendChild(p13);

    // GitHub Activity — displayOnly on this site
    var p14 = panel('Contribution grid', 'github-activity');
    p14.appendChild(activityFigure());
    grid.appendChild(p14);

    // Expandable Profile Card — analyzed drivers
    var p15 = panel('Driver cards', 'expandable-profile-card');
    p15.appendChild(profileFigure());
    grid.appendChild(p15);

    // Transaction List — session facts
    var p16 = panel('Session facts', 'transaction-list');
    p16.appendChild(transactionFigure());
    grid.appendChild(p16);

    // Fund Widget — live figures carousel
    var p17 = panel('Figures', 'fund-widget');
    p17.appendChild(fundFigure());
    grid.appendChild(p17);

    // Inline Table Control — settings, edited in place
    var p18 = panel('Settings table', 'inline-table-control');
    p18.appendChild(settingsTable());
    grid.appendChild(p18);

    // Swipe Row — the same settings as swipeable rows
    var p19 = panel('Swipeable rows', 'swipe-row');
    p19.appendChild(swipeRows());
    grid.appendChild(p19);

    // Time Undo Action — reset with undo
    var p20 = panel('Reset preferences', 'time-undo-action');
    var reset = el('button', 'f1-action touch-target', 'Reset preferences');
    reset.type = 'button';
    var undoNote = el('p', 'f1-status');
    var undo = null;
    reset.addEventListener('click', function () {
      if (undo) return;
      var previous = JSON.parse(JSON.stringify(store));
      save(DEFAULTS);
      var left = 5;
      reset.disabled = true;
      undoNote.textContent = 'Preferences reset — Undo (' + left + ')';
      undoNote.setAttribute('role', 'button');
      undoNote.setAttribute('tabindex', '0');
      undo = {
        previous: previous,
        timer: window.setInterval(function () {
          left -= 1;
          if (left <= 0) {
            window.clearInterval(undo.timer);
            undo = null;
            reset.disabled = false;
            undoNote.textContent = 'Preferences reset.';
          } else {
            undoNote.textContent = 'Preferences reset — Undo (' + left + ')';
          }
        }, 1000)
      };
    });
    function undoReset() {
      if (!undo) return;
      window.clearInterval(undo.timer);
      save(undo.previous);
      undo = null;
      reset.disabled = false;
      undoNote.textContent = 'Reset cancelled.';
    }
    undoNote.addEventListener('click', undoReset);
    undoNote.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); undoReset(); }
    });
    p20.appendChild(reset);
    p20.appendChild(undoNote);
    grid.appendChild(p20);

    // Inline Disclosure Menu — the map menu is live; this panel documents it
    var p21 = panel('Row actions menu', 'inline-disclosure-menu');
    p21.appendChild(el('p', 'f1-note', 'The live instance is the ⋯ menu on the Track map card, with copy-link, CSV and Guide actions.'));
    var demoMenu = el('div', 'f1-menu-wrap');
    var demoButton = el('button', 'f1-menu-btn touch-target', '\u22ee');
    demoButton.type = 'button';
    demoButton.setAttribute('aria-haspopup', 'menu');
    demoButton.setAttribute('aria-expanded', 'false');
    demoButton.setAttribute('aria-label', 'Example actions');
    var demoList = el('div', 'f1-menu');
    demoList.setAttribute('role', 'menu');
    demoList.hidden = true;
    [['Copy the page URL', function () { copy(window.location.href); }],
     ['Reset the tooltip delay', function () { save({ tooltipDelay: DEFAULTS.tooltipDelay }); }]].forEach(function (spec) {
      var item = el('button', 'f1-menu-item', spec[0]);
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.addEventListener('click', function () { demoList.hidden = true; demoButton.setAttribute('aria-expanded', 'false'); spec[1](); });
      demoList.appendChild(item);
    });
    demoButton.addEventListener('click', function () {
      demoList.hidden = !demoList.hidden;
      demoButton.setAttribute('aria-expanded', String(!demoList.hidden));
    });
    demoMenu.appendChild(demoButton);
    demoMenu.appendChild(demoList);
    p21.appendChild(demoMenu);
    grid.appendChild(p21);

    // Warm Tooltip — a labelled example, since the live ones are in the nav
    var p22 = panel('Warm tooltip', 'warm-tooltip');
    var tipButton = el('button', 'f1-action touch-target', 'Hover or focus me');
    tipButton.type = 'button';
    tipButton.setAttribute('data-tip', 'Tooltips open after ' + store.tooltipDelay + ' ms — change that above.');
    p22.appendChild(tipButton);
    grid.appendChild(p22);

    // Gooey Nav + Animated Counter — live elsewhere; documented here
    var p23 = panel('Navigation indicator', 'gooey-nav');
    p23.appendChild(el('p', 'f1-note', 'The live instance is the blob under the active item in the top navigation.'));
    grid.appendChild(p23);

    var p24 = panel('Figure counters', 'animated-counter');
    p24.appendChild(el('p', 'f1-note', 'The live instances are the numeric values in the Session summary, which tick when an analysis renders them.'));
    grid.appendChild(p24);

    // Feedback — the live form is in the footer
    var p25 = panel('Feedback box', 'feedback');
    p25.appendChild(el('p', 'f1-note', 'The live form sits at the top of the page footer and posts to /api/feedback.'));
    grid.appendChild(p25);

    // The index lists every panel, so it is filled after the last one exists.
    $$('.f1-panel', grid).forEach(function (section, i) {
      var h = section.querySelector('h3');
      if (!h) return;
      if (!h.id) h.id = 'f1-panel-' + i;
      var link = el('button', 'f1-island-link touch-target', text(h));
      link.type = 'button';
      link.addEventListener('click', function () { section.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' }); });
      islandList.appendChild(link);
    });

    host.appendChild(title);
    host.appendChild(intro);
    host.appendChild(grid);
    var main = document.getElementById('main');
    if (main && main.parentNode) main.parentNode.insertBefore(host, main.nextSibling);

    // Re-render the tooltips so the panel's example has one too, then wire the
    // filter.
    installTooltips();
    applyFilter();
    function applyFilter() {
      $$('.f1-panel', grid).forEach(function (section) {
        var id = (section.getAttribute('data-component') || '').split(/\s+/)[0];
        var adopted = ADOPTED.indexOf(id) !== -1;
        section.hidden = store.filter === 'adopted' ? !adopted : store.filter === 'hosted' ? adopted : false;
      });
    }
  }

  /* Components with a live instance on the page (everything else is hosted
     only on /?components=1). Kept as a list so the surface filter and the
     manifest's routesBySite describe the same set. */
  var ADOPTED = [
    'gooey-nav', 'warm-tooltip', 'animated-counter', 'stepper', 'rubber-segment',
    'switch-mode', 'dynamic-button', 'inline-disclosure-menu', 'scroll-island', 'feedback'
  ];

  /* ── 14. Service worker + update prompt ───────────────────────── */
  function installServiceWorker() {
    var bar = el('div', 'update-bar');
    bar.hidden = true;
    var message = el('span', null, 'A new version of the analyzer is available.');
    var reload = el('button', null, 'Reload');
    reload.type = 'button';
    bar.appendChild(message);
    bar.appendChild(reload);
    document.body.appendChild(bar);

    if (!('serviceWorker' in navigator)) return;

    var waiting = null;
    function offer(worker) {
      waiting = worker;
      bar.hidden = false;
    }
    reload.addEventListener('click', function () {
      reload.textContent = 'Reloading…';
      reload.disabled = true;
      if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () { window.location.reload(); });

    navigator.serviceWorker.register('/sw.js').then(function (registration) {
      if (registration.waiting) offer(registration.waiting);
      registration.addEventListener('updatefound', function () {
        var installing = registration.installing;
        if (!installing) return;
        installing.addEventListener('statechange', function () {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) offer(installing);
        });
      });
    }).catch(function () { /* http(s) only; a static file server may refuse */ });
  }

  /* ── 15. Focus on hash navigation + touch targets ─────────────── */
  function installHashFocus() {
    window.addEventListener('hashchange', function () {
      var target = document.getElementById(window.location.hash.slice(1));
      if (!target) return;
      var heading = target.querySelector('h1, h2, h3') || target;
      heading.setAttribute('tabindex', '-1');
      try { heading.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    });
  }

  function installTouchTargets() {
    $$('.nav-link, .card-head sl-button, #copyLinkBtn, #resetBtn, .footer-top, #bgToggle')
      .forEach(function (node) { node.classList.add('touch-target'); });
  }

  /* ── Apply persisted preferences ──────────────────────────────── */
  function apply() {
    var root = document.documentElement;
    root.classList.toggle('f1-reduce-motion', !!store.reduceMotion);
    root.classList.toggle('f1-contrast', !!store.contrast);
    var select = document.getElementById('driverLimitSelect');
    if (select && store.limit) select.value = store.limit;
    var speed = document.getElementById('replaySpeed');
    if (speed && store.replaySpeed) speed.value = store.replaySpeed;
    var tipExample = document.querySelector('.f1-panel [data-tip] .f1-tip');
    if (tipExample) tipExample.textContent = 'Tooltips open after ' + store.tooltipDelay + ' ms — change that above.';
  }

  function init() {
    installNav();
    installTooltips();
    installCounters();
    installStepper();
    installSegment();
    installSwitchMode();
    installDynamicButton();
    installRowMenu();
    installIsland();
    installFeedback();
    installHashFocus();
    installTouchTargets();
    if (new URLSearchParams(window.location.search).get('components') === '1') buildComponentsSurface();
    // The surface hosts one squish switch in its own panel; this is the live
    // copy, in the footer beside the feedback box, where a motion preference is
    // something a visitor can actually reach.
    installSquish($('.site-footer'));
    installServiceWorker();
    apply();
    document.documentElement.setAttribute('data-components-ready', 'true');
    window.f1Settings = { get: function () { return JSON.parse(JSON.stringify(store)); }, set: save };
  }

  init();
})();
