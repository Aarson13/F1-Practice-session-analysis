/* Time Undo Action - a destructive control that turns into its own undo window.
 *
 *   TimeUndo.mount(button, {
 *     seconds: 6,
 *     onStart:  function () { ...apply the delete... },   // may return a Promise
 *     onCancel: function () { ...put it back... },
 *     onCommit: function () { ...optional, after the window... }
 *   });
 *
 * The click is the action: onStart runs at once, and only then does the button
 * become "Cancel (6)". The countdown is the window in which the action can be
 * taken back - never a delay before it happens. Clicking Cancel stops the
 * clock, calls onCancel and restores the button. When the window ends the
 * action simply stays, and onCommit (if any) runs.
 *
 * A host whose destructive row disappears (a deleted transaction) can arm the
 * control after the fact with TimeUndo.arm(button, opts), which starts the same
 * window without calling onStart.
 *
 * The kit owns the button's click handler and its label while counting. It
 * restores the original innerHTML, aria-label and min-width afterwards, so an
 * icon-bearing button comes back exactly as it left. It sets CSS custom
 * properties and attributes only: no injected CSS, no inline style in markup.
 * Reduced motion removes the progress transition; the seconds still count.
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var STATE = '__tuState';
  var DEFAULTS = {
    seconds: 6,
    cancelLabel: function (n) { return 'Cancel (' + n + ')'; },
    cancelAria: function (n) { return 'Cancel, ' + n + ' second' + (n === 1 ? '' : 's') + ' remaining'; },
    busyLabel: 'Working…',
    countMessage: 'Done. You can undo for a few seconds.',
    commitMessage: 'Change kept.'
  };

  function reduced() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function status(button, text) {
    var node = button[STATE] && button[STATE].status;
    if (!node || !text) return;
    node.textContent = '';
    // A fresh text node makes the live region announce the same sentence twice
    // when two actions follow each other.
    global.setTimeout(function () { node.textContent = text; }, 20);
  }

  function makeStatus() {
    var span = doc.createElement('span');
    span.className = 'tu-sr';
    span.setAttribute('role', 'status');
    span.setAttribute('aria-live', 'polite');
    return span;
  }

  function update(s) {
    var n = s.remaining;
    s.button.textContent = s.cfg.cancelLabel(n);
    s.button.setAttribute('aria-label', s.cfg.cancelAria(n));
    s.button.style.setProperty('--tu-progress', String(s.progress));
    s.button.setAttribute('data-tu-seconds', String(n));
  }

  function stopClock(s) {
    if (s.clock) {
      global.clearInterval(s.clock);
      s.clock = null;
    }
  }

  function restore(s) {
    stopClock(s);
    s.state = 'idle';
    s.button.innerHTML = s.originalHtml;
    s.button.removeAttribute('aria-busy');
    s.button.removeAttribute('data-tu-seconds');
    s.button.removeAttribute('data-tu-state');
    s.button.style.removeProperty('--tu-progress');
    if (s.originalMinWidth === '') s.button.style.removeProperty('min-width');
    else s.button.style.minWidth = s.originalMinWidth;
    if (s.originalAria === null) s.button.removeAttribute('aria-label');
    else s.button.setAttribute('aria-label', s.originalAria);
  }

  function begin(s) {
    var started = Date.now();
    var total = s.cfg.seconds * 1000;
    s.state = 'counting';
    s.remaining = s.cfg.seconds;
    s.progress = 1;
    s.button.setAttribute('data-tu-state', 'counting');
    s.button.removeAttribute('aria-busy');
    if (s.originalMinWidth === '') s.button.style.minWidth = s.button.offsetWidth + 'px';
    update(s);
    status(s.button, s.cfg.countMessage);

    s.clock = global.setInterval(function () {
      var elapsed = Date.now() - started;
      var left = Math.max(0, total - elapsed);
      s.progress = total ? left / total : 0;
      var next = Math.ceil(left / 1000);
      if (next !== s.remaining) {
        s.remaining = next;
        update(s);
      } else {
        s.button.style.setProperty('--tu-progress', String(s.progress));
      }
      if (left <= 0) {
        stopClock(s);
        restore(s);
        if (typeof s.cfg.onCommit === 'function') {
          try { s.cfg.onCommit(); } catch (err) { console.error('TimeUndo onCommit failed', err); }
        }
        status(s.button, s.cfg.commitMessage);
      }
    }, 100);
  }

  function cancel(s) {
    if (s.state !== 'counting') return false;
    stopClock(s);
    restore(s);
    if (typeof s.cfg.onCancel === 'function') {
      try { s.cfg.onCancel(); } catch (err) { console.error('TimeUndo onCancel failed', err); }
    }
    status(s.button, 'Change undone.');
    return true;
  }

  function destroy(s) {
    if (!s) return;
    stopClock(s);
    if (s.status && s.status.parentNode) s.status.parentNode.removeChild(s.status);
    s.button.removeEventListener('click', s.click);
    s.button.removeAttribute('data-tu-state');
    if (s.addedClass) s.button.classList.remove('tu-btn');
    delete s.button[STATE];
  }

  function setup(button, opts) {
    if (!button) return null;
    if (button[STATE]) return button[STATE];
    // The progress line and the counting tint live on .tu-btn. Add the hook
    // here so a host cannot mount the behaviour without the surface it needs;
    // buttons that already carry it keep the class they shipped with.
    var hadClass = button.classList.contains('tu-btn');
    if (!hadClass) button.classList.add('tu-btn');
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    for (var j in opts) cfg[j] = opts[j];

    var s = {
      button: button,
      cfg: cfg,
      state: 'idle',
      remaining: 0,
      progress: 1,
      clock: null,
      originalHtml: button.innerHTML,
      originalAria: button.getAttribute('aria-label'),
      originalMinWidth: button.style.minWidth || '',
      addedClass: !hadClass
    };
    s.status = makeStatus();
    if (button.parentNode) button.parentNode.insertBefore(s.status, button.nextSibling);

    s.click = function (ev) {
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      if (s.state === 'counting') {
        ev.preventDefault();
        cancel(s);
        return;
      }
      if (s.state === 'starting') return;
      ev.preventDefault();
      var result;
      try {
        result = typeof cfg.onStart === 'function' ? cfg.onStart(ev) : true;
      } catch (err) {
        console.error('TimeUndo onStart failed', err);
        return;
      }
      if (result && typeof result.then === 'function') {
        s.state = 'starting';
        s.button.setAttribute('aria-busy', 'true');
        var before = button.innerHTML;
        button.textContent = cfg.busyLabel;
        result.then(function (ok) {
          if (ok === false) {
            s.state = 'idle';
            button.innerHTML = before;
            button.removeAttribute('aria-busy');
            return;
          }
          begin(s);
        }, function (err) {
          console.error('TimeUndo onStart failed', err);
          s.state = 'idle';
          button.innerHTML = before;
          button.removeAttribute('aria-busy');
        });
        return;
      }
      if (result === false) return;
      begin(s);
    };

    button.addEventListener('click', s.click);
    button[STATE] = s;
    return s;
  }

  global.TimeUndo = {
    mount: setup,
    /* Start the window for an action that has already been applied. */
    arm: function (button, opts) {
      var s = setup(button, opts);
      if (s && s.state === 'idle') begin(s);
      return s;
    },
    cancel: function (button) {
      var s = button && button[STATE];
      return s ? cancel(s) : false;
    },
    destroy: function (button) { destroy(button && button[STATE]); },
    secondsLeft: function (button) {
      var s = button && button[STATE];
      return s && s.state === 'counting' ? s.remaining : 0;
    }
  };
})(window);
