/* =====================================================================
 * F1 Session Analyzer
 * ---------------------------------------------------------------------
 * How it works (live, zero storage):
 *  1. User picks Year -> Grand Prix -> Session (ANY session type:
 *     Practice 1/2/3, Qualifying, Sprint Qualifying, Sprint, Race).
 *  2. On "Analyze", the app fetches everything LIVE from the OpenF1 API
 *     (meetings / sessions / drivers / laps / car_data / session_result)
 *     plus official corner geometry from the meeting's circuit_info_url.
 *  3. All processing happens in the browser on page load / on Analyze.
 *     Nothing is downloaded, cached on a server, or stored anywhere.
 *  4. Only the SELECTED session is analyzed — never the whole weekend.
 *
 * Corner method: each driver's best lap telemetry (speed @ ~3.7Hz) is
 * converted to speed-vs-lap-distance (distance integrated from speed over
 * time) and resampled to N_BINS points. Official corner apexes are mapped
 * to lap-progress bins; each corner is ranked by average speed in a small
 * window around the apex. Higher avg speed through the corner = better.
 * ===================================================================== */
"use strict";

const OPENF1 = "https://api.openf1.org/v1";
const N_BINS = 1000;          // resampled points per lap
const CORNER_HALF_WINDOW = 12; // ±bins around apex (~±1.2% of lap distance)
const MIN_TELEMETRY_POINTS = 50;
const REQUEST_SPACING_MS = 700; // stay under OpenF1 free-tier rate limits

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelector(sel); // for CSS selectors (e.g. "#cornerTable tbody")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- throttled fetch with timeout + retry ---------------- */
let lastReqAt = 0;
const REQUEST_TIMEOUT_MS = 30000;
async function pace() {
  const wait = REQUEST_SPACING_MS - (Date.now() - lastReqAt);
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
}
async function apiGet(url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await pace();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429) {
        setStatus(`Rate-limited by the API — waiting 15s before retry (attempt ${attempt}/5)…`);
        await sleep(15000);
        continue;
      }
      if (res.status >= 500 && res.status < 600) {
        lastError = new Error(`API error loading ${label}: HTTP ${res.status}`);
        await sleep(2000 * attempt); // transient server error — retry
        continue;
      }
      if (!res.ok) throw new Error(`API error loading ${label}: HTTP ${res.status}`);
      try {
        const data = await res.json();
        if (data == null) throw new Error("empty response");
        return data;
      } catch (e) {
        lastError = new Error(`Bad response loading ${label}: ${e.message}`);
        await sleep(2000 * attempt);
        continue;
      }
    } catch (e) {
      if (e && e.name === "AbortError") {
        lastError = new Error(`Timed out loading ${label} (>${REQUEST_TIMEOUT_MS / 1000}s)`);
      } else if (e instanceof TypeError) {
        // fetch() TypeError = network failure / CORS / offline
        lastError = new Error(`Network error loading ${label}: no connection to api.openf1.org (${e.message})`);
      } else if (/^API error|^Rate limit/.test(e.message || "")) {
        throw e; // non-retryable, already classified
      } else {
        lastError = e;
      }
      if (attempt === 5) break;
      setStatus(`Retrying ${label} (attempt ${attempt + 1}/5)…`);
      await sleep(2000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError
    : new Error(`Failed loading ${label} after 5 attempts. Wait a minute and try again (or analyze fewer drivers).`);
}

/* ---------------- formatting helpers ---------------- */
function fmtLap(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(3).padStart(6, "0");
  return `${m}:${s}`;
}
function fmtGap(g) {
  if (g == null || !isFinite(g)) return "";
  return g === 0 ? " — " : `+${g.toFixed(3)}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function teamColor(t) {
  return t && /^[0-9a-fA-F]{6}$/.test(t) ? `#${t}` : "#9aa4bd";
}

/* ---------------- status / progress / errors ---------------- */
function setStatus(text, frac) {
  $("statusBox").hidden = false;
  $("statusText").textContent = text;
  if (frac != null) $("progressBar").style.width = `${Math.round(frac * 100)}%`;
}
function showError(msg) {
  const box = $("errorBox");
  box.hidden = false;
  box.innerHTML = `<strong>Something went wrong:</strong> ${esc(msg)}`;
}
function clearError() { $("errorBox").hidden = true; $("errorBox").innerHTML = ""; }

/* ---------------- state ---------------- */
const state = {
  meetings: [],       // meetings for selected year
  meetingByKey: new Map(),
  sessions: [],       // sessions for selected meeting
  analysis: null,
  mapShape: null,     // {PX, PY, n} fitted track outline for map/replay
  mapCache: null,     // offscreen static map frame
  apexPixels: [],     // [{x, y, idx, bin}] corner marker positions
  highlightBin: null, // corner bin spotlighted from table hover
};

/* =====================================================================
 * SELECTOR FLOW: year -> grand prix -> session (all session types)
 * ===================================================================== */
async function init() {
  const yearSel = $("yearSelect");
  const thisYear = new Date().getFullYear();
  yearSel.innerHTML = "";
  for (let y = thisYear; y >= 2023; y--) {
    const o = document.createElement("option");
    o.value = y; o.textContent = y;
    yearSel.appendChild(o);
  }
  yearSel.value = String(thisYear);
  yearSel.addEventListener("change", loadMeetings);
  $("gpSelect").addEventListener("change", loadSessions);
  $("sessionSelect").addEventListener("change", () => {
    const has = !!$("sessionSelect").value;
    $("analyzeBtn").disabled = !has;
    $("copyLinkBtn").disabled = !has;
  });
  $("analyzeBtn").addEventListener("click", runAnalysis);
  $("copyLinkBtn").addEventListener("click", copyShareLink);
  $("weekendBtn").addEventListener("click", runWeekend);
  $("replayBtn").addEventListener("click", toggleReplay);
  $("trackMap").addEventListener("click", onTrackClick);
  $("h2hA").addEventListener("change", renderH2H);
  $("h2hB").addEventListener("change", renderH2H);
  $("cornerCsvBtn").addEventListener("click", () => exportSessionCSV("corners"));
  $("driverCsvBtn").addEventListener("click", () => exportSessionCSV("drivers"));
  $("teamCsvBtn").addEventListener("click", () => exportSessionCSV("teams"));
  $("sectorCsvBtn").addEventListener("click", () => exportSessionCSV("sectors"));
  $("paceCsvBtn").addEventListener("click", () => exportSessionCSV("pace"));
  $("resetBtn").addEventListener("click", () => {
    $("results").hidden = true; clearError();
    $("statusBox").hidden = true; $("progressBar").style.width = "0%";
    try { history.replaceState(null, "", location.pathname); } catch { /* ignore */ }
  });
  // shared-link autoload (?#y=&m=&s=) takes precedence over the default flow
  try {
    if (location.hash.length > 1 && (await loadFromHash())) return;
  } catch (e) { console.warn("share link failed", e); }
  await loadMeetings();
}

function saveShareHash() {
  try {
    const y = $("yearSelect").value, m = $("gpSelect").value, s = $("sessionSelect").value;
    if (y && m && s) history.replaceState(null, "", `#y=${y}&m=${m}&s=${s}`);
  } catch { /* ignore (e.g. sandboxed iframe) */ }
}
async function copyShareLink() {
  saveShareHash();
  const url = location.href;
  const btn = $("copyLinkBtn");
  const done = () => { btn.textContent = "Copied!"; setTimeout(() => { btn.textContent = "🔗 Copy share link"; }, 2000); };
  try {
    await navigator.clipboard.writeText(url);
    done();
  } catch {
    const ta = document.createElement("textarea");
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch { showError("Could not copy — the link is in the address bar."); }
    ta.remove();
  }
}
async function loadFromHash() {
  const p = Object.fromEntries(location.hash.replace(/^#/, "").split("&").map((kv) => kv.split("=")));
  if (!p.y || !p.m || !p.s) return false;
  if (![...$("yearSelect").options].some((o) => o.value === p.y)) return false;
  $("yearSelect").value = p.y;
  await loadMeetings();
  if (!state.meetingByKey.has(String(p.m))) return false;
  $("gpSelect").value = String(p.m);
  await loadSessions();
  if (!state.sessions.some((s) => String(s.session_key) === String(p.s))) return false;
  $("sessionSelect").value = String(p.s);
  $("analyzeBtn").disabled = false;
  $("copyLinkBtn").disabled = false;
  await runAnalysis();
  return true;
}

async function loadMeetings() {
  const year = $("yearSelect").value;
  const gpSel = $("gpSelect");
  gpSel.disabled = true; gpSel.innerHTML = `<option value="">Loading Grands Prix…</option>`;
  $("sessionSelect").disabled = true;
  $("analyzeBtn").disabled = true;
  clearError();
  try {
    const meetings = await apiGet(`${OPENF1}/meetings?year=${encodeURIComponent(year)}`, "Grand Prix list");
    if (!Array.isArray(meetings) || meetings.length === 0) {
      gpSel.innerHTML = `<option value="">No Grands Prix found for ${esc(year)}</option>`;
      showError(`The API returned no Grands Prix for ${year}. The season may not have started yet — try an earlier year.`);
      return;
    }
    meetings.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    state.meetings = meetings;
    state.meetingByKey = new Map(meetings.map((m) => [String(m.meeting_key), m]));
    gpSel.innerHTML = `<option value="">— Select Grand Prix —</option>`;
    for (const m of meetings) {
      if (m.is_cancelled) continue; // nothing to analyze
      const o = document.createElement("option");
      o.value = m.meeting_key;
      const d = new Date(m.date_start).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      o.textContent = `${m.meeting_name} — ${m.location} (${d})`;
      gpSel.appendChild(o);
    }
    if (gpSel.options.length <= 1) {
      gpSel.innerHTML = `<option value="">No (non-cancelled) Grands Prix for ${esc(year)}</option>`;
      return;
    }
    gpSel.disabled = false;
  } catch (e) { showError(e.message); }
}

async function loadSessions() {
  const meetingKey = $("gpSelect").value;
  const sesSel = $("sessionSelect");
  $("analyzeBtn").disabled = true;
  if (!meetingKey) { sesSel.disabled = true; return; }
  sesSel.disabled = true; sesSel.innerHTML = `<option value="">Loading sessions…</option>`;
  clearError();
  try {
    // ALL session types for this meeting: Practice, Qualifying, Sprint, Race…
    const sessions = await apiGet(`${OPENF1}/sessions?meeting_key=${encodeURIComponent(meetingKey)}`, "session list");
    if (!Array.isArray(sessions) || sessions.length === 0) {
      sesSel.innerHTML = `<option value="">No sessions found for this event</option>`;
      showError("The API returned no sessions for this Grand Prix. It may be too far in the future.");
      return;
    }
    sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    state.sessions = sessions.filter((s) => !s.is_cancelled);
    if (state.sessions.length === 0) {
      sesSel.innerHTML = `<option value="">All sessions for this event were cancelled</option>`;
      return;
    }
    sesSel.innerHTML = `<option value="">— Select session to analyze —</option>`;
    for (const s of state.sessions) {
      const o = document.createElement("option");
      o.value = s.session_key;
      const d = new Date(s.date_start).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      o.textContent = `${s.session_name} (${s.session_type}) — ${d}`;
      sesSel.appendChild(o);
    }
    sesSel.disabled = false;
  } catch (e) { showError(e.message); }
}

/* =====================================================================
 * TELEMETRY MATH
 * ===================================================================== */
// Integrate speed-over-time into distance, then resample speed to N bins
// of lap-distance progress. Returns Float32Array(N) or null.
function speedToProgressTrace(points, n = N_BINS) {
  if (!points || points.length < MIN_TELEMETRY_POINTS) return null;
  const pts = [...points].sort((a, b) => a.t - b.t);
  const cum = new Array(pts.length);
  cum[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(0, (pts[i].t - pts[i - 1].t) / 1000);
    const v = (pts[i].speed + pts[i - 1].speed) / 2 / 3.6; // m/s
    cum[i] = cum[i - 1] + v * Math.min(dt, 2); // clamp dt against gaps
  }
  const total = cum[pts.length - 1];
  if (!(total > 0)) return null;
  const out = new Float32Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < pts.length - 2 && cum[j + 1] < target) j++;
    const d0 = cum[j], d1 = cum[j + 1];
    const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
    out[k] = pts[j].speed + f * (pts[j + 1].speed - pts[j].speed);
  }
  return out;
}

function movingAverage(arr, w) {
  const out = new Float32Array(arr.length);
  const h = Math.floor(w / 2);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(arr.length - 1, i + h); k++) { s += arr[k]; c++; }
    out[i] = s / c;
  }
  return out;
}

// Fallback corner detection: local speed minima of the reference lap.
function detectCornersFromSpeed(refSpeed) {
  const sm = movingAverage(refSpeed, 15);
  let max = 0;
  for (const v of sm) max = Math.max(max, v);
  const cands = [];
  for (let i = 5; i < sm.length - 5; i++) {
    if (sm[i] < sm[i - 1] && sm[i] <= sm[i + 1] && sm[i] < 0.93 * max) {
      // prominence: clearly slower than surroundings ±20 bins
      const around = Math.max(sm[Math.max(0, i - 20)], sm[Math.min(sm.length - 1, i + 20)]);
      if (around - sm[i] >= 4) cands.push({ bin: i, speed: sm[i] });
    }
  }
  // greedy: slowest first, enforce min separation
  cands.sort((a, b) => a.speed - b.speed);
  const picked = [];
  for (const c of cands) {
    if (picked.every((p) => Math.abs(p.bin - c.bin) > 30)) picked.push(c);
    if (picked.length >= 25) break;
  }
  picked.sort((a, b) => a.bin - b.bin);
  return picked.map((p, i) => ({ number: i + 1, bin: p.bin, official: false }));
}

// Map official corner apexes (same coordinate frame as circuit centerline)
// to lap-progress bins via nearest centerline point.
function mapOfficialCorners(circuit) {
  if (!circuit || !Array.isArray(circuit.x) || !Array.isArray(circuit.y) ||
      !Array.isArray(circuit.corners) || circuit.corners.length === 0) return null;
  const { x, y, corners } = circuit;
  const mapped = [];
  corners.forEach((c, idx) => {
    const tp = c.trackPosition;
    if (!tp || !Number.isFinite(tp.x) || !Number.isFinite(tp.y)) return;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < x.length; i++) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
      const dx = x[i] - tp.x, dy = y[i] - tp.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) return;
    const num = Number.isFinite(c.number) ? c.number : idx + 1;
    mapped.push({ number: num, bin: Math.round((best / (x.length - 1)) * (N_BINS - 1)), official: true });
  });
  mapped.sort((a, b) => a.bin - b.bin);
  // dedupe apexes that collapse onto the same bins (e.g. chicanes)
  const dedup = [];
  for (const m of mapped) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1].bin - m.bin) < 15) continue;
    dedup.push(m);
  }
  return dedup.length >= 3 ? dedup : null;
}

function windowStats(trace, bin, half = CORNER_HALF_WINDOW) {
  const lo = Math.max(0, bin - half), hi = Math.min(trace.length - 1, bin + half);
  let s = 0, mn = Infinity, c = 0;
  for (let i = lo; i <= hi; i++) { s += trace[i]; mn = Math.min(mn, trace[i]); c++; }
  return { avg: s / c, min: mn };
}

/* =====================================================================
 * ANALYSIS CORE — shared by single-session and weekend analysis.
 * progress(frac, text) reports 0..1. Returns a plain analysis object.
 * Only the session passed in is touched — never the whole weekend.
 * ===================================================================== */
function compoundFor(stintsByDriver, num, lapNumber) {
  const list = stintsByDriver.get(num) || [];
  const st = list.find((s) => lapNumber >= s.lap_start && lapNumber <= s.lap_end) || list[list.length - 1];
  const c = st && st.compound ? String(st.compound).toUpperCase() : "";
  return ["SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET"].includes(c) ? c : "Unknown";
}
function summarizeWeather(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // field names differ across API versions — accept both
  const num = (ks) => rows.map((r) => {
    for (const k of ks) { if (Number.isFinite(r[k])) return r[k]; }
    return NaN;
  }).filter(Number.isFinite);
  // loop-safe min/max (arrays can be large)
  const span = (a) => {
    if (!a.length) return null;
    let lo = Infinity, hi = -Infinity;
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi];
  };
  const track = span(num(["track_temperature", "track_temp"]));
  const air = span(num(["air_temperature", "air_temp"]));
  const wind = num(["wind_speed"]);
  const rain = rows.some((r) => Number.isFinite(r.rainfall) && r.rainfall > 0);
  let windMax = null;
  for (const v of wind) windMax = windMax == null ? v : Math.max(windMax, v);
  return { track, air, windMax, rain, n: rows.length };
}
function summarizeFlags(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && (r.category === "Flag" || r.category === "SafetyCar"))
    .filter((r) => !["GREEN", "CLEAR", "CHEQUERED"].includes(r.flag))
    .map((r) => ({ t: String(r.date || "").slice(11, 19), flag: r.flag || r.category, msg: r.message || "" }))
    .slice(0, 12);
}
function leastSquares(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
  return den ? num / den : 0;
}
function computePace(laps, stintsByDriver) {
  const out = [];
  for (const [num, list] of stintsByDriver) {
    const sorted = [...list].sort((a, b) => a.lap_start - b.lap_start);
    sorted.forEach((st, si) => {
      const rows = laps
        .filter((l) => l.driver_number === num && Number.isInteger(l.lap_number)
          && l.lap_number >= st.lap_start && l.lap_number <= st.lap_end
          && l.lap_duration > 0 && !l.is_pit_out_lap)
        .sort((a, b) => a.lap_number - b.lap_number);
      if (rows.length < 4) return; // need out-lap + ≥3 timed laps
      const timed = rows.slice(1);
      const ds = timed.map((r) => r.lap_duration).sort((a, b) => a - b);
      const med = ds[Math.floor(ds.length / 2)];
      const clean = timed.filter((r) => r.lap_duration <= med * 1.07);
      if (clean.length < 3) return;
      const avg = clean.reduce((s, r) => s + r.lap_duration, 0) / clean.length;
      out.push({
        num, stint: si + 1, compound: st.compound || "Unknown",
        age: st.tyre_age_at_start ?? "—", n: clean.length, avg,
        slope: leastSquares(clean.map((r) => r.lap_number), clean.map((r) => r.lap_duration)),
      });
    });
  }
  return out.sort((a, b) => a.avg - b.avg);
}

async function analyzeSessionData(sessionKey, session, meeting, driverLimit, progress) {
  progress(0.03, "Fetching session overview (drivers, laps, stints, classification)…");
  const [drivers, laps, classification, stints, weather, raceControl] = await Promise.all([
    apiGet(`${OPENF1}/drivers?session_key=${sessionKey}`, "drivers"),
    apiGet(`${OPENF1}/laps?session_key=${sessionKey}`, "laps"),
    apiGet(`${OPENF1}/session_result?session_key=${sessionKey}`, "session classification").catch(() => []),
    apiGet(`${OPENF1}/stints?session_key=${sessionKey}`, "tyre stints").catch(() => []),
    apiGet(`${OPENF1}/weather?session_key=${sessionKey}`, "weather").catch(() => []),
    apiGet(`${OPENF1}/race_control?session_key=${sessionKey}`, "race control").catch(() => []),
  ]);
  if (!Array.isArray(drivers) || !Array.isArray(laps)) {
    throw new Error("The API returned an unexpected response for drivers/laps. Please retry in a minute.");
  }

  // Official corner geometry — fetched live, never stored.
  let circuit = null;
  if (meeting && meeting.circuit_info_url) {
    progress(0.06, "Fetching official circuit corner data…");
    try {
      const r = await fetch(meeting.circuit_info_url);
      if (r.ok) circuit = await r.json();
    } catch { circuit = null; }
  }

  // driver lookup
  const driverInfo = new Map();
  for (const d of drivers) {
    if (!driverInfo.has(d.driver_number)) {
      driverInfo.set(d.driver_number, {
        number: d.driver_number,
        acronym: d.name_acronym || `#${d.driver_number}`,
        name: d.full_name || d.broadcast_name || `Driver ${d.driver_number}`,
        team: d.team_name || "Unknown",
        colour: teamColor(d.team_colour),
        img: d.headshot_url || "",
      });
    }
  }

  // stints lookup (tyre compound per lap + race-pace stints)
  const stintsByDriver = new Map();
  for (const s of (Array.isArray(stints) ? stints : [])) {
    if (s == null || s.driver_number == null) continue;
    if (!stintsByDriver.has(s.driver_number)) stintsByDriver.set(s.driver_number, []);
    stintsByDriver.get(s.driver_number).push({
      compound: s.compound || "Unknown",
      lap_start: s.lap_start ?? 0, lap_end: s.lap_end ?? 999,
      tyre_age_at_start: s.tyre_age_at_start,
    });
  }

  // best (non-pit-out) lap per driver
  const bestByDriver = new Map();
  for (const lap of laps) {
    if (lap.lap_duration == null || !(lap.lap_duration > 0)) continue;
    if (lap.is_pit_out_lap) continue;
    const cur = bestByDriver.get(lap.driver_number);
    if (!cur || lap.lap_duration < cur.lap_duration) bestByDriver.set(lap.driver_number, lap);
  }
  let ranked = [...bestByDriver.entries()]
    .filter(([num]) => driverInfo.has(num))
    .sort((a, b) => a[1].lap_duration - b[1].lap_duration);
  if (ranked.length === 0) throw new Error("No timed laps found for this session yet. The session may not have started or data may still be publishing.");

  ranked = ranked.slice(0, Math.min(driverLimit, ranked.length));

  // per-driver telemetry for their best lap window
  const traces = new Map(); // driver_number -> {trace, topSpeed, avgSpeed, lap}
  let done = 0;
  for (const [num, lap] of ranked) {
    done++;
    const acr = driverInfo.get(num).acronym;
    progress(0.06 + 0.7 * (done / ranked.length), `Fetching best-lap telemetry for ${acr} (${done}/${ranked.length})…`);
    const start = new Date(lap.date_start);
    const from = new Date(start.getTime() - 2000).toISOString();
    const to = new Date(start.getTime() + lap.lap_duration * 1000 + 3000).toISOString();
    const url = `${OPENF1}/car_data?session_key=${sessionKey}&driver_number=${num}` +
      `&date>${encodeURIComponent(from)}&date<${encodeURIComponent(to)}`;
    let rows;
    try {
      rows = await apiGet(url, `telemetry for ${acr}`);
    } catch (e) {
      console.warn(`Skipping ${acr}: ${e.message}`);
      continue;
    }
    if (!Array.isArray(rows) || rows.length === 0) { console.warn(`Skipping ${acr}: empty telemetry response`); continue; }
    const pts = rows
      .filter((r) => r && Number.isFinite(r.speed) && Number.isFinite(Date.parse(r.date)))
      .map((r) => ({ t: Date.parse(r.date), speed: r.speed }));
    const trace = speedToProgressTrace(pts);
    if (!trace) { console.warn(`Skipping ${acr}: not enough telemetry points`); continue; }
    let top = 0, sum = 0;
    for (const v of trace) { top = Math.max(top, v); sum += v; }
    traces.set(num, { trace, topSpeed: top, avgSpeed: sum / trace.length, lap });
  }
  if (traces.size < 2) throw new Error("Not enough driver telemetry could be loaded (need at least 2 drivers). The API may be rate-limiting — wait a minute and retry, or analyze fewer drivers.");

  // reference = fastest analyzed lap
  const refNum = [...traces.entries()].sort((a, b) => a[1].lap.lap_duration - b[1].lap.lap_duration)[0][0];

  progress(0.8, "Detecting corners & ranking every turn…");
  await sleep(30);
  let corners = circuit ? mapOfficialCorners(circuit) : null;
  const cornerSource = corners ? "official" : "auto-detected";
  if (!corners) corners = detectCornersFromSpeed(traces.get(refNum).trace);
  if (corners.length === 0) throw new Error("Could not identify corners on this circuit from telemetry.");

  // per-corner rankings
  const cornerResults = corners.map((c) => {
    const perDriver = [...traces.entries()].map(([num, d]) => ({ num, ...windowStats(d.trace, c.bin) }));
    perDriver.sort((a, b) => b.avg - a.avg);
    const best = perDriver[0].avg;
    const withGap = perDriver.map((p) => ({ ...p, gap: best - p.avg }));
    // team aggregates
    const byTeam = new Map();
    for (const p of perDriver) {
      const t = driverInfo.get(p.num).team;
      if (!byTeam.has(t)) byTeam.set(t, { team: t, speeds: [], colour: driverInfo.get(p.num).colour });
      byTeam.get(t).speeds.push(p.avg);
    }
    const teams = [...byTeam.values()].map((t) => ({
      ...t, avg: t.speeds.reduce((a, b) => a + b, 0) / t.speeds.length,
    })).sort((a, b) => b.avg - a.avg);
    return { ...c, ranking: withGap, bestTeam: teams[0], teams };
  });

  // driver aggregates (+ tyre compound of the best lap)
  const driverStats = [...traces.entries()].map(([num, d]) => {
    let won = 0, defSum = 0;
    cornerResults.forEach((c) => {
      const me = c.ranking.find((r) => r.num === num);
      if (c.ranking[0].num === num) won++;
      defSum += c.ranking[0].avg - me.avg;
    });
    return {
      num, info: driverInfo.get(num), lap: d.lap, topSpeed: d.topSpeed, avgSpeed: d.avgSpeed,
      won, deficit: defSum / cornerResults.length,
      compound: compoundFor(stintsByDriver, num, d.lap.lap_number),
    };
  }).sort((a, b) => a.lap.lap_duration - b.lap.lap_duration);

  // team aggregates
  const teamMap = new Map();
  for (const ds of driverStats) {
    const t = ds.info.team;
    if (!teamMap.has(t)) teamMap.set(t, { team: t, colour: ds.info.colour, drivers: [], laps: [], won: 0, cornerAvgs: [] });
    teamMap.get(t).drivers.push(ds);
    teamMap.get(t).laps.push(ds.lap.lap_duration);
  }
  for (const c of cornerResults) {
    for (const t of c.teams) {
      const entry = teamMap.get(t.team);
      if (entry) { entry.cornerAvgs.push(t.avg); if (c.bestTeam.team === t.team) entry.won++; }
    }
  }
  const teamStats = [...teamMap.values()].map((t) => {
    const avgLap = t.laps.reduce((a, b) => a + b, 0) / t.laps.length;
    const avgCorner = t.cornerAvgs.length ? t.cornerAvgs.reduce((a, b) => a + b, 0) / t.cornerAvgs.length : 0;
    // strongest turn = smallest deficit to the corner-best average
    let strong = null, strongGap = Infinity;
    cornerResults.forEach((c) => {
      const mine = c.teams.find((x) => x.team === t.team);
      if (!mine) return;
      const gap = c.bestTeam.avg - mine.avg;
      if (gap < strongGap) { strongGap = gap; strong = c.number; }
    });
    return { ...t, avgLap, avgCorner, strongest: strong };
  }).sort((a, b) => b.won - a.won || b.avgCorner - a.avgCorner);

  // race pace (Race / Sprint only — needs full-lap stint data)
  const stype = session.session_type || "";
  const pace = (/race|sprint/i.test(stype) && !/qualif/i.test(stype)) ? computePace(laps, stintsByDriver) : [];

  return {
    session, meeting, driverStats, teamStats, cornerResults, traces, driverInfo,
    classification, cornerSource, circuit, weatherSum: summarizeWeather(weather),
    flagEvents: summarizeFlags(raceControl), pace,
  };
}

/* =====================================================================
 * MAIN ANALYSIS — only the selected session
 * ===================================================================== */
async function runAnalysis() {
  clearError();
  $("results").hidden = true;
  const sessionKey = $("sessionSelect").value;
  if (!sessionKey) return;
  const session = state.sessions.find((s) => String(s.session_key) === String(sessionKey));
  if (!session) { showError("Selected session is no longer available. Please re-select the Grand Prix and session."); return; }
  const meeting = state.meetingByKey.get(String($("gpSelect").value)) || null;
  const driverLimit = parseInt($("driverLimitSelect").value, 10) || 99;
  // lock the UI so a mid-run change can't mix two analyses
  const locked = ["yearSelect", "gpSelect", "sessionSelect", "driverLimitSelect", "analyzeBtn"];
  const wasEnabled = {};
  locked.forEach((id) => { wasEnabled[id] = !$(id).disabled; $(id).disabled = true; });

  try {
    const a = await analyzeSessionData(sessionKey, session, meeting, driverLimit,
      (frac, text) => setStatus(text, frac));
    state.analysis = a;
    saveShareHash();

    setStatus("Rendering…", 0.95);
    await sleep(30);
    await renderAll();
    $("results").hidden = false;
    setStatus(`Done — analyzed ${a.driverStats.length} drivers over ${a.cornerResults.length} corners (${a.cornerSource} apexes). Only the selected session was analyzed.`, 1);
  } catch (e) {
    console.error(e);
    showError((e && e.message) || String(e));
  } finally {
    locked.forEach((id) => { $(id).disabled = !wasEnabled[id]; });
    if ($("sessionSelect").disabled) $("analyzeBtn").disabled = true;
  }
}

/* =====================================================================
 * RENDERING
 * ===================================================================== */
async function renderAll() {
  const a = state.analysis;
  renderSummary(a);
  renderContext(a);
  renderCornerTable(a);
  renderDriverTable(a);
  renderTeamTable(a);
  renderSectorTable(a);
  renderPace(a);
  await renderTrackMap(a);
  renderSpeedChart(a, null);
  renderClassification(a);
  populateH2H(a);
  renderH2H();
}

function pillFor(compound) {
  const c = String(compound || "Unknown").toUpperCase();
  const cls = c === "SOFT" ? "pill-soft" : c === "MEDIUM" ? "pill-medium" : c === "HARD" ? "pill-hard" : "pill-unknown";
  const label = c === "SOFT" ? "SOFT" : c === "MEDIUM" ? "MED" : c === "HARD" ? "HARD" : c === "Unknown" ? "—" : esc(compound);
  return `<span class="pill ${cls}">${label}</span>`;
}
function portraitFor(info, size) {
  if (!info || !info.img) return "";
  const px = size || 26;
  return `<img class="portrait" style="width:${px}px;height:${px}px" loading="lazy" src="${esc(info.img)}" alt="" onerror="this.remove()" />`;
}

function renderSummary(a) {
  const { session, meeting } = a;
  $("sessionMeta").innerHTML =
    `<div><b>Event</b>${esc(meeting ? meeting.meeting_name : session.meeting_key)} ${meeting ? `· ${esc(meeting.location)}` : ""}</div>` +
    `<div><b>Session</b>${esc(session.session_name)} (${esc(session.session_type)})</div>` +
    `<div><b>Date</b>${new Date(session.date_start).toLocaleString()}</div>` +
    `<div><b>Drivers analyzed</b>${a.driverStats.length}</div>` +
    `<div><b>Corners</b>${a.cornerResults.length} (${a.cornerSource})</div>`;
  const fastest = a.driverStats[0];
  const cornerKing = [...a.driverStats].sort((x, y) => y.won - x.won)[0];
  const teamKing = a.teamStats[0];
  $("summaryChips").innerHTML =
    `<span class="chip">⏱️ <b>Fastest lap</b> ${esc(fastest.info.acronym)} — ${fmtLap(fastest.lap.lap_duration)}</span>` +
    `<span class="chip">↩️ <b>Most corners won (driver)</b> ${esc(cornerKing.info.acronym)} — ${cornerKing.won}</span>` +
    `<span class="chip">🏆 <b>Most corners won (team)</b> <span class="swatch" style="background:${teamKing.colour}"></span>${esc(teamKing.team)} — ${teamKing.won}</span>`;
}

function renderCornerTable(a) {
  const tb = $$("#cornerTable tbody");
  tb.innerHTML = "";
  a.cornerResults.forEach((c, idx) => {
    const best = c.ranking[0];
    const bd = a.driverInfo.get(best.num);
    const top3 = c.ranking.slice(0, 3)
      .map((r) => `${esc(a.driverInfo.get(r.num).acronym)}${r.gap > 0.0005 ? ` (+${r.gap.toFixed(1)})` : ""}`)
      .join(", ");
    const tr = document.createElement("tr");
    tr.id = `corner-row-${idx}`;
    tr.innerHTML =
      `<td class="best-cell">T${c.number}${c.official ? "" : "*"}</td>` +
      `<td class="num">${(100 * c.bin / (N_BINS - 1)).toFixed(1)}%</td>` +
      `<td>${portraitFor(bd)}<span class="swatch" style="background:${bd.colour}"></span><span class="best-cell">${esc(bd.acronym)}</span></td>` +
      `<td class="num">${best.avg.toFixed(1)} km/h <span style="color:var(--muted)">(min ${best.min.toFixed(0)})</span></td>` +
      `<td><span class="swatch" style="background:${c.bestTeam.colour}"></span>${esc(c.bestTeam.team)}</td>` +
      `<td>${top3}</td>`;
    tr.addEventListener("mouseenter", () => { state.highlightBin = c.bin; redrawStaticMap(); });
    tr.addEventListener("mouseleave", () => { state.highlightBin = null; redrawStaticMap(); });
    tb.appendChild(tr);
  });
}

function renderDriverTable(a) {
  const tb = $$("#driverTable tbody");
  tb.innerHTML = "";
  for (const d of a.driverStats) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${portraitFor(d.info)}<span class="swatch" style="background:${d.info.colour}"></span><span class="best-cell">${esc(d.info.acronym)}</span> <span style="color:var(--muted)">${esc(d.info.name)}</span></td>` +
      `<td>${esc(d.info.team)}</td>` +
      `<td class="num">${fmtLap(d.lap.lap_duration)}</td>` +
      `<td>${pillFor(d.compound)}</td>` +
      `<td class="num">${d.topSpeed.toFixed(0)} km/h</td>` +
      `<td class="num">${d.avgSpeed.toFixed(1)} km/h</td>` +
      `<td class="num">${d.won}${d.won > 0 ? `<span class="tag">BEST</span>` : ""}</td>` +
      `<td class="num">+${d.deficit.toFixed(2)} km/h</td>`;
    tb.appendChild(tr);
  }
}

function renderTeamTable(a) {
  const tb = $$("#teamTable tbody");
  tb.innerHTML = "";
  for (const t of a.teamStats) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><span class="swatch" style="background:${t.colour}"></span><span class="best-cell">${esc(t.team)}</span></td>` +
      `<td>${t.drivers.map((d) => esc(d.info.acronym)).join(", ")}</td>` +
      `<td class="num">${fmtLap(t.avgLap)}</td>` +
      `<td class="num">${t.won}</td>` +
      `<td class="num">${t.avgCorner.toFixed(1)} km/h</td>` +
      `<td class="num">${t.strongest != null ? "T" + t.strongest : "—"}</td>`;
    tb.appendChild(tr);
  }
}

/* ---- track shape: official centerline, else fastest driver's outline ---- */
function cleanShape(xs, ys) {
  const x = [], y = [];
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { x.push(xs[i]); y.push(ys[i]); }
  }
  return x.length >= 10 ? { x, y } : null;
}
async function getTrackShape(a) {
  if (a.circuit && Array.isArray(a.circuit.x) && a.circuit.x.length > 10) {
    const clean = cleanShape(a.circuit.x, a.circuit.y || []);
    if (clean) return clean;
  }
  // Fallback: one extra live request — outline from the fastest driver's
  // location trace during their best lap.
  const ref = a.driverStats[0];
  const start = new Date(ref.lap.date_start);
  const from = new Date(start.getTime() - 2000).toISOString();
  const to = new Date(start.getTime() + ref.lap.lap_duration * 1000 + 3000).toISOString();
  const rows = await apiGet(
    `${OPENF1}/location?session_key=${a.session.session_key}&driver_number=${ref.num}` +
    `&date>${encodeURIComponent(from)}&date<${encodeURIComponent(to)}`, "track outline");
  const pts = rows.filter((r) => r.x != null && r.y != null).sort((p, q) => Date.parse(p.date) - Date.parse(q.date));
  if (pts.length < 10) return null;
  return cleanShape(pts.map((p) => p.x), pts.map((p) => p.y));
}

/* ---- HiDPI canvas: crisp rendering on retina displays ----
 * Keeps the drawing coordinate space in CSS pixels while the backing
 * store scales with devicePixelRatio. Falls back to 900px wide when
 * layout info is unavailable (e.g. headless test env). */
function cssDpr() {
  return (typeof window !== "undefined" && window.devicePixelRatio) || 1;
}
function fitCanvas(canvas, aspect) {
  const dpr = cssDpr();
  const cssW = Math.max(320, Math.round(canvas.clientWidth || canvas.width || 900));
  const W = cssW, H = Math.round(cssW * aspect);
  const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H, dpr };
}
function shapePixels(shape, W, H) {
  const { x, y } = shape;
  const n = x.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  const pad = 60;
  const sc = Math.min((W - 2 * pad) / Math.max(1e-9, maxX - minX), (H - 2 * pad) / Math.max(1e-9, maxY - minY));
  const PX = new Float64Array(n), PY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    PX[i] = pad + (x[i] - minX) * sc + ((W - 2 * pad) - (maxX - minX) * sc) / 2;
    PY[i] = pad + (maxY - y[i]) * sc + ((H - 2 * pad) - (maxY - minY) * sc) / 2;
  }
  return { PX, PY, n };
}

async function renderTrackMap(a) {
  const canvas = $("trackMap");
  const pre = fitCanvas(canvas, 600 / 900);
  const ctx = pre.ctx;
  ctx.clearRect(0, 0, pre.W, pre.H);
  setStatus("Drawing track map…", 0.97);
  let shape = null;
  try { shape = await getTrackShape(a); } catch (e) { console.warn("track shape failed", e); }
  if (!shape) {
    ctx.fillStyle = "#9aa4bd"; ctx.font = "16px sans-serif";
    ctx.fillText("Track outline unavailable (location data missing for this session).", 30, 60);
    $("mapLegend").textContent = "";
    return;
  }
  const n = shape.x.length;
  // fit to canvas (loop-based min/max: safe for large arrays)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (shape.x[i] < minX) minX = shape.x[i];
    if (shape.x[i] > maxX) maxX = shape.x[i];
    if (shape.y[i] < minY) minY = shape.y[i];
    if (shape.y[i] > maxY) maxY = shape.y[i];
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite) || maxX === minX || maxY === minY) {
    ctx.fillStyle = "#9aa4bd"; ctx.font = "16px sans-serif";
    ctx.fillText("Track outline data was invalid for this session.", 30, 60);
    $("mapLegend").textContent = "";
    return;
  }
  const fit = fitCanvas(canvas, 600 / 900);
  const pix = shapePixels(shape, fit.W, fit.H);
  state.mapShape = { x: shape.x, y: shape.y, PX: pix.PX, PY: pix.PY, n: pix.n };
  state.mapDims = { W: fit.W, H: fit.H, dpr: fit.dpr };
  stopReplay();
  drawTrackMap(a, null);
  $("mapLegend").innerHTML = [...new Map(a.teamStats.map((t) => [t.team, t.colour])).entries()]
    .map(([t, col]) => `<span><span class="swatch" style="background:${col}"></span>${esc(t)}</span>`).join("");
}

function cornerPixel(c, shape) {
  const i = Math.max(0, Math.min(shape.n - 1, Math.round((c.bin / (N_BINS - 1)) * (shape.n - 1))));
  return { x: shape.PX[i], y: shape.PY[i] };
}

function drawTrackMap(a, highlightBin) {
  const canvas = $("trackMap");
  const shape = state.mapShape;
  if (!shape || !shape.x) return;
  const fit = fitCanvas(canvas, 600 / 900);
  const pix = shapePixels(shape, fit.W, fit.H);
  shape.PX = pix.PX; shape.PY = pix.PY; shape.n = pix.n;
  state.mapDims = { W: fit.W, H: fit.H, dpr: fit.dpr };
  const ctx = fit.ctx;
  const { PX, PY, n } = shape;
  ctx.clearRect(0, 0, fit.W, fit.H);
  // fastest team per bin -> segment colours
  const SEGS = 240;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let sgm = 0; sgm < SEGS; sgm++) {
    const b0 = Math.floor((sgm / SEGS) * (N_BINS - 1));
    const b1 = Math.floor(((sgm + 1) / SEGS) * (N_BINS - 1));
    const mid = Math.floor((b0 + b1) / 2);
    // team with highest avg resampled speed at this bin
    let bestV = -1;
    const teamSpeed = new Map();
    for (const ds of a.driverStats) {
      const tr = a.traces.get(ds.num).trace;
      const t = ds.info.team;
      if (!teamSpeed.has(t)) teamSpeed.set(t, { sum: 0, n: 0, colour: ds.info.colour });
      const e = teamSpeed.get(t); e.sum += tr[mid]; e.n++;
    }
    let colour = "#555";
    for (const e of teamSpeed.values()) {
      const avg = e.sum / e.n;
      if (avg > bestV) { bestV = avg; colour = e.colour; }
    }
    const i0 = Math.floor((sgm / SEGS) * (n - 1));
    const i1 = Math.floor(((sgm + 1) / SEGS) * (n - 1));
    ctx.strokeStyle = colour; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(PX[i0], PY[i0]); ctx.lineTo(PX[i1], PY[i1]); ctx.stroke();
  }
  // corner apex markers
  state.apexPixels = a.cornerResults.map((c, idx) => ({ ...cornerPixel(c, shape), idx, bin: c.bin }));
  ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  state.apexPixels.forEach((ap, k) => {
    const c = a.cornerResults[k];
    if (highlightBin != null && c.bin === highlightBin) {
      ctx.strokeStyle = "#ffd34d"; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(ap.x, ap.y, 19, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = "#0b0e14";
    ctx.beginPath(); ctx.arc(ap.x, ap.y, 13, 0, 7); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ap.x, ap.y, 13, 0, 7); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(String(c.number), ap.x, ap.y);
  });
  // cache the static frame for instant redraws + replay background
  try {
    if (!state.mapCache || state.mapCache.width !== canvas.width) {
      state.mapCache = document.createElement("canvas");
      state.mapCache.width = canvas.width; state.mapCache.height = canvas.height;
    }
    state.mapCache.getContext("2d").drawImage(canvas, 0, 0);
  } catch { /* non-browser env */ }
}

function redrawStaticMap() {
  const a = state.analysis;
  if (!a || !state.mapShape || replay.on) return;
  drawTrackMap(a, state.highlightBin);
}

function onTrackClick(ev) {
  const a = state.analysis;
  if (!a || !state.apexPixels.length) return;
  const canvas = $("trackMap");
  const rect = canvas.getBoundingClientRect();
  const dpr = cssDpr();
  const scaleX = (canvas.width / dpr) / Math.max(1, rect.width);
  const scaleY = (canvas.height / dpr) / Math.max(1, rect.height);
  const mx = (ev.clientX - rect.left) * scaleX, my = (ev.clientY - rect.top) * scaleY;
  let best = null, bestD = 26 * 26;
  for (const ap of state.apexPixels) {
    const d = (ap.x - mx) * (ap.x - mx) + (ap.y - my) * (ap.y - my);
    if (d < bestD) { bestD = d; best = ap; }
  }
  if (!best) return;
  const row = document.getElementById(`corner-row-${best.idx}`);
  if (!row) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the CSS animation
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 2100);
}

/* ---- speed traces ---- */
let chartVisible = new Set();
function renderSpeedChart(a, preset) {
  const box = $("traceToggles");
  box.innerHTML = "";
  const sorted = [...a.driverStats].sort((x, y) => x.lap.lap_duration - y.lap.lap_duration);
  const nums = sorted.map((d) => d.num);
  const initial = Array.isArray(preset) && preset.length
    ? preset.filter((n) => nums.includes(n))
    : sorted.slice(0, 6).map((d) => d.num);
  chartVisible = new Set(initial.length ? initial : nums.slice(0, 1));
  for (const d of sorted) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = chartVisible.has(d.num);
    cb.addEventListener("change", (e) => {
      e.target.checked ? chartVisible.add(d.num) : chartVisible.delete(d.num);
      drawSpeedChart(a, chartVisible);
    });
    lab.appendChild(cb);
    const span = document.createElement("span");
    span.innerHTML = `<span class="swatch" style="background:${d.info.colour}"></span>${esc(d.info.acronym)}`;
    lab.appendChild(span);
    box.appendChild(lab);
  }
  drawSpeedChart(a, chartVisible);
}

function drawSpeedChart(a, visible) {
  const canvas = $("speedChart");
  const fit = fitCanvas(canvas, 380 / 900);
  const ctx = fit.ctx;
  const W = fit.W, H = fit.H;
  ctx.clearRect(0, 0, W, H);
  const padL = 52, padR = 14, padT = 18, padB = 34;
  let mn = Infinity, mx = -Infinity;
  for (const num of visible) {
    const tr = a.traces.get(num)?.trace;
    if (!tr) continue;
    for (const v of tr) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  }
  if (!isFinite(mn)) {
    ctx.fillStyle = "#9aa4bd"; ctx.font = "15px sans-serif";
    ctx.fillText("Select at least one driver.", 30, 60);
    return;
  }
  mn = Math.floor((mn - 8) / 10) * 10; mx = Math.ceil((mx + 8) / 10) * 10;
  const X = (b) => padL + (b / (N_BINS - 1)) * (W - padL - padR);
  const Y = (v) => padT + (1 - (v - mn) / Math.max(1e-9, mx - mn)) * (H - padT - padB);
  // grid
  ctx.strokeStyle = "#232c47"; ctx.fillStyle = "#9aa4bd"; ctx.font = "11px sans-serif";
  ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.lineWidth = 1;
  for (let g = 0; g <= 6; g++) {
    const v = mn + ((mx - mn) * g) / 6;
    ctx.beginPath(); ctx.moveTo(padL, Y(v)); ctx.lineTo(W - padR, Y(v)); ctx.stroke();
    ctx.fillText(`${v.toFixed(0)}`, padL - 6, Y(v));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let p = 0; p <= 100; p += 10) ctx.fillText(`${p}%`, X(((N_BINS - 1) * p) / 100), H - padB + 8);
  // corner apex guides
  ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.setLineDash([4, 4]);
  ctx.fillStyle = "rgba(255,255,255,.55)";
  for (const c of a.cornerResults) {
    ctx.beginPath(); ctx.moveTo(X(c.bin), padT); ctx.lineTo(X(c.bin), H - padB); ctx.stroke();
    ctx.fillText(String(c.number), X(c.bin), 4);
  }
  ctx.setLineDash([]);
  // traces
  ctx.lineWidth = 2;
  for (const num of visible) {
    const ds = a.driverStats.find((d) => d.num === num);
    const tr = a.traces.get(num)?.trace;
    if (!ds || !tr) continue;
    ctx.strokeStyle = ds.info.colour;
    ctx.beginPath();
    for (let b = 0; b < N_BINS; b += 2) {
      const xx = X(b), yy = Y(tr[b]);
      b === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
  ctx.fillStyle = "#9aa4bd"; ctx.textAlign = "left";
  ctx.fillText("km/h", 6, padT - 2);
}

function renderClassification(a) {
  const tb = $$("#resultTable tbody");
  tb.innerHTML = "";
  const rows = [...(a.classification || [])].sort((x, y) => (x.position ?? 999) - (y.position ?? 999));
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="5" style="color:var(--muted)">Official classification not published for this session.</td></tr>`;
    return;
  }
  for (const r of rows) {
    const info = a.driverInfo.get(r.driver_number) || { acronym: `#${r.driver_number}`, name: "", team: "", colour: "#999", img: "" };
    const dur = Array.isArray(r.duration) ? r.duration.filter(Boolean).join(" / ") : r.duration;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="num">${r.position ?? "—"}</td>` +
      `<td>${portraitFor(info)}<span class="swatch" style="background:${info.colour}"></span>${esc(info.acronym)} <span style="color:var(--muted)">${esc(info.name)}</span></td>` +
      `<td>${esc(info.team)}</td>` +
      `<td class="num">${dur != null && dur !== "" ? (typeof dur === "number" ? fmtLap(dur) : esc(dur)) : "—"}</td>` +
      `<td class="num">${r.number_of_laps ?? "—"}</td>`;
    tb.appendChild(tr);
  }
}

/* ---------------- context strip: weather + flags ---------------- */
function renderContext(a) {
  const box = $("contextStrip");
  const chips = [];
  const w = a.weatherSum;
  if (w) {
    if (w.track) chips.push(`<span class="chip">🌡️ <b>Track</b> ${w.track[0].toFixed(1)}–${w.track[1].toFixed(1)}°C</span>`);
    if (w.air) chips.push(`<span class="chip">🌡️ <b>Air</b> ${w.air[0].toFixed(1)}–${w.air[1].toFixed(1)}°C</span>`);
    if (w.windMax != null) chips.push(`<span class="chip">💨 <b>Wind</b> up to ${w.windMax.toFixed(1)} m/s</span>`);
    chips.push(w.rain
      ? `<span class="chip">🌧️ <b>Rain detected</b> during session</span>`
      : `<span class="chip">☀️ <b>Dry</b> session</span>`);
  }
  const flags = a.flagEvents || [];
  for (const f of flags.slice(0, 6)) {
    chips.push(`<span class="chip">🚩 <b>${esc(f.flag)}</b> ${esc(f.t)} <span style="color:var(--muted)">${esc(f.msg.slice(0, 60))}</span></span>`);
  }
  if (flags.length > 6) chips.push(`<span class="chip">+${flags.length - 6} more flag/safety-car events</span>`);
  box.innerHTML = chips.join("") || `<span class="chip">No weather / race-control data published for this session.</span>`;
}

/* ---------------- sectors & speed traps ---------------- */
function renderSectorTable(a) {
  const tb = $$("#sectorTable tbody");
  tb.innerHTML = "";
  for (const d of a.driverStats) {
    const L = d.lap;
    const s = (v) => (v == null || !isFinite(v) ? "—" : v.toFixed(3));
    const v = (x) => (x == null || !isFinite(x) ? "—" : `${x} km/h`);
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${portraitFor(d.info)}<span class="best-cell">${esc(d.info.acronym)}</span></td>` +
      `<td class="num">${s(L.duration_sector_1)}</td>` +
      `<td class="num">${s(L.duration_sector_2)}</td>` +
      `<td class="num">${s(L.duration_sector_3)}</td>` +
      `<td class="num">${fmtLap(L.lap_duration)}</td>` +
      `<td class="num">${v(L.i1_speed)}</td>` +
      `<td class="num">${v(L.i2_speed)}</td>` +
      `<td class="num">${v(L.st_speed)}</td>` +
      `<td>${pillFor(d.compound)}</td>`;
    tb.appendChild(tr);
  }
}

/* ---------------- race pace & degradation ---------------- */
function renderPace(a) {
  const card = $("racePaceCard");
  const tb = $$("#paceTable tbody");
  tb.innerHTML = "";
  if (!a.pace || a.pace.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  for (const p of a.pace) {
    const info = a.driverInfo.get(p.num) || { acronym: `#${p.num}`, colour: "#999" };
    const deg = `${p.slope >= 0 ? "+" : ""}${p.slope.toFixed(3)}`;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${portraitFor(info)}<span class="swatch" style="background:${info.colour}"></span><span class="best-cell">${esc(info.acronym)}</span></td>` +
      `<td class="num">${p.stint}</td>` +
      `<td>${pillFor(p.compound)} <span style="color:var(--muted)">age ${esc(p.age)}</span></td>` +
      `<td class="num">${p.n}</td>` +
      `<td class="num">${fmtLap(p.avg)}</td>` +
      `<td class="num">${deg}</td>`;
    tb.appendChild(tr);
  }
}

/* ---------------- head-to-head ---------------- */
function populateH2H(a) {
  for (const id of ["h2hA", "h2hB"]) {
    const sel = $(id);
    sel.innerHTML = "";
    for (const d of a.driverStats) {
      const o = document.createElement("option");
      o.value = d.num;
      o.textContent = `${d.info.acronym} — ${d.info.team} (${fmtLap(d.lap.lap_duration)})`;
      sel.appendChild(o);
    }
  }
  if (a.driverStats.length >= 2) {
    $("h2hA").value = String(a.driverStats[0].num);
    $("h2hB").value = String(a.driverStats[1].num);
  }
}
function renderH2H() {
  const a = state.analysis;
  const box = $("h2hResult");
  if (!a) return;
  const na = parseInt($("h2hA").value, 10), nb = parseInt($("h2hB").value, 10);
  const A = a.driverStats.find((d) => d.num === na), B = a.driverStats.find((d) => d.num === nb);
  if (!A || !B) { box.innerHTML = `<p class="hint">Select two drivers to compare.</p>`; return; }
  if (na === nb) { box.innerHTML = `<p class="hint">Pick two <strong>different</strong> drivers.</p>`; return; }
  let wa = 0, wb = 0;
  const rows = a.cornerResults.map((c) => {
    const ra = c.ranking.find((r) => r.num === na), rb = c.ranking.find((r) => r.num === nb);
    const delta = ra.avg - rb.avg; // + means A faster
    if (delta >= 0) wa++; else wb++;
    const win = delta >= 0 ? A : B;
    return `<tr><td class="best-cell">T${c.number}</td>` +
      `<td class="num">${ra.avg.toFixed(1)}</td><td class="num">${rb.avg.toFixed(1)}</td>` +
      `<td class="num" style="color:${delta >= 0 ? "var(--good)" : "var(--accent-2)"}">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}</td>` +
      `<td><span class="swatch" style="background:${win.info.colour}"></span>${esc(win.info.acronym)}</td></tr>`;
  }).join("");
  const lapDelta = A.lap.lap_duration - B.lap.lap_duration;
  box.innerHTML =
    `<div class="chips" style="margin-bottom:10px">` +
    `<span class="chip">${portraitFor(A.info)}<b>${esc(A.info.acronym)}</b> ${wa} corners ${pillFor(A.compond)}</span>` +
    `<span class="chip">${portraitFor(B.info)}<b>${esc(B.info.acronym)}</b> ${wb} corners ${pillFor(B.compond)}</span>` +
    `<span class="chip">⏱️ <b>Lap delta</b> ${lapDelta === 0 ? "dead heat" : `${esc((lapDelta > 0 ? B : A).info.acronym)} by ${Math.abs(lapDelta).toFixed(3)}s`}</span>` +
    `</div><div class="table-scroll"><table style="min-width:420px"><thead><tr>` +
    `<th>Turn</th><th class="num">${esc(A.info.acronym)} km/h</th><th class="num">${esc(B.info.acronym)} km/h</th>` +
    `<th class="num">Δ (A−B)</th><th>Winner</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  // sync the main speed chart to just these two
  renderSpeedChart(a, [na, nb]);
}

/* ---------------- weekend view ---------------- */
async function runWeekend() {
  const a0 = state.analysis;
  if (!a0) return;
  const sessions = state.sessions.filter((s) => !s.is_cancelled);
  if (sessions.length < 2) { showError("This event has fewer than 2 sessions — nothing to compare."); return; }
  const btn = $("weekendBtn");
  btn.disabled = true;
  clearError();
  try {
    const perSession = [];
    let si = 0;
    for (const s of sessions) {
      si++;
      try {
        const r = await analyzeSessionData(s.session_key, a0.meeting, 5,
          (frac, text) => setStatus(`Weekend ${si}/${sessions.length} · ${s.session_name}: ${text}`, (si - 1 + frac) / sessions.length));
        perSession.push({ session: s, data: r });
      } catch (e) {
        console.warn(`Weekend: ${s.session_name} failed: ${e.message}`);
        perSession.push({ session: s, data: null, error: (e && e.message) || String(e) });
      }
    }
    renderWeekend(perSession);
    setStatus(`Weekend view done — ${perSession.filter((p) => p.data).length}/${perSession.length} sessions analyzed.`, 1);
  } catch (e) {
    console.error(e);
    showError((e && e.message) || String(e));
  } finally {
    btn.disabled = false;
  }
}
function cornerKey(c, idx) { return c.official ? `T${c.number}` : `#${idx}`; }
function renderWeekend(perSession) {
  const box = $("weekendResult");
  const ok = perSession.filter((p) => p.data);
  if (!ok.length) { box.innerHTML = `<p class="hint">No session could be analyzed for this weekend.</p>`; return; }
  const lines = ok.map((p) => {
    const f = p.data.driverStats[0];
    return `<span class="chip"><b>${esc(p.session.session_name)}</b> ${esc(f.info.acronym)} ${fmtLap(f.lap.lap_duration)} ${pillFor(f.compond)}</span>`;
  }).join("");
  // rows = union of corner keys in weekend order
  const order = [];
  for (const p of ok) {
    p.data.cornerResults.forEach((c, idx) => {
      const k = cornerKey(c, idx);
      if (!order.includes(k)) order.push(k);
    });
  }
  const head = `<th>Turn</th>` + ok.map((p) => `<th>${esc(p.session.session_name)}</th>`).join("");
  const body = order.map((k) => {
    const cells = ok.map((p) => {
      const idx = p.data.cornerResults.findIndex((c, i) => cornerKey(c, i) === k);
      if (idx < 0) return `<td style="color:var(--muted)">—</td>`;
      const t = p.data.cornerResults[idx].bestTeam;
      return `<td><span class="swatch" style="background:${t.colour}"></span>${esc(t.team)}</td>`;
    }).join("");
    return `<tr><td class="best-cell">${esc(k)}</td>${cells}</tr>`;
  }).join("");
  const failed = perSession.filter((p) => !p.data)
    .map((p) => `<span class="chip">⚠️ ${esc(p.session.session_name)}: ${esc((p.error || "failed").slice(0, 80))}</span>`).join("");
  box.innerHTML = `<div class="chips" style="margin-bottom:10px">${lines}${failed}</div>` +
    `<div class="table-scroll"><table style="min-width:520px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------------- CSV export ---------------- */
function downloadCSV(name, headers, rows) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const el = document.createElement("a");
  el.href = URL.createObjectURL(blob);
  el.download = name;
  document.body.appendChild(el);
  el.click();
  setTimeout(() => { try { URL.revokeObjectURL(el.href); el.remove(); } catch { /* ignore */ } }, 800);
}
function exportSessionCSV(which) {
  const a = state.analysis;
  if (!a) return;
  const tag = `${a.session.session_name.replace(/\s+/g, "")}_${a.session.session_key}`;
  const drv = (n) => (a.driverInfo.get(n) || {}).acronym || `#${n}`;
  if (which === "corners") {
    downloadCSV(`corners_${tag}.csv`,
      ["turn", "apex_pct", "best_driver", "best_avg_kmh", "best_min_kmh", "best_team", "top3"],
      a.cornerResults.map((c) => [
        `T${c.number}`, (100 * c.bin / (N_BINS - 1)).toFixed(1),
        drv(c.ranking[0].num), c.ranking[0].avg.toFixed(2), c.ranking[0].min.toFixed(1),
        c.bestTeam.team, c.ranking.slice(0, 3).map((r) => `${drv(r.num)} (+${r.gap.toFixed(2)})`).join("; "),
      ]));
  } else if (which === "drivers") {
    downloadCSV(`drivers_${tag}.csv`,
      ["driver", "team", "best_lap_s", "tyre", "top_kmh", "avg_kmh", "corners_won", "avg_deficit_kmh"],
      a.driverStats.map((d) => [d.info.acronym, d.info.team, d.lap.lap_duration.toFixed(3),
        d.compound, d.topSpeed.toFixed(1), d.avgSpeed.toFixed(2), d.won, d.deficit.toFixed(3)]));
  } else if (which === "teams") {
    downloadCSV(`teams_${tag}.csv`,
      ["team", "drivers", "avg_best_lap_s", "corners_won", "avg_corner_kmh", "strongest_turn"],
      a.teamStats.map((t) => [t.team, t.drivers.map((d) => d.info.acronym).join("; "),
        t.avgLap.toFixed(3), t.won, t.avgCorner.toFixed(2), t.strongest ?? ""]));
  } else if (which === "sectors") {
    downloadCSV(`sectors_${tag}.csv`,
      ["driver", "s1_s", "s2_s", "s3_s", "best_lap_s", "i1_kmh", "i2_kmh", "st_kmh", "tyre"],
      a.driverStats.map((d) => [d.info.acronym, d.lap.duration_sector_1 ?? "", d.lap.duration_sector_2 ?? "",
        d.lap.duration_sector_3 ?? "", d.lap.lap_duration.toFixed(3), d.lap.i1_speed ?? "",
        d.lap.i2_speed ?? "", d.lap.st_speed ?? "", d.compound]));
  } else if (which === "pace") {
    if (!a.pace || !a.pace.length) { showError("No race-pace data — run a Race or Sprint session first."); return; }
    downloadCSV(`pace_${tag}.csv`,
      ["driver", "stint", "compound", "tyre_age", "laps", "avg_pace_s", "deg_s_per_lap"],
      a.pace.map((p) => [drv(p.num), p.stint, p.compound, p.age, p.n, p.avg.toFixed(3), p.slope.toFixed(4)]));
  }
}

/* ---------------- best-lap replay on the track map ---------------- */
const replay = { on: false, t: 0, raf: 0, last: 0, racers: [] };
function cumTimeFor(trace, lapDuration) {
  const n = trace.length, w = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { w[i] = 1 / Math.max(trace[i], 1); sum += w[i]; }
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += (w[i] / sum) * lapDuration; cum[i] = acc; }
  return cum;
}
function binAtTime(cum, t) {
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function toggleReplay() {
  replay.on ? stopReplay() : startReplay();
}
function startReplay() {
  const a = state.analysis;
  if (!a || !state.mapShape || !state.mapShape.x) return;
  drawTrackMap(a, null); // rebuild static frame + dims at current size
  const top = [...a.driverStats].sort((x, y) => x.lap.lap_duration - y.lap.lap_duration).slice(0, 6);
  replay.racers = top.map((d) => ({
    ...d, cum: cumTimeFor(a.traces.get(d.num).trace, d.lap.lap_duration),
  }));
  replay.t = 0;
  replay.on = true;
  $("replayBtn").textContent = "⏸ Stop replay";
  const step = (ts) => {
    if (!replay.on) return;
    if (!replay.last) replay.last = ts;
    const mult = parseFloat($("replaySpeed").value) || 2;
    replay.t += ((ts - replay.last) / 1000) * mult;
    replay.last = ts;
    drawReplayFrame();
    replay.raf = requestAnimationFrame(step);
  };
  replay.last = 0;
  replay.raf = requestAnimationFrame(step);
}
function drawReplayFrame() {
  const a = state.analysis;
  const dims = state.mapDims;
  if (!a || !state.mapShape || !state.mapShape.PX || !state.mapCache || !dims) return;
  const canvas = $("trackMap");
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0); // blit cache 1:1 in backing pixels
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.mapCache, 0, 0);
  ctx.setTransform(dims.dpr, 0, 0, dims.dpr, 0, 0); // dots in CSS pixels
  const { PX, PY, n } = state.mapShape;
  ctx.font = "bold 11px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  for (const r of replay.racers) {
    const t = replay.t % r.lap.lap_duration;
    const i = Math.max(0, Math.min(n - 1, Math.round((binAtTime(r.cum, t) / (N_BINS - 1)) * (n - 1))));
    ctx.fillStyle = r.info.colour;
    ctx.beginPath(); ctx.arc(PX[i], PY[i], 8, 0, 7); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(PX[i], PY[i], 8, 0, 7); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(r.info.acronym, PX[i] + 11, PY[i] + 4);
  }
  $("replayStatus").textContent = `t = ${replay.t.toFixed(1)}s · ${replay.racers.length} cars (top 6 best laps)`;
}
function stopReplay() {
  if (!replay.on) return;
  replay.on = false;
  try { cancelAnimationFrame(replay.raf); } catch { /* ignore */ }
  const btn = document.getElementById("replayBtn");
  if (btn) btn.textContent = "▶ Replay best laps";
  const st = document.getElementById("replayStatus");
  if (st) st.textContent = "";
  redrawStaticMap();
}

document.addEventListener("DOMContentLoaded", init);
