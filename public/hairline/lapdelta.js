/* Lapdelta — the second-fastest lap split against the fastest.
 *
 * The three plates are the three sectors, raised or lowered by the time gained
 * or lost against the fastest driver's lap. Pointing at a sector reads the exact
 * delta; the Sectors table below remains the full, keyboard-accessible source.
 * A session with fewer than two drivers shows no comparison rather than a fake
 * one.
 *
 * Wrapped in an IIFE: the engine's figures are written at top level, and two of
 * them on one page would collide on their destructured names.
 */
(function () {
const {
  Cam, clamp, facing, fit, hull, open, poly, proj, rrect, ringAt, run,
  disposer, mk, pointer,
} = HL;

const Z0 = 1.5, Z1 = 3;
const POS = [-34, 0, 34];
const HW = 15, HD = 12;

/** A rounded box, drawn from its foot and top rings. */
function boxAt(parent, P, front, cx, cy, hw, hd, z0, z1, r) {
  const foot = rrect(cx - hw, cy - hd, cx + hw, cy + hd, r, 6);
  const top = rrect(cx - hw + 0.8, cy - hd + 0.8, cx + hw - 0.8, cy + hd - 0.8, Math.max(0.6, r - 0.8), 6);
  const g = mk('g', {}, parent);
  const sil = mk('path', { d: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))), class: 'sil' }, g);
  const cr = mk('path', { d: open(ringAt(P, run(top, front), z1)), class: 'nf lo' }, g);
  return { g, sil, cr };
}

function signed(v) {
  return (v >= 0 ? '+' : '') + Number(v).toFixed(3);
}

function mount({ stage, svg, read }, value) {
  const bag = disposer();

  const C = Cam(45, 0.5, 2.55);
  fit(C, [[-54, -32, 0], [54, 32, 0], [-54, -32, 8], [54, 32, 8]], 200, 164);
  const P = proj(C), front = facing(C);
  const root = mk('g', {}, svg);

  let data = null;
  let blocks = [];
  let selected = -1;
  let signature = null;

  function readDefault() {
    if (!data || !data.sectors.length) {
      read.textContent = 'No lap comparison';
      stage.setAttribute('aria-label', 'No lap comparison is available for this session.');
      return;
    }
    const lap = data.lapDelta == null ? 'lap —' : `lap ${signed(data.lapDelta)}s`;
    read.textContent = `${data.cmp} vs ${data.ref} · ${lap}`;
    stage.setAttribute(
      'aria-label',
      `${data.cmp} against ${data.ref} by sector; ${lap}. Point at a sector to read its delta.`,
    );
  }

  function build() {
    root.replaceChildren();
    selected = -1;
    blocks = [];

    const plate = boxAt(root, P, front, 0, 0, 50, 30, 0, Z0, 4);
    mk('path', { d: open([P(-46, 0, Z0 + 0.1), P(46, 0, Z0 + 0.1)]), class: 'nf dash' }, plate.g);

    const sectors = data && Array.isArray(data.sectors) ? data.sectors : [];
    blocks = sectors.map((sector, i) => {
      const cx = POS[i];
      const delta = Number.isFinite(sector.delta) ? sector.delta : null;
      const z1 = Z1 + (delta == null ? 0 : clamp(delta * 5, -1.4, 1.4));
      const box = boxAt(root, P, front, cx, 0, HW, HD, Z0, z1, 2);
      return { i, cx, box, sector };
    });

    const order = [{ key: -100, g: plate.g }, ...blocks.map((b) => ({ key: b.cx, g: b.box.g }))];
    order.sort((a, b) => a.key - b.key).forEach((o) => root.appendChild(o.g));

    readDefault();
  }

  function highlight(i) {
    if (i === selected) return;
    selected = i;
    blocks.forEach((b, k) => b.box.sil.setAttribute('class', k === i ? 'sil hi' : 'sil'));
    if (i < 0) {
      readDefault();
      return;
    }
    const b = blocks[i];
    const delta = Number.isFinite(b.sector.delta) ? signed(b.sector.delta) + 's' : '—';
    read.textContent = `${data.cmp} vs ${data.ref} · S${i + 1} ${delta}`;
  }

  function pick(pt) {
    const [u, v] = HL.unproj(C, pt[0], pt[1], Z1 + 1.4);
    let best = -1, distance = Infinity;
    blocks.forEach((b, i) => {
      const d = Math.abs(u - b.cx);
      if (d < distance && d <= HW + 2 && Math.abs(v) <= HD + 3) {
        distance = d;
        best = i;
      }
    });
    return best;
  }

  function set(next) {
    const sectors = next && Array.isArray(next.sectors) ? next.sectors : [];
    const sig = [
      next && next.ref, next && next.cmp, next && next.lapDelta,
      ...sectors.map((s) => s && s.delta),
    ].join('|');
    if (sig === signature) return;
    signature = sig;
    data = next && sectors.length
      ? { ref: next.ref, cmp: next.cmp, lapDelta: next.lapDelta, sectors }
      : null;
    build();
  }

  bag.add(pointer(stage, {
    move: (p) => highlight(pick(p)),
    down: (p) => highlight(pick(p)),
    leave: () => highlight(-1),
  }));
  bag.add(() => svg.replaceChildren());

  set(value);
  return { set, destroy: bag.dispose };
}

hairline({
  name: 'lapdelta',
  means: 'The second-fastest lap split into sectors against the fastest; point at a sector to read its delta.',
  rules: [1, 4, 6, 8],
  range: [0, 3, 1],
  tour: [[130, 170], [200, 120], [270, 170], [320, 200], null],
  mount,
});

let handle = null;

/** Called with the analysis the app just rendered. */
window.mountF1LapDelta = function (analysis) {
  const host = document.getElementById('f1-lap-delta');
  if (!host || !window.mountHairline) return;
  const stats = analysis && Array.isArray(analysis.driverStats) ? analysis.driverStats : [];
  const ref = stats[0];
  const cmp = stats[1];
  let value = { ref: '', cmp: '', lapDelta: null, sectors: [] };
  if (ref && cmp && ref.lap && cmp.lap) {
    const sectors = [1, 2, 3].map((i) => {
      const a = ref.lap['duration_sector_' + i];
      const b = cmp.lap['duration_sector_' + i];
      return { delta: Number.isFinite(a) && Number.isFinite(b) ? b - a : null };
    });
    const lapDelta = Number.isFinite(ref.lap.lap_duration) && Number.isFinite(cmp.lap.lap_duration)
      ? cmp.lap.lap_duration - ref.lap.lap_duration
      : null;
    value = {
      ref: (ref.info && ref.info.acronym) || 'P1',
      cmp: (cmp.info && cmp.info.acronym) || 'P2',
      lapDelta,
      sectors,
    };
  }
  if (!handle) handle = window.mountHairline('f1-lap-delta', value);
  else if (handle.set) handle.set(value);
};
})();
