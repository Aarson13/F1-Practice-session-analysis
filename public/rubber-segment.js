/* Rubber Segment - a vanilla port of React Bits' Rubber Segment.
 *
 * A segmented control whose thumb does not slide: it stretches across the gap,
 * lands on the new slot and squashes into it. The React original animates a
 * clipped duplicate label layer; this build adopts a group that already exists
 * and paints the thumb behind the chips, so a site keeps its own text, events
 * and state while the geometry is ours.
 *
 *   <link rel="stylesheet" href="/rubber-segment.css">
 *   <script src="/rubber-segment.js" defer></script>
 *
 *   <div class="range" data-rubber-segment data-rs-aria-label="Range">
 *     <button type="button" class="active" aria-pressed="true">30 days</button>
 *     <button type="button" aria-pressed="false">Quarter</button>
 *     <button type="button" aria-pressed="false">Year</button>
 *   </div>
 *
 * The selected chip is read from the page - aria-checked, aria-selected,
 * aria-pressed, data-on, .active or .on - so the site stays authoritative:
 * click a chip, its handler updates its own state, and the thumb moves there.
 *
 * Options on the group:
 *   data-rs-size="sm|md|lg"   track height 28/36/44
 *   data-rs-inset="3"         gap between track edge and thumb, px
 *   data-rs-radius="10"       track corner radius, px
 *   data-rs-stretch="100"     how far the thumb stretches, percentage
 *   data-rs-squash="3"        landing overshoot, px
 *   data-rs-speed="1"         duration multiplier (2 = twice as fast)
 *   data-rs-axis="y"          vertical stack: the thumb travels down the group
 *   data-rs-keys="page"       the host already moves the selection with the
 *                             arrow keys; do not add a second handler
 *   data-rs-tone="light|dark" thumb colour preset
 *   data-rs-key="…"           identity kept across re-renders (see below)
 *   data-rs-aria-label="…"    accessible name if the group has none
 *
 * Hosts that rebuild the row on every filter change (a page that re-renders
 * instead of mutating its chips) replace this element, so the new one would
 * paint the thumb already seated and the stretch would never be seen. Give the
 * group a stable `data-rs-key` and the component remembers the last chip it
 * settled on under that key, then starts the next instance from there - the
 * thumb crosses the gap even though the DOM did not survive the click.
 *
 * No inline scripts or style attributes are needed: the geometry is written
 * through the CSSOM, so `script-src 'self'; style-src 'self'` needs no hash.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || window.RubberSegment) return;

  var SIZES = {
    sm: { h: 28, font: 12, pad: 10, min: 36 },
    md: { h: 36, font: 13, pad: 14, min: 44 },
    lg: { h: 44, font: 14, pad: 18, min: 48 },
  };
  var SPRING = 240;          // stiffness of the landing spring
  var REDUCE = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };
  var instances = new WeakMap();
  // One entry per data-rs-key: the chip the previous instance of that row sat
  // on. Session-scoped and tiny (a chip key per row), never persisted.
  var seats = new Map();
  var uid = 0;

  function num(el, attr, fallback) {
    var v = parseFloat(el.getAttribute(attr));
    return isFinite(v) ? v : fallback;
  }

  /* data-on is the attribute this component writes for its skin; reading it back
   * would keep the thumb on the previous chip after the page moved on. */
  function isOn(el) {
    return el.getAttribute('aria-checked') === 'true'
      || el.getAttribute('aria-selected') === 'true'
      || el.getAttribute('aria-pressed') === 'true'
      || el.classList.contains('active')
      || el.classList.contains('on');
  }

  function chipsOf(group) {
    var out = [];
    for (var i = 0; i < group.children.length; i++) {
      var el = group.children[i];
      if (el.tagName === 'BUTTON') out.push(el);
    }
    return out;
  }

  function RubberSegment(group, options) {
    if (!group || instances.has(group)) return instances.get(group);
    options = options || {};
    this.group = group;
    this.id = 'rs-' + (++uid);
    this.items = [];
    this.sel = -1;
    this.boxes = [];
    this.keys = [];
    this.left = 0;
    this.right = 0;
    this.vl = 0;
    this.vr = 0;
    this.targetL = 0;
    this.targetR = 0;
    this.squash = 0;
    this.squashSettle = 0;
    this.raf = 0;
    this.last = 0;
    this.pending = 0;

    var size = options.size || group.getAttribute('data-rs-size') || 'md';
    var s = SIZES[size] || SIZES.md;
    this.vertical = (options.axis || group.getAttribute('data-rs-axis')) === 'y';
    this.pageKeys = (options.keys || group.getAttribute('data-rs-keys')) === 'page';
    this.cfg = {
      inset: num(group, 'data-rs-inset', 3),
      radius: num(group, 'data-rs-radius', 10),
      stretch: num(group, 'data-rs-stretch', 100) / 100,
      squash: num(group, 'data-rs-squash', 3),
      speed: Math.max(0.25, num(group, 'data-rs-speed', 1)),
    };

    group.classList.add('rubber-segment');
    group.dataset.rsSize = SIZES[size] ? size : 'md';
    group.style.setProperty('--rs-h', s.h + 'px');
    group.style.setProperty('--rs-font', s.font + 'px');
    group.style.setProperty('--rs-pad', s.pad + 'px');
    group.style.setProperty('--rs-min', s.min + 'px');
    group.style.setProperty('--rs-radius', this.cfg.radius + 'px');
    var inner = Math.max(0, this.cfg.radius - this.cfg.inset);
    group.style.setProperty('--rs-thumb-radius', inner + 'px');
    if (group.getAttribute('data-rs-tone') === 'light') group.setAttribute('data-rs-tone', 'light');

    this.key = options.key || group.getAttribute('data-rs-key') || '';

    var label = options.label || group.getAttribute('data-rs-aria-label') || group.getAttribute('aria-label');
    if (label) group.setAttribute('aria-label', label);
    if (!group.hasAttribute('role')) group.setAttribute('role', 'radiogroup');

    this.thumb = document.createElement('span');
    this.thumb.className = 'rubber-segment__thumb';
    this.thumb.setAttribute('aria-hidden', 'true');
    group.insertBefore(this.thumb, group.firstChild);

    this.collect();
    this.bind();
    this.watch();
    instances.set(group, this);
    this.settle();
  }

  /* A chip's identity, for carrying the seat across a re-render: the site's own
   * data attribute when it has one, otherwise the label, which is stable for a
   * filter whose counts live in a child node. */
  function keyOf(el) {
    var attrs = ['data-id', 'data-ts', 'data-cat', 'data-order', 'data-sem', 'data-scope', 'value'];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) return attrs[i] + ':' + v;
    }
    return 'text:' + (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  RubberSegment.prototype.collect = function () {
    var items = chipsOf(this.group);
    this.items = items;
    this.keys = items.map(keyOf);
    this.boxes = items.map(function () { return { l: 0, w: 0, t: 0, h: 0 }; });
    var owns = !items.some(function (el) {
      return el.hasAttribute('aria-pressed') || el.hasAttribute('aria-selected')
        || el.hasAttribute('aria-checked') || el.getAttribute('role') === 'tab';
    });
    this.owns = owns;
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      el.classList.add('rubber-segment__chip');
      el.setAttribute('data-rs-index', String(i));
      if (owns) {
        el.setAttribute('role', 'radio');
        el.setAttribute('aria-checked', isOn(el) ? 'true' : 'false');
      }
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    }
    this.sel = this.activeIndex();
  };

  RubberSegment.prototype.activeIndex = function () {
    for (var i = 0; i < this.items.length; i++) if (isOn(this.items[i])) return i;
    return this.items.length ? 0 : -1;
  };

  RubberSegment.prototype.bind = function () {
    var self = this;

    this.group.addEventListener('click', function (event) {
      var chip = event.target.closest ? event.target.closest('.rubber-segment__chip') : null;
      if (!chip || !self.group.contains(chip)) return;
      if (self.owns) {
        self.choose(Number(chip.getAttribute('data-rs-index')));
        return;
      }
      // The page owns the state; follow whatever it says on the next frame.
      requestAnimationFrame(function () { self.sync(); });
    });

    if (this.pageKeys) return;
    this.group.addEventListener('keydown', function (event) {
      var chip = event.target.closest ? event.target.closest('.rubber-segment__chip') : null;
      if (!chip) return;
      var index = Number(chip.getAttribute('data-rs-index'));
      var count = self.items.length;
      var next = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = self.step(index, 1);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = self.step(index, -1);
      else if (event.key === 'Home') next = self.step(-1, 1);
      else if (event.key === 'End') next = self.step(count, -1);
      else if (event.key === ' ' || event.key === 'Enter') next = index;
      if (next === null) return;
      event.preventDefault();
      var target = self.items[next];
      if (!target || target.disabled) return;
      target.click();
      target.focus({ preventScroll: true });
    });
  };

  RubberSegment.prototype.step = function (from, dir) {
    var count = this.items.length;
    var index = from;
    for (var tries = 0; tries < count; tries++) {
      index = (index + dir + count) % count;
      if (this.items[index] && !this.items[index].disabled) return index;
    }
    return from;
  };

  RubberSegment.prototype.watch = function () {
    var self = this;
    this.onResize = function () { self.settle(); };
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(this.onResize);
      this.resize.observe(this.group);
    }
    window.addEventListener('resize', this.onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(this.onResize).catch(function () {});
    if (typeof MutationObserver === 'function') {
      this.observer = new MutationObserver(function (records) {
        if (records.some(function (r) { return r.type === 'childList'; })) {
          self.collect();
          self.settle();
          return;
        }
        self.sync();
      });
      this.observer.observe(this.group, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'aria-checked', 'aria-selected', 'aria-pressed', 'data-on', 'disabled', 'hidden'],
      });
    }
    if (REDUCE.addEventListener) REDUCE.addEventListener('change', function () { self.settle(); });
  };

  /* offsetLeft is already measured from the padding edge, which is the same
   * origin an absolutely positioned thumb's `left: 0` uses - subtracting the
   * padding here would shift the thumb by exactly that padding. */
  /* l/w are the extent along the axis the thumb travels (x for a row, y for a
   * stack); t/h are the cross-axis box the thumb has to cover. Keeping the
   * same four numbers in both orientations is what lets the spring, the reach
   * and the squash share one implementation. */
  RubberSegment.prototype.measure = function () {
    for (var i = 0; i < this.items.length; i++) {
      var el = this.items[i];
      this.boxes[i] = this.vertical
        ? { l: el.offsetTop, w: el.offsetHeight, t: el.offsetLeft, h: el.offsetWidth }
        : { l: el.offsetLeft, w: el.offsetWidth, t: el.offsetTop, h: el.offsetHeight };
    }
  };

  RubberSegment.prototype.sync = function () {
    var at = this.activeIndex();
    if (at < 0 || !this.group.offsetWidth) return;
    var before = this.boxes[this.sel];
    // The page may have shown or hidden a chip since the last measure (a
    // status chip that only appears once its count is known), which moves every
    // seat after it. Re-measure before deciding where the thumb belongs.
    this.measure();
    var now = this.boxes[at];
    if (at === this.sel) {
      this.restate();
      if (now && before && (now.l !== before.l || now.w !== before.w || now.t !== before.t || now.h !== before.h)) {
        this.left = now.l;
        this.right = now.l + now.w;
        this.vl = 0;
        this.vr = 0;
        this.paint();
      }
      return;
    }
    this.sel = at;
    // Hold the seat until the thumb lands. A page may update its chips in
    // place and then rebuild the row a frame later; committing the new seat
    // here would hand that rebuilt row a seat that already matches, and the
    // stretch would be cut off before anyone saw it.
    this.rememberAfter = this.keys[at];
    this.apply(at, false);
  };

  RubberSegment.prototype.remember = function () {
    if (this.key && this.keys[this.sel] !== undefined) seats.set(this.key, this.keys[this.sel]);
  };

  RubberSegment.prototype.restate = function () {
    for (var i = 0; i < this.items.length; i++) {
      var el = this.items[i];
      var on = i === this.sel;
      if (el.getAttribute('data-on') !== String(on)) el.setAttribute('data-on', on ? 'true' : 'false');
      if (this.owns && el.getAttribute('aria-checked') !== String(on)) el.setAttribute('aria-checked', on ? 'true' : 'false');
      if (this.sel >= 0) el.setAttribute('tabindex', on ? '0' : '-1');
    }
  };

  RubberSegment.prototype.choose = function (index) {
    if (index < 0 || index >= this.items.length) return;
    this.sel = index;
    this.restate();
    this.rememberAfter = this.keys[index];
    this.apply(index, false);
  };

  RubberSegment.prototype.settle = function () {
    if (!this.items.length) return;
    // A row that is built before it is inserted (or inside a hidden panel) has
    // no geometry to measure yet. Wait for it instead of committing a seat
    // measured at zero, which would cost the animation when it does appear.
    if (!this.group.isConnected || !this.group.offsetWidth) {
      var self = this;
      if (this.waiting) return;
      this.waiting = true;
      requestAnimationFrame(function () {
        self.waiting = false;
        if (self.group.isConnected && self.group.offsetWidth) self.settle();
      });
      return;
    }
    this.measure();
    if (!this.owns) this.sel = this.activeIndex();
    this.restate();
    // A re-rendered row arrives already wearing the new selection. If this row
    // had a seat under the same key and the chip still exists, start there so
    // the thumb has a gap to cross instead of appearing on the far chip.
    var was = this.key ? seats.get(this.key) : null;
    var now = this.keys[this.sel];
    if (was && now !== undefined && was !== now) {
      var at = this.keys.indexOf(was);
      var box = at >= 0 ? this.boxes[at] : null;
      if (box) {
        this.left = box.l;
        this.right = box.l + box.w;
        this.vl = 0;
        this.vr = 0;
        this.squash = 0;
        this.squashSettle = 0;
        // Hold the seat open until the thumb lands: a page that re-renders
        // twice while it settles would otherwise hand the second instance a
        // seat that already matches the new chip, and the stretch would be
        // cut off before it was seen.
        this.rememberAfter = now;
        this.apply(this.sel, false);
        return;
      }
    }
    this.remember();
    this.apply(this.sel, true);
  };

  RubberSegment.prototype.paint = function () {
    var group = this.group;
    var inset = this.cfg.inset;
    var l = Math.max(0, this.left);
    var r = Math.max(l, this.right);
    group.style.setProperty('--rs-inset', inset + 'px');
    // The thumb takes the cross-axis box of the chip it has landed on rather
    // than the group's: a row often carries a label or a bottom rule, and a
    // stack often has padding, that would otherwise stretch the thumb into a
    // lozenge behind every chip.
    var box = this.boxes[this.sel];
    if (this.vertical) {
      group.style.setProperty('--rs-y', l.toFixed(2) + 'px');
      group.style.setProperty('--rs-hh', Math.max(0, r - l).toFixed(2) + 'px');
      if (box) {
        group.style.setProperty('--rs-left', box.t + 'px');
        group.style.setProperty('--rs-thick', box.h + 'px');
      }
      return;
    }
    group.style.setProperty('--rs-x', l.toFixed(2) + 'px');
    group.style.setProperty('--rs-w', Math.max(0, r - l).toFixed(2) + 'px');
    if (box) {
      group.style.setProperty('--rs-top', box.t + 'px');
      group.style.setProperty('--rs-thigh', box.h + 'px');
    }
  };

  RubberSegment.prototype.apply = function (index, instant) {
    var box = this.boxes[index];
    if (!box) return;
    var targetL = box.l;
    var targetR = box.l + box.w;
    this.targetL = targetL;
    this.targetR = targetR;
    var jump = instant || REDUCE.matches;
    if (jump) {
      this.left = targetL;
      this.right = targetR;
      this.vl = 0;
      this.vr = 0;
      this.squash = 0;
      this.squashSettle = 0;
      this.paint();
      return;
    }
    // Stretch first: the thumb reaches across the gap before it lands. The
    // trailing edge holds its ground, so the thumb grows rather than slides.
    var dir = targetL >= this.left ? 1 : -1;
    var reach = Math.abs(targetL - this.left) + Math.abs(targetR - this.right);
    var stretch = Math.min(reach * this.cfg.stretch, this.group.clientWidth);
    if (dir > 0) {
      this.left = Math.min(this.left, targetL);
      this.right = this.right + stretch * 0.6;
    } else {
      this.right = Math.max(this.right, targetR);
      this.left = this.left - stretch * 0.6;
    }
    this.squash = dir * this.cfg.squash;
    this.squashSettle = 0;
    this.vl = 0;
    this.vr = 0;
    this.paint();
    this.start();
  };

  RubberSegment.prototype.start = function () {
    if (this.raf) return;
    var self = this;
    this.last = 0;
    var tick = function (ts) {
      var dt = self.last ? Math.min(0.05, (ts - self.last) / 1000) : 1 / 60;
      self.last = ts;
      if (self.frame(dt)) self.raf = requestAnimationFrame(tick);
      else { self.raf = 0; self.last = 0; }
    };
    this.raf = requestAnimationFrame(tick);
  };

  RubberSegment.prototype.frame = function (dt) {
    var k = SPRING;
    var critical = 2 * Math.sqrt(k);
    var speed = this.cfg.speed;
    var steps = Math.max(1, Math.round(dt * 120 * speed));
    var step = (dt * speed) / steps;
    var moving = false;
    for (var n = 0; n < steps; n++) {
      // Leading edges settle first; the trailing edge carries the squash.
      var dampL = critical;
      var dampR = critical * 1.15;
      var aL = -k * (this.left - this.targetL) - dampL * this.vl;
      var aR = -k * (this.right - this.targetR) - dampR * this.vr;
      this.vl += aL * step;
      this.vr += aR * step;
      this.left += this.vl * step;
      this.right += this.vr * step;
      if (this.squash !== 0) {
        this.squashSettle += step;
        if (this.squashSettle > 0.16 / speed) this.squash = 0;
        else this.right += this.squash * step * 6;
      }
      var doneL = Math.abs(this.left - this.targetL) < 0.05 && Math.abs(this.vl) < 0.5;
      var doneR = Math.abs(this.right - this.targetR) < 0.05 && Math.abs(this.vr) < 0.5;
      if (doneL) { this.left = this.targetL; this.vl = 0; }
      if (doneR) { this.right = this.targetR; this.vr = 0; }
      if (!doneL || !doneR || this.squash !== 0) moving = true;
    }
    this.paint();
    if (!moving && this.rememberAfter !== undefined) {
      if (this.key) seats.set(this.key, this.rememberAfter);
      this.rememberAfter = undefined;
    }
    return moving;
  };

  RubberSegment.prototype.destroy = function () {
    this.observer && this.observer.disconnect();
    this.resize && this.resize.disconnect();
    window.removeEventListener('resize', this.onResize);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.thumb.remove();
    this.group.classList.remove('rubber-segment');
    for (var i = 0; i < this.items.length; i++) {
      this.items[i].classList.remove('rubber-segment__chip');
      this.items[i].removeAttribute('data-rs-index');
      this.items[i].removeAttribute('data-on');
    }
    instances.delete(this.group);
  };

  function enhance(group, options) {
    if (!group || instances.has(group)) return instances.get(group) || null;
    if (chipsOf(group).length === 0) return null;
    return new RubberSegment(group, options);
  }

  function autoInit(root) {
    var nodes = (root || document).querySelectorAll('[data-rubber-segment]');
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  function start() {
    autoInit(document);
    if (typeof MutationObserver !== 'function') return;
    var pending = false;
    var observer = new MutationObserver(function (records) {
      if (pending) return;
      if (!records.some(function (r) { return r.type === 'childList' && r.addedNodes.length; })) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; autoInit(document); });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  window.RubberSegment = {
    enhance: enhance,
    autoInit: autoInit,
    get: function (el) { return instances.get(el) || null; },
    version: '1.0.0',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
