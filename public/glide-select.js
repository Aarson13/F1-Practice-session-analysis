/* GlideSelect — a vanilla port of React Bits' GlideSelect.
 *
 * A chip opens a pill menu; the highlight glides to the hovered row and the
 * chosen value is written back to a native <select> (or <sl-select>), so the
 * page's existing wiring — its change handlers, its stored filters, its form
 * submission — keeps working untouched.
 *
 * Usage, no build step:
 *
 *   <link rel="stylesheet" href="/glide-select.css">
 *   <script src="/glide-select.js" defer></script>
 *   <select id="week" data-glide>…</select>
 *
 * Anything carrying `data-glide` is enhanced on load, and again whenever it is
 * added to the page later (a filter row that re-renders, a form opened on
 * demand). Optional attributes:
 *
 *   data-glide-size="sm|md|lg"        chip height (28/32/44 px)
 *   data-glide-label="Week"           the chip's accessible name
 *   data-glide-placeholder="Pick…"    shown when nothing is selected
 *   data-glide-menu-width="220"       menu min-width in px
 *   data-glide-side="top|bottom"      preferred opening side
 *
 * No inline styles are written to the document by the page author and no
 * inline script is required, so a `script-src 'self'; style-src 'self'`
 * policy needs no hash and no 'unsafe-inline'.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || window.GlideSelect) return;

  var SIZES = { sm: { chip: 28, row: 26, font: 12 }, md: { chip: 32, row: 30, font: 13 }, lg: { chip: 44, row: 40, font: 14 } };
  var NATIVE = 'glide-select-native';
  var uid = 0;
  var instances = new WeakMap();

  function textOf(node) {
    return (node.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function optionsOf(el) {
    var out = [];
    if (el.tagName === 'SELECT') {
      for (var i = 0; i < el.options.length; i++) {
        var o = el.options[i];
        out.push({
          value: o.value,
          label: textOf(o),
          tag: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '',
        });
      }
    } else {
      var opts = el.querySelectorAll('sl-option, option');
      for (var k = 0; k < opts.length; k++) {
        out.push({ value: opts[k].getAttribute('value') || '', label: textOf(opts[k]), tag: '' });
      }
    }
    return out;
  }

  function labelFor(el) {
    var attr = el.getAttribute('label');
    if (attr) return attr;
    var labelled = el.getAttribute('aria-label');
    if (labelled) return labelled;
    var id = el.id;
    if (id) {
      var label = document.querySelector('label[for="' + id.replace(/"/g, '\\"') + '"]');
      if (label) return textOf(label);
    }
    return 'Select';
  }

  function icon(kind) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'glide-select__glyph');
    var path = document.createElementNS(ns, 'path');
    path.setAttribute('d', kind === 'check' ? 'M20 6 9 17l-5-5' : 'm6 9 6 6 6-6');
    svg.appendChild(path);
    return svg;
  }

  function GlideSelect(el, opts) {
    if (!el || instances.has(el)) return instances.get(el);
    opts = opts || {};
    this.el = el;
    this.opts = opts;
    this.id = 'gs-' + (++uid);
    this.items = [];
    this.selected = -1;
    this.active = null;
    this.phase = 'closed';
    this.instant = false;
    this.scrub = null;
    this.closeTimer = 0;

    var size = opts.size || el.getAttribute('data-glide-size') || 'md';
    this.size = SIZES[size] || SIZES.md;

    this.root = document.createElement('span');
    this.root.className = 'glide-select';
    this.root.dataset.size = SIZES[size] ? size : 'md';
    this.root.style.setProperty('--gs-chip', this.size.chip + 'px');
    this.root.style.setProperty('--gs-row', this.size.row + 'px');
    this.root.style.setProperty('--gs-font', this.size.font + 'px');
    var width = opts.menuWidth || el.getAttribute('data-glide-menu-width');
    if (width) this.root.style.setProperty('--gs-menu-w', /^\d+$/.test(String(width)) ? width + 'px' : width);

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'glide-select__trigger';
    this.trigger.id = this.id + '-trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-controls', this.id + '-list');
    this.trigger.setAttribute('aria-label', opts.label || labelFor(el));

    var caption = opts.caption || el.getAttribute('data-glide-caption');
    if (caption) {
      this.caption = document.createElement('span');
      this.caption.className = 'glide-select__caption';
      this.caption.textContent = caption;
      this.root.appendChild(this.caption);
    }

    this.label = document.createElement('span');
    this.label.className = 'glide-select__label';
    var chevron = document.createElement('span');
    chevron.className = 'glide-select__chevron';
    chevron.appendChild(icon('chevron'));
    this.trigger.appendChild(this.label);
    this.trigger.appendChild(chevron);

    this.menu = document.createElement('div');
    this.menu.className = 'glide-select__menu';
    this.menu.dataset.state = 'closed';
    this.menu.dataset.side = opts.placement || el.getAttribute('data-glide-side') || 'bottom';
    this.menu.dataset.align = 'left';
    this.list = document.createElement('div');
    this.list.className = 'glide-select__list';
    this.list.id = this.id + '-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', this.trigger.getAttribute('aria-label'));
    this.pill = document.createElement('span');
    this.pill.className = 'glide-select__pill';
    this.pill.setAttribute('aria-hidden', 'true');
    this.list.appendChild(this.pill);
    this.menu.appendChild(this.list);

    this.root.appendChild(this.trigger);
    this.root.appendChild(this.menu);

    // The native control stays in the DOM — it is the value the rest of the
    // page reads — but out of the flow, so the chip occupies its place.
    el.classList.add(NATIVE);
    el.setAttribute('tabindex', '-1');
    el.setAttribute('aria-hidden', 'true');
    el.parentNode.insertBefore(this.root, el);
    if (el.hidden || el.style.display === 'none') this.root.hidden = true;

    this.bind();
    this.refresh();
    this.watch();
    instances.set(el, this);
  }

  GlideSelect.prototype.bind = function () {
    var self = this;

    this.trigger.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || self.trigger.disabled) return;
      e.preventDefault();
      // Chrome counts a focus() made from a pointer handler as :focus-visible,
      // which would leave a keyboard ring on a mouse-opened menu. The marker is
      // dropped on blur or on the first key press, so real keyboard focus still
      // gets its ring.
      self.root.dataset.pointerFocus = '';
      self.trigger.focus({ preventScroll: true });
      if (self.phase === 'open') self.close('pop');
      else self.open(false);
    });

    this.trigger.addEventListener('keydown', function (e) {
      delete self.root.dataset.pointerFocus;
      self.onKey(e);
    });

    this.trigger.addEventListener('blur', function () { delete self.root.dataset.pointerFocus; });

    this.list.addEventListener('pointerover', function (e) {
      if (e.pointerType === 'touch' || self.scrub) return;
      var row = e.target.closest && e.target.closest('[data-index]');
      if (!row) return;
      var i = Number(row.dataset.index);
      if (i !== self.active) self.setActive(i);
    });

    this.list.addEventListener('pointerdown', function (e) {
      if (self.scrub || e.button !== 0) return;
      try { self.list.setPointerCapture(e.pointerId); } catch (_) {}
      self.scrub = { id: e.pointerId };
      self.instant = true;
      self.setActive(self.rowAt(e.clientY));
    });

    this.list.addEventListener('pointermove', function (e) {
      if (!self.scrub || self.scrub.id !== e.pointerId) return;
      var i = self.rowAt(e.clientY);
      if (i !== self.active) self.setActive(i);
    });

    var end = function (e) {
      if (!self.scrub || self.scrub.id !== e.pointerId) return;
      var i = e.type === 'pointerup' ? self.rowAt(e.clientY) : null;
      self.scrub = null;
      if (i !== null) self.pick(i, false);
    };
    this.list.addEventListener('pointerup', end);
    this.list.addEventListener('pointercancel', end);
    this.list.addEventListener('lostpointercapture', end);

    this.list.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('[data-index]');
      if (!row || self.scrub) return;
      self.pick(Number(row.dataset.index), false);
    });

    // A label written for the native control now names the chip instead, so
    // clicking it opens the menu rather than focusing a hidden element.
    if (this.el.id) {
      var labels = document.querySelectorAll('label[for="' + this.el.id.replace(/"/g, '\\"') + '"]');
      for (var i = 0; i < labels.length; i++) {
        (function (lab) {
          lab.addEventListener('click', function (e) {
            e.preventDefault();
            self.trigger.focus();
            self.open(false);
          });
        })(labels[i]);
      }
    }

    this.onDocDown = function (e) {
      if (!self.root.contains(e.target) && self.el !== e.target) self.close('pop');
    };
    // The menu itself scrolls when a control has many options (weeks, genres);
    // only a scroll from outside it means the chip has moved away from the menu.
    this.onScroll = function (e) {
      if (self.phase !== 'open') return;
      if (e && e.target && e.target.nodeType === 1 && self.menu.contains(e.target)) return;
      self.close('instant');
    };

    this.el.addEventListener('change', function () { self.refresh(); });
    this.el.addEventListener('sl-change', function () { self.refresh(); });
  };

  // Keep the chip in step with a value written by the page, e.g. a restored
  // filter or a shareable URL. The interceptor delegates to the element's own
  // accessors so nothing about the control itself changes.
  GlideSelect.prototype.watchValue = function () {
    var el = this.el;
    var proto = el;
    var desc = null;
    while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
    if (!desc || !desc.get || !desc.set) return;
    var self = this;
    try {
      Object.defineProperty(el, 'value', {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () { return desc.get.call(this); },
        set: function (v) { desc.set.call(this, v); self.refresh(); },
      });
    } catch (_) { /* a frozen element keeps its value; change events still sync */ }
  };

  GlideSelect.prototype.watch = function () {
    var self = this;
    this.watchValue();

    var rebuild = function () { self.refresh(); };
    if (typeof MutationObserver === 'function') {
      this.optionObserver = new MutationObserver(rebuild);
      this.optionObserver.observe(this.el, { childList: true, subtree: true, characterData: true });
      this.stateObserver = new MutationObserver(function () {
        // The page may hide the native control too (a split-payment toggle
        // swaps it for rows); the chip has to leave with it.
        self.root.hidden = self.el.hidden || self.el.style.display === 'none';
        self.trigger.disabled = self.el.disabled === true;
        self.root.toggleAttribute('data-disabled', self.el.disabled === true);
      });
      this.stateObserver.observe(this.el, { attributes: true, attributeFilter: ['disabled', 'hidden', 'style'] });
    }
    this.trigger.disabled = this.el.disabled === true;
    this.root.toggleAttribute('data-disabled', this.el.disabled === true);

    // Shoelace (and any lazy custom element) defines its value property after
    // the script runs; once it is defined, read the value the page sees.
    if (this.el.tagName !== 'SELECT') {
      this.settle();
      if (window.customElements && window.customElements.whenDefined) {
        var self2 = this;
        window.customElements.whenDefined(this.el.tagName.toLowerCase()).then(function () {
          self2.refresh();
        }, function () {});
      }
    }
  };

  // A lazy custom element (Shoelace) takes a moment to upgrade and adopt its
  // `value` attribute. Until it reports a value, re-read it a few times so the
  // chip shows the selected row rather than the placeholder.
  GlideSelect.prototype.settle = function () {
    var self = this;
    var tries = 0;
    (function tick() {
      if (!self.el.isConnected) return;
      self.refresh();
      // A lazy element upgrades in stages: it can report a value, then lose it
      // for a frame while its options adopt their own values. Watch it through
      // that window instead of trusting the first non-empty read.
      if (++tries > 20) return;
      setTimeout(tick, 60);
    })();
  };

  GlideSelect.prototype.currentValue = function () {
    var value = this.el.value;
    // A custom element that has not upgraded yet reports no value even though
    // its `value` attribute is set; the attribute is the truth until it does.
    if ((value === '' || value == null) && this.el.tagName !== 'SELECT') {
      value = this.el.getAttribute('value') || '';
    }
    return value;
  };

  GlideSelect.prototype.refresh = function () {
    this.items = optionsOf(this.el);
    this.selected = this.el.tagName === 'SELECT' && this.el.selectedIndex != null
      ? this.el.selectedIndex
      : indexOf(this.items, this.currentValue());

    var current = this.items[this.selected];
    this.label.textContent = current ? current.label : (this.el.getAttribute('data-glide-placeholder') || this.el.getAttribute('placeholder') || 'Select…');
    this.label.toggleAttribute('data-empty', !current);

    var rows = this.list.querySelectorAll('.glide-select__option');
    for (var i = 0; i < rows.length; i++) rows[i].remove();

    var frag = document.createDocumentFragment();
    for (var k = 0; k < this.items.length; k++) frag.appendChild(this.row(this.items[k], k));
    this.list.appendChild(frag);

    if (this.phase === 'open') this.place();
    this.render();
  };

  GlideSelect.prototype.row = function (item, i) {
    var row = document.createElement('div');
    row.className = 'glide-select__option';
    row.id = this.id + '-' + i;
    row.dataset.index = String(i);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', i === this.selected ? 'true' : 'false');

    var name = document.createElement('span');
    name.className = 'glide-select__name';
    name.textContent = item.label;
    row.appendChild(name);

    if (item.tag) {
      var tag = document.createElement('span');
      tag.className = 'glide-select__tag';
      tag.textContent = item.tag;
      row.appendChild(tag);
    }

    var check = document.createElement('span');
    check.className = 'glide-select__check';
    check.setAttribute('aria-hidden', 'true');
    check.toggleAttribute('data-on', i === this.selected);
    check.appendChild(icon('check'));
    row.appendChild(check);
    return row;
  };

  function indexOf(items, value) {
    for (var i = 0; i < items.length; i++) if (items[i].value === value) return i;
    return -1;
  }

  GlideSelect.prototype.render = function () {
    var rows = this.list.querySelectorAll('.glide-select__option');
    for (var i = 0; i < rows.length; i++) {
      rows[i].setAttribute('aria-selected', i === this.selected ? 'true' : 'false');
      var check = rows[i].querySelector('.glide-select__check');
      if (check) check.toggleAttribute('data-on', i === this.selected);
    }
    this.list.toggleAttribute('data-live', this.active !== null);
    this.trigger.setAttribute('aria-expanded', this.phase === 'open' ? 'true' : 'false');
    if (this.phase === 'open' && this.active !== null) {
      this.trigger.setAttribute('aria-activedescendant', this.id + '-' + this.active);
      var row = this.list.querySelector('[data-index="' + this.active + '"]');
      if (row) {
        var mr = this.menu.getBoundingClientRect();
        var rr = row.getBoundingClientRect();
        if (rr.top < mr.top) this.menu.scrollTop -= mr.top - rr.top;
        else if (rr.bottom > mr.bottom) this.menu.scrollTop += rr.bottom - mr.bottom;
        // A menu scrolled by hand can stop halfway through a row; the list is a
        // grid of equal rows, so snap its scroll to a row boundary and no
        // option is left sliced under the top edge.
        var all = this.list.querySelectorAll('.glide-select__option');
        var step = all.length > 1 ? all[1].offsetTop - all[0].offsetTop : 0;
        if (step > 0 && this.menu.scrollTop > 0) {
          this.menu.scrollTop = 4 + Math.round((this.menu.scrollTop - 4) / step) * step;
        }
      }
    } else {
      this.trigger.removeAttribute('aria-activedescendant');
    }
  };

  GlideSelect.prototype.movePill = function (index, instant) {
    var row = this.list.querySelector('[data-index="' + index + '"]');
    var jump = instant || this.pill.style.opacity !== '1';
    this.pill.style.transitionDuration = jump ? '0ms, 150ms' : '';
    if (!row) {
      this.pill.style.opacity = '0';
      return;
    }
    this.pill.style.transform = 'translateY(' + row.offsetTop + 'px)';
    this.pill.style.opacity = '1';
  };

  GlideSelect.prototype.place = function () {
    var r = this.root.getBoundingClientRect();
    var need = this.menu.offsetHeight + 6;
    var preferred = this.root.dataset.side === 'top' ? 'top' : 'bottom';
    var side = preferred;
    if (preferred === 'bottom' && r.bottom + need > window.innerHeight && r.top - need > 0) side = 'top';
    if (preferred === 'top' && r.top - need < 0) side = 'bottom';
    this.menu.dataset.side = side;
    var align = this.opts && this.opts.align ? this.opts.align : 'left';
    if (align === 'auto') {
      align = r.left + this.menu.offsetWidth > window.innerWidth - 8 ? 'right' : 'left';
    }
    this.menu.dataset.align = align;
  };

  GlideSelect.prototype.open = function (viaKey) {
    if (this.trigger.disabled) return;
    this.refresh();
    clearTimeout(this.closeTimer);
    var first = this.selected >= 0 ? this.selected : (viaKey ? 0 : null);
    this.active = first;
    this.instant = true;
    this.phase = 'open';
    this.menu.style.display = '';
    this.menu.dataset.state = 'closed';
    this.root.dataset.open = '';
    this.render();
    this.place();
    // Force a style flush so the pop transition runs from its closed state.
    void this.menu.offsetHeight;
    this.menu.dataset.state = 'open';
    this.movePill(this.active === null ? this.selected : this.active, true);
    this.instant = false;
    document.addEventListener('pointerdown', this.onDocDown, true);
    window.addEventListener('scroll', this.onScroll, true);
    window.addEventListener('resize', this.onScroll);
  };

  GlideSelect.prototype.close = function (mode) {
    if (this.phase === 'closed') return;
    this.active = null;
    this.scrub = null;
    clearTimeout(this.closeTimer);
    document.removeEventListener('pointerdown', this.onDocDown, true);
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onScroll);
    this.root.removeAttribute('data-open');
    this.phase = mode === 'instant' ? 'closed' : 'closing';
    this.render();
    if (mode === 'instant') {
      this.menu.dataset.state = 'closed';
      this.menu.style.display = 'none';
      return;
    }
    this.menu.dataset.state = 'closed';
    var self = this;
    this.closeTimer = setTimeout(function () {
      self.phase = 'closed';
      self.menu.style.display = 'none';
    }, 140);
  };

  GlideSelect.prototype.setActive = function (index) {
    if (index === this.active) return;
    this.active = index;
    this.movePill(index, this.instant);
    this.instant = false;
    this.render();
  };

  GlideSelect.prototype.rowAt = function (y) {
    var rows = this.list.querySelectorAll('.glide-select__option');
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return i;
    }
    return null;
  };

  GlideSelect.prototype.pick = function (i, viaKey) {
    var item = this.items[i];
    if (!item) { this.close('instant'); return; }
    if (item.value !== this.el.value) {
      this.el.value = item.value;
      this.el.dispatchEvent(new Event('change', { bubbles: true }));
      if (this.el.tagName !== 'SELECT') {
        this.el.dispatchEvent(new CustomEvent('sl-change', { bubbles: true }));
      }
      if (!viaKey) {
        this.root.dataset.swap = '';
        var self = this;
        this.root.addEventListener('animationend', function once() {
          delete self.root.dataset.swap;
          self.root.removeEventListener('animationend', once);
        });
      }
    }
    this.refresh();
    this.close('instant');
    this.trigger.focus({ preventScroll: true });
  };

  GlideSelect.prototype.onKey = function (e) {
    var k = e.key;
    var n = this.items.length;
    var cur = this.active === null ? Math.max(0, this.selected) : this.active;

    if (this.phase !== 'open') {
      if (k === 'Enter' || k === ' ' || k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        this.open(true);
      }
      return;
    }

    var go = function (i) {
      e.preventDefault();
      var next = Math.min(n - 1, Math.max(0, i));
      this.instant = true;
      this.setActive(next);
    }.bind(this);

    if (k === 'ArrowDown' || k === 'ArrowUp') go(this.active === null ? cur : cur + (k === 'ArrowDown' ? 1 : -1));
    else if (k === 'Home' || k === 'End') go(k === 'Home' ? 0 : n - 1);
    else if (k === 'PageDown' || k === 'PageUp') go(cur + (k === 'PageDown' ? 8 : -8));
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); this.pick(cur, true); }
    else if (k === 'Escape' || k === 'Tab') {
      if (k === 'Escape') e.preventDefault();
      this.close('instant');
    } else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      var c = k.toLowerCase();
      for (var step = 1; step <= n; step++) {
        var idx = (cur + step) % n;
        var it = this.items[idx];
        if (it && it.label.toLowerCase().indexOf(c) === 0) { go(idx); break; }
      }
    }
  };

  GlideSelect.prototype.destroy = function () {
    this.optionObserver && this.optionObserver.disconnect();
    this.stateObserver && this.stateObserver.disconnect();
    this.root.remove();
    this.el.classList.remove(NATIVE);
    this.el.removeAttribute('aria-hidden');
    this.el.removeAttribute('tabindex');
    instances.delete(this.el);
  };

  function enhance(el, opts) {
    if (!el || instances.has(el)) return instances.get(el) || null;
    if (el.tagName !== 'SELECT' && el.tagName !== 'SL-SELECT') return null;
    if (!el.parentNode) return null;
    if (optionsOf(el).length === 0) {
      // A control filled later (a filter row whose options arrive with data)
      // is picked up by the observer below once it has something to show.
      return null;
    }
    return new GlideSelect(el, opts);
  }

  function autoInit(root) {
    var nodes = (root || document).querySelectorAll('[data-glide]');
    for (var i = 0; i < nodes.length; i++) enhance(nodes[i]);
  }

  function start() {
    autoInit(document);
    if (typeof MutationObserver !== 'function') return;
    var pending = false;
    var observer = new MutationObserver(function (records) {
      if (pending) return;
      var relevant = records.some(function (r) {
        if (r.type === 'childList' && r.addedNodes.length) return true;
        return r.target && r.target.nodeType === 1 && r.target.matches && r.target.matches('[data-glide]');
      });
      if (!relevant) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; autoInit(document); });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: false,
    });
  }

  window.GlideSelect = { enhance: enhance, autoInit: autoInit, get: function (el) { return instances.get(el) || null; }, version: '1.0.0' };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
