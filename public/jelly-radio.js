/* Jelly Radio - a vanilla port of React Bits' Jelly Radio.
 *
 * A radio group of chips where the chosen chip swells and pushes its
 * neighbours aside on a spring. Unlike the React original, this build does not
 * own the markup: it adopts a group that already exists in the page, so the
 * site keeps the buttons it wires its own click handlers to and the component
 * only supplies the surface, the keyboard model and the spring.
 *
 * Usage, no build step:
 *
 *   <link rel="stylesheet" href="/jelly-radio.css">
 *   <script src="/jelly-radio.js" defer></script>
 *
 *   <div class="sem-selector" data-jelly-radio data-jelly-aria-label="Semester">
 *     <button type="button" class="sem-chip active">All</button>
 *     <button type="button" class="sem-chip">Autumn</button>
 *     <button type="button" class="sem-chip">Spring</button>
 *   </div>
 *
 * The group is the element carrying `data-jelly-radio`; its direct button
 * children are the chips (a non-button child such as a decorative indicator is
 * left alone). The selected chip is read from the item itself - `aria-checked`,
 * `aria-selected`, `aria-pressed`, `data-on`, `.active` or `.on` - so the page
 * stays the source of truth: click a chip, the site's handler updates its own
 * state, and the component animates to whatever the page now says is selected.
 *
 * Optional attributes on the group:
 *
 *   data-jelly-size="sm|md|lg"     chip height 28/36/44px
 *   data-jelly-aria-label="…"      accessible name for the group
 *   data-jelly-gap="8"             gap between chips in px (default 8)
 *   data-jelly-radius="18"         chip corner radius in px
 *   data-jelly-swell="0.2"         selected chip scale increase
 *   data-jelly-barge="6"           extra outward push, px
 *   data-jelly-shrink="0.05"       unselected chip scale
 *   data-jelly-jelly="1"           spring character
 *   data-jelly-bounce="0.25"       spring bounce
 *   data-jelly-stagger="22"        delay per chip of distance, ms
 *   data-jelly-stiffness="580"     base spring stiffness
 *   data-jelly-pad="1"             add room for the swell (default: none)
 *   data-jelly-disabled            disable the whole group
 *
 * No inline script and no inline style attributes are written by the page, so
 * a `script-src 'self'; style-src 'self'` policy needs no hash and no
 * 'unsafe-inline'. The component writes transforms through the CSSOM.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || window.JellyRadio) return;

  var SIZES = {
    sm: { h: 28, font: 12, px: 12 },
    md: { h: 36, font: 13, px: 16 },
    lg: { h: 44, font: 14, px: 20 },
  };
  var instances = new WeakMap();
  var uid = 0;
  var reduce = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };

  function num(el, attr, fallback) {
    var v = parseFloat(el.getAttribute(attr));
    return isFinite(v) ? v : fallback;
  }

  /* Read the page's own idea of the selection. `data-on` is deliberately not
   * consulted: that is the attribute this component writes for its skin, and
   * reading it back would keep it stuck on the previous chip. */
  function isOn(el) {
    return el.getAttribute('aria-checked') === 'true'
      || el.getAttribute('aria-selected') === 'true'
      || el.getAttribute('aria-pressed') === 'true'
      || el.classList.contains('active')
      || el.classList.contains('on');
  }

  function itemsOf(group) {
    var out = [];
    for (var i = 0; i < group.children.length; i++) {
      var el = group.children[i];
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'radio' || el.getAttribute('role') === 'tab') out.push(el);
    }
    return out;
  }

  function JellyRadio(group, opts) {
    if (!group || instances.has(group)) return instances.get(group);
    opts = opts || {};
    this.group = group;
    this.id = 'jr-' + (++uid);
    this.items = [];
    this.sel = 0;
    this.widths = [];
    this.motion = [];
    this.clickAt = 0;
    this.raf = 0;
    this.lastFrame = 0;

    var size = opts.size || group.getAttribute('data-jelly-size') || 'md';
    var s = SIZES[size] || SIZES.md;

    this.cfg = {
      swell: num(group, 'data-jelly-swell', 0.2),
      barge: num(group, 'data-jelly-barge', 6),
      shrink: num(group, 'data-jelly-shrink', 0.05),
      jelly: num(group, 'data-jelly-jelly', 1),
      bounce: num(group, 'data-jelly-bounce', 0.25),
      stagger: num(group, 'data-jelly-stagger', 22),
      stiffness: num(group, 'data-jelly-stiffness', 580),
    };

    group.classList.add('jelly-radio');
    group.style.setProperty('--jr-h', s.h + 'px');
    group.style.setProperty('--jr-font', s.font + 'px');
    group.style.setProperty('--jr-px', s.px + 'px');
    group.style.setProperty('--jr-gap', num(group, 'data-jelly-gap', 8) + 'px');
    group.style.setProperty('--jr-radius', num(group, 'data-jelly-radius', 18) + 'px');
    group.dataset.jellySize = SIZES[size] ? size : 'md';

    var label = opts.label || group.getAttribute('data-jelly-aria-label') || group.getAttribute('aria-label');
    if (label) group.setAttribute('aria-label', label);
    if (group.getAttribute('role') !== 'tablist' && group.getAttribute('role') !== 'radiogroup') {
      group.setAttribute('role', 'radiogroup');
    }
    if (group.hasAttribute('data-jelly-disabled')) group.setAttribute('data-disabled', '');

    this.collect();
    this.bind();
    this.watch();
    instances.set(group, this);
    this.settle();
  }

  JellyRadio.prototype.collect = function () {
    var group = this.group;
    var items = itemsOf(group);
    this.items = items;
    this.motion = items.map(function (el) {
      return { el: el, x: 0, sx: 1, sy: 1, vx: 0, vsx: 0, vsy: 0, tx: 0, tsx: 1, tsy: 1, delay: 0 };
    });
    this.widths = items.map(function () { return 0; });
    /* Own the semantics only when the markup does not already carry them. A
     * page that ships tabs (`role=tab` + `aria-selected`) or pressed buttons
     * (`aria-pressed`) keeps its own model; the component then just animates
     * and roves the tab stop. */
    this.owns = !items.some(function (el) {
      return el.hasAttribute('aria-pressed') || el.hasAttribute('aria-selected')
        || el.hasAttribute('aria-checked') || el.getAttribute('role') === 'tab';
    });
    if (this.owns) {
      if (group.getAttribute('role') !== 'radiogroup') group.setAttribute('role', 'radiogroup');
    }
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      el.classList.add('jelly-radio__chip');
      el.setAttribute('data-jelly-index', String(i));
      if (this.owns) {
        el.setAttribute('role', 'radio');
        el.setAttribute('aria-checked', isOn(el) ? 'true' : 'false');
      }
      el.setAttribute('tabindex', '-1');
    }
    // The decorative indicator a tab strip may ship with is redundant now.
    for (var k = 0; k < group.children.length; k++) {
      var child = group.children[k];
      if (items.indexOf(child) === -1 && child.getAttribute('aria-hidden') === 'true') child.setAttribute('data-jelly-hidden', '');
    }
    this.sel = this.activeIndex();
  };

  JellyRadio.prototype.activeIndex = function () {
    for (var i = 0; i < this.items.length; i++) if (isOn(this.items[i])) return i;
    return this.items.length ? 0 : -1;
  };

  JellyRadio.prototype.bind = function () {
    var self = this;

    this.group.addEventListener('pointerdown', function () { self.clickAt = Date.now(); }, true);
    this.group.addEventListener('click', function (e) {
      var chip = e.target.closest ? e.target.closest('.jelly-radio__chip') : null;
      if (!chip || !self.group.contains(chip)) return;
      self.clickAt = Date.now();
      if (self.owns) {
        self.choose(Number(chip.getAttribute('data-jelly-index')), true);
        return;
      }
      // Let the page's own handler update its state, then follow it.
      requestAnimationFrame(function () { self.sync(true); });
    });

    this.group.addEventListener('keydown', function (e) {
      var chip = e.target.closest ? e.target.closest('.jelly-radio__chip') : null;
      if (!chip) return;
      var i = Number(chip.getAttribute('data-jelly-index'));
      var n = self.items.length;
      var next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = self.step(i, 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = self.step(i, -1);
      else if (e.key === 'Home') next = self.step(-1, 1);
      else if (e.key === 'End') next = self.step(n, -1);
      else if (e.key === ' ' || e.key === 'Enter') next = i;
      if (next === null || next === undefined) return;
      e.preventDefault();
      var target = self.items[next];
      if (!target || target.disabled) return;
      self.clickAt = Date.now();
      if (next !== i) target.click();
      else if (target.getAttribute('role') === 'radio' || target.getAttribute('role') === 'tab') target.click();
      target.focus({ preventScroll: true });
      requestAnimationFrame(function () { self.sync(true); });
    });
  };

  JellyRadio.prototype.choose = function (i, animate) {
    if (i < 0 || i >= this.items.length) return;
    this.sel = i;
    this.restate();
    this.apply(i, !animate);
  };

  JellyRadio.prototype.step = function (from, dir) {
    var n = this.items.length;
    var j = from;
    for (var tries = 0; tries < n; tries++) {
      j = (j + dir + n) % n;
      if (this.items[j] && !this.items[j].disabled) return j;
    }
    return from;
  };

  JellyRadio.prototype.watch = function () {
    var self = this;
    this.settleSoon = function () { self.settle(); };
    this.onResize = function () { self.settle(); };
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(this.onResize);
      this.resizeObserver.observe(this.group);
    }
    if (typeof window.addEventListener === 'function') window.addEventListener('resize', this.onResize);
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(this.onResize).catch(function () {});
    }
    if (typeof MutationObserver === 'function') {
      this.observer = new MutationObserver(function (records) {
        var structural = records.some(function (r) { return r.type === 'childList'; });
        var state = records.some(function (r) { return r.type === 'attributes'; });
        if (structural) { self.collect(); self.settle(); return; }
        if (state) {
          var animate = Date.now() - self.clickAt < 600;
          self.sync(animate);
        }
      });
      this.observer.observe(this.group, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-checked', 'aria-selected', 'aria-pressed', 'data-on', 'data-active', 'disabled', 'hidden'],
      });
    }
    if (reduce.addEventListener) reduce.addEventListener('change', function () { self.settle(); });
  };

  JellyRadio.prototype.measure = function () {
    var group = this.group;
    var widths = [];
    var maxW = 0;
    var chipH = 0;
    for (var i = 0; i < this.items.length; i++) {
      var el = this.items[i];
      widths.push(el.offsetWidth || 0);
      if (widths[i] > maxW) maxW = widths[i];
      if (!chipH) chipH = el.offsetHeight || 0;
    }
    this.widths = widths;
    if (group.hasAttribute('data-jelly-pad')) {
      var c = this.cfg;
      group.style.setProperty('--jr-pad-x', Math.ceil((maxW * c.swell * 1.3) / 2 + c.barge) + 2 + 'px');
      group.style.setProperty('--jr-pad-y', Math.ceil((chipH * c.swell) / 2) + 2 + 'px');
    }
  };

  /* The page is the source of truth: read the selected chip off the DOM and
   * move to it. `animate` is true for a click, false for a value the page set
   * on its own (a restored filter, a rebuilt row). */
  JellyRadio.prototype.sync = function (animate) {
    var at = this.activeIndex();
    if (at === this.sel) { this.restate(); return; }
    this.sel = at;
    this.apply(at, !animate);
  };

  /* Only write an attribute when its value actually changes. The group is
   * watched for attribute mutations, and re-writing the same value still
   * queues a record, which would feed the observer its own writes forever. */
  JellyRadio.prototype.setAttr = function (el, name, value) {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };

  JellyRadio.prototype.restate = function () {
    var tabindexSet = this.sel >= 0;
    for (var i = 0; i < this.items.length; i++) {
      var el = this.items[i];
      var on = i === this.sel;
      this.setAttr(el, 'data-on', on ? 'true' : 'false');
      if (this.owns) this.setAttr(el, 'aria-checked', on ? 'true' : 'false');
      if (tabindexSet) this.setAttr(el, 'tabindex', on ? '0' : '-1');
    }
  };

  JellyRadio.prototype.settle = function () {
    this.measure();
    if (!this.owns) this.sel = this.activeIndex();
    this.restate();
    this.apply(this.sel, true);
  };

  JellyRadio.prototype.apply = function (sel, instant) {
    var c = this.cfg;
    var rtl = false;
    try { rtl = getComputedStyle(this.group).direction === 'rtl'; } catch (e) {}
    var push = ((this.widths[sel] || 0) * c.swell) / 2 + c.barge;
    var jump = instant || reduce.matches;
    for (var i = 0; i < this.items.length; i++) {
      var m = this.motion[i];
      if (!m) continue;
      var on = i === sel;
      var far = Math.abs(i - sel);
      var dir = Math.sign(i - sel) * (rtl ? -1 : 1);
      var s = on ? 1 + c.swell : 1 - c.shrink;
      m.tx = dir * push;
      m.tsx = s;
      m.tsy = s;
      if (jump) {
        m.x = m.tx; m.sx = m.tsx; m.sy = m.tsy;
        m.vx = m.vsx = m.vsy = 0;
        m.delay = 0;
        this.paint(m);
        continue;
      }
      var inFlight = Math.abs(m.vx) > 0.5 || Math.abs(m.vsx) > 0.5;
      m.delay = inFlight ? 0 : (far * c.stagger) / 1000;
      m.k = c.stiffness * (1 - 0.12 * Math.min(far, 3));
      m.ksx = m.k * (1 + 0.24 * c.jelly);
      m.ksy = m.k * (1 - 0.14 * c.jelly);
      m.bsx = Math.min(0.85, c.bounce + 0.3 * c.jelly);
      m.syDelay = m.delay + 0.05 * c.jelly;
    }
    this.start();
  };

  JellyRadio.prototype.paint = function (m) {
    // The transform never depends on layout, so it is written straight to the
    // element; transform-origin is centred by the stylesheet.
    if (m.el) m.el.style.transform = 'translateX(' + m.x + 'px) scale(' + m.sx + ', ' + m.sy + ')';
  };

  JellyRadio.prototype.start = function () {
    if (this.raf) return;
    var self = this;
    this.lastFrame = 0;
    var tick = function (ts) {
      var dt = self.lastFrame ? Math.min(0.064, (ts - self.lastFrame) / 1000) : 1 / 60;
      self.lastFrame = ts;
      var busy = self.frame(dt);
      if (busy) self.raf = requestAnimationFrame(tick);
      else { self.raf = 0; self.lastFrame = 0; }
    };
    this.raf = requestAnimationFrame(tick);
  };

  /* One step of a damped spring per value. Damping follows the original's
   * formula: 2 * sqrt(k * m) * (1 - bounce). */
  function integrate(m, key, velKey, k, m0, bounce, dt, wait) {
    if (wait > 0) return true;
    var target = key === 'x' ? m.tx : key === 'sx' ? m.tsx : m.tsy;
    var pos = m[key];
    var vel = m[velKey];
    var damping = 2 * Math.sqrt(k * m0) * (1 - bounce);
    var accel = -k * (pos - target) - damping * vel;
    vel += accel * dt;
    pos += vel * dt;
    m[key] = pos;
    m[velKey] = vel;
    var settled = Math.abs(pos - target) < 0.002 && Math.abs(vel) < 0.002;
    if (settled) { m[key] = target; m[velKey] = 0; }
    return !settled;
  }

  JellyRadio.prototype.frame = function (dt) {
    var c = this.cfg;
    var busy = false;
    for (var i = 0; i < this.items.length; i++) {
      var m = this.motion[i];
      if (!m) continue;
      if (m.delay > 0) { m.delay = Math.max(0, m.delay - dt); busy = true; continue; }
      var a = integrate(m, 'x', 'vx', m.k || c.stiffness, 0.9, c.bounce, dt, 0);
      var b = integrate(m, 'sx', 'vsx', m.ksx || c.stiffness, 0.9 - 0.1 * c.jelly, m.bsx || c.bounce, dt, 0);
      m.syDelay = Math.max(0, (m.syDelay || 0) - dt);
      var d = integrate(m, 'sy', 'vsy', m.ksy || c.stiffness, 0.9 + 0.05 * c.jelly, c.bounce, dt, 0);
      // The Y seat lands a beat after X, which is what makes the chip read as
      // jelly rather than as a uniform scale.
      m.el.style.transform = 'translateX(' + m.x + 'px) scale(' + m.sx + ', ' + m.sy + ')';
      if (a || b || d) busy = true;
    }
    return busy;
  };

  JellyRadio.prototype.destroy = function () {
    this.observer && this.observer.disconnect();
    this.resizeObserver && this.resizeObserver.disconnect();
    if (typeof window.removeEventListener === 'function') window.removeEventListener('resize', this.onResize);
    if (this.raf) cancelAnimationFrame(this.raf);
    var group = this.group;
    group.classList.remove('jelly-radio');
    for (var i = 0; i < this.items.length; i++) {
      var el = this.items[i];
      el.classList.remove('jelly-radio__chip');
      el.style.transform = '';
      el.removeAttribute('data-jelly-index');
    }
    instances.delete(group);
  };

  function enhance(group, opts) {
    if (!group || instances.has(group)) return instances.get(group) || null;
    if (itemsOf(group).length === 0) return null;
    return new JellyRadio(group, opts);
  }

  function autoInit(root) {
    var nodes = (root || document).querySelectorAll('[data-jelly-radio]');
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  function start() {
    autoInit(document);
    if (typeof MutationObserver !== 'function') return;
    var pending = false;
    var observer = new MutationObserver(function (records) {
      if (pending) return;
      var relevant = records.some(function (r) {
        return r.type === 'childList' && r.addedNodes.length;
      });
      if (!relevant) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; autoInit(document); });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.JellyRadio = {
    enhance: enhance,
    autoInit: autoInit,
    get: function (el) { return instances.get(el) || null; },
    version: '1.0.0',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
