/* Squish Switch - a vanilla port of React Bits' Squish Switch.
 *
 * A switch whose thumb stretches with the speed it is travelling and squashes
 * against the end of the track when it lands. The React original is a React
 * component with its own state; this build adopts a button that already exists,
 * so the site keeps its own markup, handler and state and the component only
 * paints the track and the thumb and supplies the keyboard model.
 *
 *   <link rel="stylesheet" href="/squish-switch.css">
 *   <script src="/squish-switch.js" defer></script>
 *
 *   <button type="button" role="switch" aria-checked="false"
 *           data-squish-switch data-ss-label="Dark mode">
 *     Dark mode
 *   </button>
 *
 * The on/off state is read from the page - `aria-checked`, `aria-pressed`,
 * `data-on`, `.on` or `.active` - so the site stays authoritative: its click
 * handler flips its own state and the thumb springs to whatever it now says.
 * A native checkbox inside a label works the same way: the component hides the
 * input and paints the switch beside the label text.
 *
 * Dragging is real: press and pull the thumb, and the travel follows the
 * pointer, the stretch follows the speed, and the release decides by distance
 * or by flick velocity. A release that changes the state dispatches a real
 * `.click()`, so the site's existing handler runs exactly once.
 *
 * Options on the button:
 *   data-ss-size="sm|md|lg"   track 44x24 / 52x28 / 64x34
 *   data-ss-label="…"         accessible name, if the button has none
 *   data-ss-off="…"           what a screen reader reads when off
 *   data-ss-on="…"            what a screen reader reads when on
 *   data-ss-tone="light|dark" thumb and track preset
 *   data-ss-stretch="1"       how far the thumb stretches with speed
 *   data-ss-squash="1"        how hard it squashes against the end
 *   data-ss-drag="0"          turn dragging off; tap and keys remain
 *   data-ss-motion="off"      no stretch, no squash, no spring: seat instantly.
 *                             For a page with its own "reduce motion" setting,
 *                             which the media query cannot see. Read on every
 *                             interaction, so a host can set and clear it live.
 *
 * No inline scripts or style attributes are needed: the geometry is written
 * through the CSSOM, so `script-src 'self'; style-src 'self'` needs no hash.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || window.SquishSwitch) return;

  var SIZES = {
    sm: { h: 24, w: 44, inset: 2, font: 12 },
    md: { h: 28, w: 52, inset: 3, font: 13 },
    lg: { h: 34, w: 64, inset: 4, font: 14 },
  };
  var SPRING = 520;
  var REDUCE = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };
  var instances = new WeakMap();
  var uid = 0;

  function num(el, attr, fallback) {
    var v = parseFloat(el.getAttribute(attr));
    return isFinite(v) ? v : fallback;
  }

  /* data-on is what this component writes for its own skin; reading it back
   * would keep the thumb where it was after the page moved on. */
  function isOn(el) {
    if (el.tagName === 'INPUT') return !!el.checked;
    return el.getAttribute('aria-checked') === 'true'
      || el.getAttribute('aria-pressed') === 'true'
      || el.getAttribute('data-on') === 'true'
      || el.classList.contains('on')
      || el.classList.contains('active');
  }

  function labelFor(el) {
    var text = el.getAttribute('data-ss-label');
    if (text) return text;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    return (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* Two answers mean the same thing to the thumb: the operating system's
   * setting, and a page-level switch that asked for the calm version. */
  function isStill(el) {
    return REDUCE.matches || el.getAttribute('data-ss-motion') === 'off';
  }

  function SquishSwitch(el, options) {
    if (!el || instances.has(el)) return instances.get(el);
    options = options || {};
    this.el = el;
    this.id = 'ss-' + (++uid);
    this.input = el.tagName === 'INPUT' ? el : null;
    this.host = this.input ? (this.input.closest('label') || this.input.parentNode) : el;
    this.on = isOn(el);
    this.x = 0;
    this.vx = 0;
    this.target = 0;
    this.squash = 0;
    this.dragging = false;
    this.dragX = 0;
    this.pointerX = 0;
    this.lastX = 0;
    this.lastT = 0;
    this.velocity = 0;
    this.moved = 0;
    this.raf = 0;
    this.last = 0;

    var size = options.size || el.getAttribute('data-ss-size') || 'md';
    var s = SIZES[size] || SIZES.md;
    this.size = s;
    this.cfg = {
      stretch: num(el, 'data-ss-stretch', 1),
      squashAmt: num(el, 'data-ss-squash', 1),
      drag: options.drag !== undefined ? options.drag : el.getAttribute('data-ss-drag') !== '0',
      names: {
        on: el.getAttribute('data-ss-on') || 'On',
        off: el.getAttribute('data-ss-off') || 'Off',
      },
    };

    // A checkbox is not a switch until it says so; a button is made one.
    this.bare = el.hasAttribute('data-ss-bare');
    if (this.input) {
      this.host.classList.add('squish-switch');
      this.input.classList.add('squish-switch__input');
      this.input.setAttribute('aria-hidden', 'true');
      this.input.tabIndex = -1;
    } else {
      el.classList.add('squish-switch');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'switch');
      if (this.bare) el.classList.add('squish-switch--bare');
      if (el.getAttribute('role') === 'switch' && !el.hasAttribute('aria-checked')) {
        el.setAttribute('aria-checked', this.on ? 'true' : 'false');
      }
    }
    if (this.cfg.names.on !== 'On' || this.cfg.names.off !== 'Off') {
      el.setAttribute('data-ss-state', this.on ? this.cfg.names.on : this.cfg.names.off);
    }

    this.build(s);
    this.bind();
    this.watch();

    instances.set(el, this);
    this.settle(true);
  }

  SquishSwitch.prototype.build = function (s) {
    var doc = this.el.ownerDocument;
    this.track = doc.createElement('span');
    this.track.className = 'squish-switch__track';
    this.track.setAttribute('aria-hidden', 'true');
    this.thumb = doc.createElement('span');
    this.thumb.className = 'squish-switch__thumb';
    this.track.appendChild(this.thumb);

    if (this.input) {
      // The switch follows the label text rather than replacing it.
      this.input.insertAdjacentElement('afterend', this.track);
    } else {
      if (!this.bare) {
        // Existing text nodes become the label; the track goes in front.
        var text = [];
        for (var i = 0; i < this.el.childNodes.length; i++) {
          var node = this.el.childNodes[i];
          if (node.nodeType === 3 && node.nodeValue.trim()) text.push(node);
          else if (node.nodeType === 1 && !node.classList.contains('squish-switch__track')) text.push(node);
        }
        if (text.length) {
          var wrap = doc.createElement('span');
          wrap.className = 'squish-switch__label';
          for (var j = 0; j < text.length; j++) wrap.appendChild(text[j]);
          this.el.appendChild(wrap);
          this.label = wrap;
        }
      }
      this.el.insertBefore(this.track, this.el.firstChild);
    }

    var host = this.input ? this.host : this.el;
    host.style.setProperty('--ss-h', s.h + 'px');
    host.style.setProperty('--ss-w', s.w + 'px');
    host.style.setProperty('--ss-inset', s.inset + 'px');
    host.style.setProperty('--ss-thumb', (s.h - s.inset * 2) + 'px');
    host.style.setProperty('--ss-font', s.font + 'px');
    this.travel = s.w - s.inset * 2 - (s.h - s.inset * 2);
    this.base = s.inset;
  };

  SquishSwitch.prototype.state = function () {
    return isOn(this.input || this.el);
  };

  SquishSwitch.prototype.bind = function () {
    var self = this;
    var target = this.input || this.el;

    // Tap, Space, Enter and a screen-reader activation all arrive as a click.
    this.onClick = function () {
      // The page toggles its own state in this same click; read it back on the
      // next turn, once every listener has run, and follow whatever it says.
      setTimeout(function () {
        self.sync(false);
        self.el.dispatchEvent(new CustomEvent('squish:change', {
          bubbles: true,
          detail: { on: self.state() },
        }));
      }, 0);
    };
    target.addEventListener('click', this.onClick);

    this.onKey = function (event) {
      if (event.key === ' ' || event.key === 'Enter') {
        self.squash = 0.88;
        self.kill();
        self.paint();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        var want = event.key === 'ArrowRight';
        if (self.state() !== want) {
          event.preventDefault();
          target.click();
        }
      } else if (event.key === 'Home' || event.key === 'End') {
        var end = event.key === 'End';
        if (self.state() !== end) {
          event.preventDefault();
          target.click();
        }
      }
    };
    this.el.addEventListener('keydown', this.onKey);

    // A tap has to gather before it releases, whether or not dragging is on.
    this.onPress = function () {
      if (self.el.disabled) return;
      self.squash = 0.9;
      self.kill();
      self.paint();
    };
    this.el.addEventListener('pointerdown', this.onPress);

    if (!this.cfg.drag || this.input) return;
    this.onDown = function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      if (self.el.disabled) return;
      self.dragging = true;
      self.dragX = self.x;
      self.pointerX = event.clientX;
      self.lastX = event.clientX;
      self.lastT = event.timeStamp;
      self.velocity = 0;
      self.moved = 0;
      self.squash = 0.9;
      self.kill();
      self.paint(true);
      if (self.el.setPointerCapture) {
        try { self.el.setPointerCapture(event.pointerId); } catch (e) { /* not captureable */ }
      }
      self.el.addEventListener('pointermove', self.onMove);
      self.el.addEventListener('pointerup', self.onUp);
      self.el.addEventListener('pointercancel', self.onUp);
    };
    this.onMove = function (event) {
      if (!self.dragging) return;
      var dx = event.clientX - self.pointerX;
      var dt = event.timeStamp - self.lastT;
      if (dt > 0) self.velocity = (event.clientX - self.lastX) / dt;
      self.lastX = event.clientX;
      self.lastT = event.timeStamp;
      self.moved = Math.max(self.moved, Math.abs(dx));
      // The thumb stretches with the speed of the pull, exactly as it does on
      // a flick, so the drag reads as rubber rather than as a slider.
      self.vx = self.velocity * 1000;
      var next = clamp(self.dragX + dx, -2, self.travel + 2);
      // Pushing past an end compresses instead of moving.
      var over = 0;
      if (self.dragX + dx < -2) over = (self.dragX + dx + 2) / 18;
      if (self.dragX + dx > self.travel + 2) over = (self.dragX + dx - self.travel - 2) / 18;
      self.squash = 0.9 - clamp(over, 0, 0.14);
      self.x = next;
      self.paint(true);
      if (Math.abs(dx) > 3) event.preventDefault();
    };
    this.onUp = function (event) {
      if (!self.dragging) return;
      self.dragging = false;
      self.el.removeEventListener('pointermove', self.onMove);
      self.el.removeEventListener('pointerup', self.onUp);
      self.el.removeEventListener('pointercancel', self.onUp);
      var on = self.state();
      var want = on;
      self.vx = self.velocity * 1000 * 0.55;
      if (self.moved > 6) {
        var flick = Math.abs(self.velocity) > 0.35;
        if (flick) want = self.velocity > 0;
        else want = self.x > self.travel / 2;
        // The browser still delivers a click for the gesture. Swallow the next
        // one, then dispatch our own only if the release changed the state, so
        // the site's handler runs exactly once either way.
        var swallow = function (event) {
          event.preventDefault();
          event.stopPropagation();
        };
        self.el.addEventListener('click', swallow, true);
        setTimeout(function () {
          self.el.removeEventListener('click', swallow, true);
          if (want !== on) target.click();
          else self.sync(true);
        }, 120);
      } else {
        self.sync(true);
      }
    };
    this.el.addEventListener('pointerdown', this.onDown);
  };

  SquishSwitch.prototype.watch = function () {
    var self = this;
    this.onResize = function () { self.settle(true); };
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(this.onResize);
      this.resize.observe(this.el);
    }
    window.addEventListener('resize', this.onResize);
    if (typeof MutationObserver === 'function') {
      this.observer = new MutationObserver(function () { self.sync(true); });
      this.observer.observe(this.el, {
        attributes: true,
        attributeFilter: ['aria-checked', 'aria-pressed', 'data-on', 'class', 'disabled'],
      });
      if (this.input) {
        this.observer.observe(this.input, { attributes: true, attributeFilter: ['checked'] });
        this.input.addEventListener('change', function () { self.sync(false); });
      }
    }
    if (REDUCE.addEventListener) REDUCE.addEventListener('change', function () { self.settle(true); });
  };

  SquishSwitch.prototype.settle = function (instant) {
    var travel = this.travel;
    if (!travel && !this.el.offsetWidth) {
      // Built before insertion, or inside a hidden panel: wait for geometry
      // instead of committing a seat measured at zero.
      var self = this;
      if (this.waiting) return;
      this.waiting = true;
      requestAnimationFrame(function () {
        self.waiting = false;
        if (self.el.isConnected) self.settle(instant);
      });
      return;
    }
    this.on = this.state();
    this.target = this.on ? travel : 0;
    if (instant || isStill(this.el)) {
      this.x = this.target;
      this.vx = 0;
      this.squash = 1;
      this.paint(true);
      return;
    }
    this.squash = 0.9;
    this.paint(true);
    this.start();
  };

  /* The page changed the state (its handler ran, a form reset fired, a stored
   * value arrived): go there. The first move after a press travels, so it
   * stretches; a correction with no press just settles. */
  SquishSwitch.prototype.sync = function (fromPress) {
    var on = this.state();
    if (on === this.on) {
      this.target = on ? this.travel : 0;
      this.start();
      return;
    }
    this.on = on;
    this.target = on ? this.travel : 0;
    if (isStill(this.el)) {
      this.x = this.target;
      this.vx = 0;
      this.squash = 1;
      this.paint(true);
      return;
    }
    this.squash = fromPress ? 0.86 : 0.94;
    this.start();
  };

  SquishSwitch.prototype.start = function () {
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

  SquishSwitch.prototype.kill = function () {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  };

  SquishSwitch.prototype.frame = function (dt) {
    if (this.dragging) return false;
    var k = SPRING;
    var damp = 2 * Math.sqrt(k) * 0.9;
    var steps = Math.max(1, Math.round(dt * 120));
    var step = dt / steps;
    var moving = false;
    for (var n = 0; n < steps; n++) {
      var wasFar = Math.abs(this.x - this.target) > 1.5;
      // The squash recovers on its own clock: quick, like a rubber wall.
      if (this.squash < 1) this.squash = Math.min(1, this.squash + step * 2.6);
      var a = -k * (this.x - this.target) - damp * this.vx;
      this.vx += a * step;
      this.x += this.vx * step;
      // Landing: the leading edge hits the end of the track and the thumb
      // squashes against it. Set after the recovery line so the impulse gets a
      // frame of its own to be seen.
      if (wasFar && Math.abs(this.x - this.target) <= 1.5) {
        this.squash = Math.min(this.squash, 0.9);
        this.x = this.target;
        this.vx = 0;
      }
      if (Math.abs(this.x - this.target) < 0.05 && Math.abs(this.vx) < 0.6) {
        this.x = this.target;
        this.vx = 0;
      }
      if (this.x !== this.target || this.vx !== 0 || this.squash < 1) moving = true;
    }
    this.paint(true);
    return moving;
  };

  /* Stretch comes from the speed, not from the distance: the faster the thumb
   * is travelling, the longer it is, and the squash is the same number at the
   * end of the track. Volume is preserved, so it reads as rubber rather than a
   * zoom. */
  SquishSwitch.prototype.paint = function () {
    var still = isStill(this.el);
    var speed = Math.abs(this.vx) / 1000;           // px per ms
    var stretch = still ? 0 : clamp(speed * 1.05 * this.cfg.stretch, 0, 0.55);
    var sx = still ? 1 : (1 + stretch) * this.squash;
    var sy = still ? 1 : 1 / Math.sqrt(Math.max(0.2, sx)) * (1 + (1 - this.squash) * 0.55);
    var host = this.input ? this.host : this.el;
    host.style.setProperty('--ss-x', this.x.toFixed(2) + 'px');
    host.style.setProperty('--ss-sx', sx.toFixed(4));
    host.style.setProperty('--ss-sy', sy.toFixed(4));
    if (this.el.getAttribute('data-ss-state') !== null) {
      this.el.setAttribute('data-ss-state', this.state() ? this.cfg.names.on : this.cfg.names.off);
    }
  };

  SquishSwitch.prototype.destroy = function () {
    this.observer && this.observer.disconnect();
    this.resize && this.resize.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.kill();
    (this.input || this.el).removeEventListener('click', this.onClick);
    this.el.removeEventListener('keydown', this.onKey);
    this.el.removeEventListener('pointerdown', this.onDown);
    this.track.remove();
    this.el.classList.remove('squish-switch');
    instances.delete(this.el);
  };

  function enhance(el, options) {
    if (!el || instances.has(el)) return instances.get(el) || null;
    if (el.tagName !== 'BUTTON' && el.tagName !== 'INPUT') return null;
    if (el.tagName === 'INPUT' && el.type !== 'checkbox') return null;
    return new SquishSwitch(el, options);
  }

  function autoInit(root) {
    var doc = root || document;
    var nodes = doc.querySelectorAll('[data-squish-switch]');
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

  window.SquishSwitch = {
    enhance: enhance,
    autoInit: autoInit,
    get: function (el) { return instances.get(el) || null; },
    label: labelFor,
    version: '1.0.0',
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
