/* Stepper - a numeric −/+ control whose digits roll.
 *
 *   Stepper.attach(input, {
 *     min: 1, max: 31, step: 1,
 *     label: 'Day of month', unit: 'day',
 *     onChange: function (value) { ... }
 *   });
 *
 *   Stepper.mount(container, { value: 10, min: 1, max: 20, label: 'Drivers' });
 *
 * attach() keeps the native input as the source of truth: it hides the input,
 * builds the visible control beside it, and writes every change back through
 * input.value plus an input and a change event. A host that already reads the
 * field on submit needs no other change. mount() builds the control from
 * scratch in a container.
 *
 * The value is an integer. The display is right-aligned in a slot wide enough
 * for max, so the − and + buttons never move as the number grows; only the
 * digits that changed roll. Buttons, Arrow keys, Home/End, PageUp/PageDown and
 * typing a number on the focused value all work. The native input's min, max,
 * step and disabled state are followed; its label names the spinbutton.
 *
 * CSP-safe: no injected stylesheet, no inline style in markup, no network. It
 * writes classes, attributes and custom properties only.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var STATE = '__stpState';
  var seq = 0;
  var DEFAULTS = {
    min: 0,
    max: 99,
    step: 1,
    label: 'Value',
    unit: '',
    unitPlural: '',
    size: 'md',
    disabled: false,
    onChange: null,
    value: null
  };

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function numberFrom(node, name, fallback) {
    if (!node) return fallback;
    var raw = node.getAttribute(name);
    if (raw === null || raw === '') return fallback;
    var n = Number(raw);
    return isFinite(n) ? n : fallback;
  }

  function normalise(n, s) {
    if (!isFinite(n)) n = s.min;
    n = Math.round(n);
    n = clamp(n, s.min, s.max);
    var steps = Math.round((n - s.min) / s.step);
    n = s.min + steps * s.step;
    return clamp(Math.round(n), s.min, s.max);
  }

  function unitFor(n, cfg) {
    if (!cfg.unit) return '';
    if (cfg.unitPlural) return n === 1 ? cfg.unit : cfg.unitPlural;
    return n === 1 ? cfg.unit : cfg.unit + 's';
  }

  function labelFor(input, cfg) {
    if (cfg.label && cfg.label !== DEFAULTS.label) return cfg.label;
    if (!input) return cfg.label;
    var aria = input.getAttribute('aria-label');
    if (aria) return aria.trim();
    var labelledby = input.getAttribute('aria-labelledby');
    if (labelledby) {
      var by = doc.getElementById(labelledby.split(/\s+/)[0]);
      if (by && by.textContent.trim()) return by.textContent.trim();
    }
    if (input.labels && input.labels.length) {
      var text = input.labels[0].textContent.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
    if (input.id) {
      var label = doc.querySelector('label[for="' + input.id.replace(/"/g, '\\"') + '"]');
      if (label) return label.textContent.replace(/\s+/g, ' ').trim();
    }
    return cfg.label;
  }

  function makeEl(tag, cls, text) {
    var el = doc.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function build(s) {
    var root = makeEl('div', 'stp');
    root.setAttribute('data-stp-size', s.cfg.size);
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', s.cfg.label);

    var dec = makeEl('button', 'stp-btn stp-dec');
    dec.type = 'button';
    dec.setAttribute('aria-label', 'Decrease ' + s.cfg.label);
    dec.appendChild(makeEl('span', 'stp-glyph', '\u2212'));
    dec.firstChild.setAttribute('aria-hidden', 'true');

    var value = makeEl('div', 'stp-value');
    value.setAttribute('role', 'spinbutton');
    value.setAttribute('tabindex', '0');
    value.setAttribute('aria-label', s.cfg.label);

    var digits = makeEl('span', 'stp-digits');
    digits.setAttribute('aria-hidden', 'true');
    var unit = makeEl('span', 'stp-unit');
    unit.setAttribute('aria-hidden', 'true');
    value.appendChild(digits);
    value.appendChild(unit);

    var inc = makeEl('button', 'stp-btn stp-inc');
    inc.type = 'button';
    inc.setAttribute('aria-label', 'Increase ' + s.cfg.label);
    inc.appendChild(makeEl('span', 'stp-glyph', '+'));
    inc.firstChild.setAttribute('aria-hidden', 'true');

    var sr = makeEl('span', 'stp-sr');
    sr.setAttribute('role', 'status');
    sr.setAttribute('aria-live', 'polite');

    root.appendChild(dec);
    root.appendChild(value);
    root.appendChild(inc);
    root.appendChild(sr);
    s.root = root;
    s.dec = dec;
    s.inc = inc;
    s.valueEl = value;
    s.digitsEl = digits;
    s.unitEl = unit;
    s.sr = sr;
    s.announceTimer = null;
  }

  function announce(s) {
    clearTimeout(s.announceTimer);
    s.announceTimer = setTimeout(function () {
      var unit = unitFor(s.value, s.cfg);
      s.sr.textContent = s.cfg.label + ': ' + s.value + (unit ? ' ' + unit : '');
    }, 280);
  }

  function setBusy(s, busy) {
    s.root.setAttribute('data-stp-busy', busy ? 'true' : 'false');
  }

  function columnFor(ch) {
    var col = makeEl('span', 'stp-col');
    col.setAttribute('data-d', ch);
    col.appendChild(makeEl('span', 'stp-d stp-cur', ch));
    col.appendChild(makeEl('span', 'stp-d stp-old', ''));
    return col;
  }

  function renderDigits(s, direction, animate) {
    var text = String(s.value);
    var chars = text.split('');
    var cols = s.digitsEl.children;
    var canRoll = animate && !reduced() && cols.length === chars.length;

    if (!canRoll) {
      s.digitsEl.textContent = '';
      for (var i = 0; i < chars.length; i++) s.digitsEl.appendChild(columnFor(chars[i]));
      if (animate && !reduced()) {
        s.digitsEl.classList.remove('stp-roll');
        void s.digitsEl.offsetWidth;
        s.digitsEl.classList.add('stp-roll');
        setTimeout(function () { s.digitsEl.classList.remove('stp-roll'); }, 220);
      }
      return;
    }

    for (var j = 0; j < chars.length; j++) {
      var c = cols[j];
      var shown = c.getAttribute('data-d');
      if (shown === chars[j]) continue;
      var current = c.querySelector('.stp-cur');
      var previous = c.querySelector('.stp-old');
      if (!current || !previous) {
        c.parentNode.replaceChild(columnFor(chars[j]), c);
        continue;
      }
      var dirClass = direction > 0 ? 'up' : 'down';
      previous.textContent = shown;
      previous.className = 'stp-d stp-old stp-out-' + dirClass;
      current.textContent = chars[j];
      current.className = 'stp-d stp-cur stp-in-' + dirClass;
      c.setAttribute('data-d', chars[j]);
      clearTimeout(c._stpTimer);
      c._stpTimer = setTimeout(function (col, cur, old) {
        cur.className = 'stp-d stp-cur';
        old.className = 'stp-d stp-old';
      }, 250, c, current, previous);
    }
  }

  function syncAria(s) {
    var unit = unitFor(s.value, s.cfg);
    s.valueEl.setAttribute('aria-valuemin', String(s.min));
    s.valueEl.setAttribute('aria-valuemax', String(s.max));
    s.valueEl.setAttribute('aria-valuenow', String(s.value));
    s.valueEl.setAttribute('aria-valuetext', s.value + (unit ? ' ' + unit : ''));
    s.valueEl.setAttribute('aria-label', s.cfg.label);
    if (s.input && s.input.required) s.valueEl.setAttribute('aria-required', 'true');
    s.unitEl.textContent = unit;
    s.dec.disabled = s.disabled || s.value <= s.min;
    s.inc.disabled = s.disabled || s.value >= s.max;
    s.valueEl.setAttribute('aria-disabled', s.disabled ? 'true' : 'false');
    s.root.setAttribute('data-stp-disabled', s.disabled ? 'true' : 'false');
    s.root.style.setProperty('--stp-places', String(Math.max(1, String(s.max).length)));
  }

  function setInput(s) {
    if (!s.input) return;
    var next = String(s.value);
    if (s.input.value === next) return;
    s.input.value = next;
    try {
      s.input.dispatchEvent(new Event('input', { bubbles: true }));
      s.input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      var ev = doc.createEvent('Event');
      ev.initEvent('input', true, true);
      s.input.dispatchEvent(ev);
      var ev2 = doc.createEvent('Event');
      ev2.initEvent('change', true, true);
      s.input.dispatchEvent(ev2);
    }
  }

  function setValue(s, next, opts) {
    if (s.disabled && !(opts && opts.force)) return false;
    next = normalise(next, s);
    if (next === s.value) {
      syncAria(s);
      return false;
    }
    var prev = s.value;
    var direction = next > prev ? 1 : -1;
    s.value = next;
    renderDigits(s, direction, !(opts && opts.silent));
    syncAria(s);
    setInput(s);
    if (typeof s.cfg.onChange === 'function') {
      try { s.cfg.onChange(next, prev); } catch (err) { console.error('Stepper onChange failed', err); }
    }
    if (!(opts && opts.silent)) announce(s);
    return true;
  }

  function step(s, dir, multiplier) {
    if (s.disabled) return;
    setValue(s, s.value + dir * s.step * (multiplier || 1), {});
  }

  function onKey(s, ev) {
    if (s.disabled) return;
    var key = ev.key;
    if (key === 'ArrowUp' || key === 'ArrowRight' || key === '+') {
      ev.preventDefault(); s.typed = ''; step(s, 1, 1); return;
    }
    if (key === 'ArrowDown' || key === 'ArrowLeft' || key === '-') {
      ev.preventDefault(); s.typed = ''; step(s, -1, 1); return;
    }
    if (key === 'PageUp') { ev.preventDefault(); s.typed = ''; step(s, 1, 10); return; }
    if (key === 'PageDown') { ev.preventDefault(); s.typed = ''; step(s, -1, 10); return; }
    if (key === 'Home') { ev.preventDefault(); s.typed = ''; setValue(s, s.min, {}); return; }
    if (key === 'End') { ev.preventDefault(); s.typed = ''; setValue(s, s.max, {}); return; }
    if (key === 'Escape') {
      if (s.typedBase !== null) {
        ev.preventDefault();
        s.typed = '';
        var base = s.typedBase;
        s.typedBase = null;
        setValue(s, base, {});
      }
      return;
    }
    if (key === 'Enter') {
      if (s.typed !== '') {
        ev.preventDefault();
        s.typed = '';
        s.typedBase = null;
        announce(s);
      }
      return;
    }
    if (/^[0-9]$/.test(key)) {
      ev.preventDefault();
      if (s.typedBase === null) s.typedBase = s.value;
      s.typed = (s.typed + key).slice(-String(s.max).length);
      clearTimeout(s.typedTimer);
      setValue(s, Number(s.typed), { silent: true });
      s.typedTimer = setTimeout(function () {
        s.typed = '';
        s.typedBase = null;
        announce(s);
      }, 900);
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      ev.preventDefault();
      if (s.typedBase === null) s.typedBase = s.value;
      clearTimeout(s.typedTimer);
      s.typed = s.typed.slice(0, -1);
      setValue(s, s.typed === '' ? s.min : Number(s.typed), { silent: true });
      s.typedTimer = setTimeout(function () {
        s.typed = '';
        s.typedBase = null;
        announce(s);
      }, 900);
    }
  }

  function labelOf(input) {
    if (!input || !input.labels || !input.labels.length) return null;
    return input.labels[0];
  }

  function observeDisabled(s) {
    if (!s.input || typeof global.MutationObserver !== 'function') return;
    s.observer = new global.MutationObserver(function () {
      s.disabled = !!s.input.disabled || s.input.getAttribute('aria-disabled') === 'true';
      syncAria(s);
    });
    s.observer.observe(s.input, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
  }

  function wire(s) {
    s.dec.addEventListener('click', function () { step(s, -1, 1); });
    s.inc.addEventListener('click', function () { step(s, 1, 1); });
    s.valueEl.addEventListener('keydown', function (ev) { onKey(s, ev); });
    s.valueEl.addEventListener('focus', function () {
      s.typed = '';
      s.typedBase = null;
    });
    s.root.addEventListener('pointerdown', function (ev) {
      if (ev.target === s.valueEl) s.valueEl.focus();
    });
  }

  function setup(input, host, opts) {
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    for (var j in opts) cfg[j] = opts[j];

    var initial = cfg.value;
    if (initial === null || initial === undefined) {
      initial = input ? Number(input.value) : 0;
    }
    if (!isFinite(initial)) initial = cfg.min;
    cfg.label = labelFor(input, cfg);

    var s = {
      input: input || null,
      host: host || null,
      cfg: cfg,
      min: Number(cfg.min),
      max: Number(cfg.max),
      step: Math.max(1, Math.abs(Number(cfg.step)) || 1),
      value: initial,
      disabled: !!cfg.disabled,
      typed: '',
      typedBase: null,
      typedTimer: null,
      announceTimer: null,
      observer: null
    };
    if (s.max < s.min) s.max = s.min;
    s.value = normalise(initial, s);
    if (input) {
      s.min = numberFrom(input, 'min', s.min);
      s.max = numberFrom(input, 'max', s.max);
      s.step = Math.abs(numberFrom(input, 'step', s.step)) || 1;
      s.value = normalise(Number(input.value), s);
      s.disabled = s.disabled || !!input.disabled;
    }

    build(s);
    wire(s);

    if (input) {
      if (!input.id) input.id = 'stp-input-' + (++seq);
      input.classList.add('stp-native');
      input.setAttribute('aria-hidden', 'true');
      input.tabIndex = -1;
      input.hidden = true;
      var label = labelOf(input);
      if (host) host.appendChild(s.root);
      else if (label && label.contains(input) && label.parentNode) {
        // Interactive buttons inside a <label> would also activate the label's
        // own field. Put the control after the label instead; its click handler
        // below still focuses the number.
        label.parentNode.insertBefore(s.root, label.nextSibling);
      } else if (input.parentNode) input.parentNode.insertBefore(s.root, input.nextSibling);

      var valueId = 'stp-value-' + (++seq);
      s.valueEl.id = valueId;
      if (label) {
        if (!label.id) label.id = 'stp-label-' + (++seq);
        s.valueEl.setAttribute('aria-labelledby', label.id);
        label.addEventListener('click', function (ev) {
          ev.preventDefault();
          s.valueEl.focus();
        });
      }
      setInput(s);
      observeDisabled(s);
    } else if (host) {
      host.appendChild(s.root);
    }

    if (host) host.classList.add('stp-host');
    if (!input) setInput(s);
    syncAria(s);
    renderDigits(s, 0, false);

    var api = {
      el: s.root,
      host: host || null,
      input: input || null,
      get: function () { return s.value; },
      set: function (n, options) { return setValue(s, n, options || {}); },
      step: function (dir) { step(s, dir, 1); },
      disabled: function (flag) {
        s.disabled = !!flag;
        if (s.input) s.input.disabled = !!flag;
        syncAria(s);
      },
      refresh: function () { syncAria(s); },
      destroy: function () {
        clearTimeout(s.announceTimer);
        clearTimeout(s.typedTimer);
        if (s.observer) s.observer.disconnect();
        if (s.root.parentNode) s.root.parentNode.removeChild(s.root);
        if (s.input) {
          s.input.hidden = false;
          s.input.removeAttribute('aria-hidden');
          s.input.tabIndex = 0;
          s.input.classList.remove('stp-native');
        }
        if (host) host.classList.remove('stp-host');
        if (s.input) delete s.input[STATE];
        if (host) delete host[STATE];
        delete s.root[STATE];
      }
    };
    s.api = api;
    s.root[STATE] = api;
    return api;
  }

  function forElement(el) {
    return el && el[STATE] && typeof el[STATE].get === 'function' ? el[STATE] : null;
  }

  global.Stepper = {
    attach: function (input, opts) {
      if (!input) return null;
      if (input[STATE]) return input[STATE].api;
      var api = setup(input, null, opts || {});
      input[STATE] = api;
      return api;
    },
    mount: function (host, opts) {
      if (!host) return null;
      if (host[STATE]) return host[STATE].api;
      if (host.firstChild) host.textContent = '';
      var api = setup(null, host, opts || {});
      host[STATE] = api;
      return api;
    },
    get: function (el) {
      var st = forElement(el);
      return st ? st.get() : null;
    },
    set: function (el, n, options) {
      var st = forElement(el);
      return st ? st.set(n, options) : false;
    },
    destroy: function (el) {
      var st = forElement(el);
      if (st) st.destroy();
    }
  };
})(window);
