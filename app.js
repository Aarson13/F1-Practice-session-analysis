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
const $$ = (sel) => document.querySelector(sel); // for CSS selectors (e.g. "#resultGrid p")
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

/* ---------------- Shoelace select helpers ---------------- */
function mkOption(value, text) {
  const o = document.createElement("sl-option");
  o.value = String(value);
  o.textContent = text;
  return o;
}
function selectValues(sel) {
  if (sel.querySelectorAll) return [...sel.querySelectorAll("sl-option")].map((o) => o.value);
  return [...(sel.options || [])].map((o) => o.value);
}
function setSelectOptions(sel, items, placeholder) {
  sel.innerHTML = "";
  if (placeholder) sel.appendChild(mkOption("", placeholder));
  for (const [value, text] of items) sel.appendChild(mkOption(value, text));
}
function selectOptionCount(sel) {
  return sel.querySelectorAll ? sel.querySelectorAll("sl-option").length : (sel.options || []).length;
}

/* =====================================================================
 * SELECTOR FLOW: year -> grand prix -> session (all session types)
 * ===================================================================== */
async function init() {
  const yearSel = $("yearSelect");
  const thisYear = new Date().getFullYear();
  yearSel.innerHTML = "";
  for (let y = thisYear; y >= 2023; y--) yearSel.appendChild(mkOption(y, String(y)));
  yearSel.value = String(thisYear);
  yearSel.addEventListener("sl-change", loadMeetings);
  $("gpSelect").addEventListener("sl-change", loadSessions);
  $("sessionSelect").addEventListener("sl-change", () => {
    const has = !!$("sessionSelect").value;
    $("analyzeBtn").disabled = !has;
    $("copyLinkBtn").disabled = !has;
  });
  $("analyzeBtn").addEventListener("click", runAnalysis);
  $("copyLinkBtn").addEventListener("click", copyShareLink);
  $("weekendBtn").addEventListener("click", runWeekend);
  $("replayBtn").addEventListener("click", toggleReplay);
  $("trackMap").addEventListener("click", onTrackClick);
  $("h2hA").addEventListener("sl-change", renderH2H);
  $("h2hB").addEventListener("sl-change", renderH2H);
  $("cornerCsvBtn").addEventListener("click", () => downloadGridCSV("corner", `corners_${sessionTag()}.csv`));
  $("driverCsvBtn").addEventListener("click", () => downloadGridCSV("driver", `drivers_${sessionTag()}.csv`));
  $("teamCsvBtn").addEventListener("click", () => downloadGridCSV("team", `teams_${sessionTag()}.csv`));
  $("sectorCsvBtn").addEventListener("click", () => downloadGridCSV("sector", `sectors_${sessionTag()}.csv`));
  $("paceCsvBtn").addEventListener("click", () => downloadGridCSV("pace", `pace_${sessionTag()}.csv`));
  window.addEventListener("resize", () => { try { if (speedChart) speedChart.resize(); } catch { /* ignore */ } });
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
  if (!selectValues($("yearSelect")).includes(p.y)) return false;
  $("yearSelect").value = p.y;
  await loadMeetings();
  if (!state.meetingByKey.has(String(p.m))) return false;
  $("gpSelect").value = String(p.m);
  await loadSessions();
  if (String(p.s) === "COMBINED") {
    if (!isGrandPrixMeeting(state.meetingByKey.get(String(p.m)))) return false;
    if (practiceSessions(state.sessions).length < 2) return false;
  } else if (!state.sessions.some((s) => String(s.session_key) === String(p.s))) {
    return false;
  }
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
      gpSel.innerHTML = `<sl-option value="">No Grands Prix found for ${esc(year)}</sl-option>`;
      showError(`The API returned no Grands Prix for ${year}. The season may not have started yet — try an earlier year.`);
      return;
    }
    meetings.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    state.meetings = meetings;
    state.meetingByKey = new Map(meetings.map((m) => [String(m.meeting_key), m]));
    gpSel.innerHTML = "";
    for (const m of meetings) {
      if (m.is_cancelled) continue; // nothing to analyze
      const d = new Date(m.date_start).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      gpSel.appendChild(mkOption(m.meeting_key, `${m.meeting_name} — ${m.location} (${d})`));
    }
    if (selectOptionCount(gpSel) === 0) {
      gpSel.innerHTML = `<sl-option value="">No (non-cancelled) Grands Prix for ${esc(year)}</sl-option>`;
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
  sesSel.disabled = true; sesSel.innerHTML = `<sl-option value="">Loading sessions…</sl-option>`;
  clearError();
  try {
    // ALL session types for this meeting: Practice, Qualifying, Sprint, Race…
    const sessions = await apiGet(`${OPENF1}/sessions?meeting_key=${encodeURIComponent(meetingKey)}`, "session list");
    if (!Array.isArray(sessions) || sessions.length === 0) {
      sesSel.innerHTML = `<sl-option value="">No sessions found for this event</sl-option>`;
      showError("The API returned no sessions for this Grand Prix. It may be too far in the future.");
      return;
    }
    sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    state.sessions = sessions.filter((s) => !s.is_cancelled);
    if (state.sessions.length === 0) {
      sesSel.innerHTML = `<sl-option value="">All sessions for this event were cancelled</sl-option>`;
      return;
    }
    sesSel.innerHTML = "";
    // Combined-practice mode: one entry pooling every available practice
    // session — championship (Grand Prix) weekends only.
    const meeting = state.meetingByKey.get(String(meetingKey));
    const practices = practiceSessions(state.sessions);
    if (practices.length >= 2 && isGrandPrixMeeting(meeting)) {
      sesSel.appendChild(mkOption("COMBINED",
        `All practice sessions combined (${practices.map(shortSessionName).join(" + ")})`));
    }
    for (const s of state.sessions) {
      const d = new Date(s.date_start).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      sesSel.appendChild(mkOption(s.session_key, `${s.session_name} (${s.session_type}) — ${d}`));
    }
    sesSel.disabled = false;
  } catch (e) { showError(e.message); }
}

function practiceSessions(sessions) {
  return (sessions || [])
    .filter((s) => !s.is_cancelled && (s.session_type === "Practice" || /^Practice/i.test(s.session_name || "")))
    .sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
}
// Combined practice is a championship-weekend feature: Grand Prix meetings
// only (no pre-season testing or other non-championship events).
function isGrandPrixMeeting(m) {
  return !!m && /grand prix/i.test(m.meeting_name || "");
}
function shortSessionName(s) {
  return String(s.session_name || "").replace(/^Practice\s*/i, "FP").replace(/\s+/g, " ");
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

async function fetchOverview(sessionKey) {
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
  const arr = (v) => (Array.isArray(v) ? v : []);
  return { drivers, laps, classification: arr(classification), stints: arr(stints), weather: arr(weather), raceControl: arr(raceControl) };
}
function buildDriverInfo(drivers) {
  const driverInfo = new Map();
  for (const d of drivers) {
    const cur = driverInfo.get(d.driver_number);
    const info = {
      number: d.driver_number,
      acronym: d.name_acronym || `#${d.driver_number}`,
      name: d.full_name || d.broadcast_name || `Driver ${d.driver_number}`,
      team: d.team_name || "Unknown",
      colour: teamColor(d.team_colour),
      img: d.headshot_url || "",
    };
    if (!cur) driverInfo.set(d.driver_number, info);
    else if (!cur.img && info.img) cur.img = info.img; // fill gaps across sessions
  }
  return driverInfo;
}
function buildStintsMap(stintsRows) {
  const m = new Map();
  for (const s of stintsRows) {
    if (s == null || s.driver_number == null) continue;
    if (!m.has(s.driver_number)) m.set(s.driver_number, []);
    m.get(s.driver_number).push({
      compound: s.compound || "Unknown",
      lap_start: s.lap_start ?? 0, lap_end: s.lap_end ?? 999,
      tyre_age_at_start: s.tyre_age_at_start,
    });
  }
  return m;
}
function pickBestLaps(laps, driverInfo) {
  const bestByDriver = new Map();
  for (const lap of laps) {
    if (lap.lap_duration == null || !(lap.lap_duration > 0)) continue;
    if (lap.is_pit_out_lap) continue;
    const cur = bestByDriver.get(lap.driver_number);
    if (!cur || lap.lap_duration < cur.lap_duration) bestByDriver.set(lap.driver_number, lap);
  }
  return [...bestByDriver.entries()]
    .filter(([num]) => driverInfo.has(num))
    .sort((a, b) => a[1].lap_duration - b[1].lap_duration);
}
async function fetchOneTrace(sessionKey, num, lap, driverInfo) {
  const acr = (driverInfo.get(num) || {}).acronym || `#${num}`;
  const start = new Date(lap.date_start);
  if (!Number.isFinite(start.getTime()) || !(lap.lap_duration > 0)) {
    console.warn(`Skipping ${acr}: bad lap window`);
    return null;
  }
  const from = new Date(start.getTime() - 2000).toISOString();
  const to = new Date(start.getTime() + lap.lap_duration * 1000 + 3000).toISOString();
  const url = `${OPENF1}/car_data?session_key=${sessionKey}&driver_number=${num}` +
    `&date>${encodeURIComponent(from)}&date<${encodeURIComponent(to)}`;
  let rows;
  try {
    rows = await apiGet(url, `telemetry for ${acr}`);
  } catch (e) {
    console.warn(`Skipping ${acr}: ${e.message}`);
    return null;
  }
  if (!Array.isArray(rows) || rows.length === 0) { console.warn(`Skipping ${acr}: empty telemetry response`); return null; }
  const pts = rows
    .filter((r) => r && Number.isFinite(r.speed) && Number.isFinite(Date.parse(r.date)))
    .map((r) => ({ t: Date.parse(r.date), speed: r.speed }));
  const trace = speedToProgressTrace(pts);
  if (!trace) { console.warn(`Skipping ${acr}: not enough telemetry points`); return null; }
  let top = 0, sum = 0;
  for (const v of trace) { top = Math.max(top, v); sum += v; }
  return { trace, topSpeed: top, avgSpeed: sum / trace.length, lap };
}
async function fetchBestTraces(sessionKey, ranked, driverInfo, progress) {
  const traces = new Map();
  let done = 0;
  for (const [num, lap] of ranked) {
    done++;
    const acr = (driverInfo.get(num) || {}).acronym || `#${num}`;
    progress(0.06 + 0.7 * (done / ranked.length), `Fetching best-lap telemetry for ${acr} (${done}/${ranked.length})…`);
    const tr = await fetchOneTrace(sessionKey, num, lap, driverInfo);
    if (tr) traces.set(num, tr);
  }
  return traces;
}
async function fetchCircuit(meeting, progress) {
  if (!meeting || !meeting.circuit_info_url) return null;
  progress(0.06, "Fetching official circuit corner data…");
  try {
    const r = await fetch(meeting.circuit_info_url);
    if (r.ok) return await r.json();
  } catch { /* ignore → auto-detect fallback */ }
  return null;
}
function rankCorners(traces, driverInfo, corners) {
  return corners.map((c) => {
    const perDriver = [...traces.entries()].map(([num, d]) => ({ num, ...windowStats(d.trace, c.bin) }));
    perDriver.sort((a, b) => b.avg - a.avg);
    const best = perDriver[0].avg;
    const withGap = perDriver.map((p) => ({ ...p, gap: best - p.avg }));
    // team aggregates
    const byTeam = new Map();
    for (const p of perDriver) {
      const info = driverInfo.get(p.num) || {};
      const t = info.team || "Unknown";
      if (!byTeam.has(t)) byTeam.set(t, { team: t, speeds: [], colour: info.colour || "#999" });
      byTeam.get(t).speeds.push(p.avg);
    }
    const teams = [...byTeam.values()].map((t) => ({
      ...t, avg: t.speeds.reduce((a, b) => a + b, 0) / t.speeds.length,
    })).sort((a, b) => b.avg - a.avg);
    return { ...c, ranking: withGap, bestTeam: teams[0], teams };
  });
}
function finishDriverStats(traces, driverInfo, cornerResults, compoundOf) {
  return [...traces.entries()].map(([num, d]) => {
    let won = 0, defSum = 0;
    cornerResults.forEach((c) => {
      const me = c.ranking.find((r) => r.num === num);
      if (c.ranking[0].num === num) won++;
      defSum += c.ranking[0].avg - me.avg;
    });
    return {
      num, info: driverInfo.get(num), lap: d.lap, topSpeed: d.topSpeed, avgSpeed: d.avgSpeed,
      won, deficit: defSum / cornerResults.length,
      compound: compoundOf(num, d.lap),
    };
  }).sort((a, b) => a.lap.lap_duration - b.lap.lap_duration);
}
function aggregateTeams(driverStats, cornerResults) {
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
  return [...teamMap.values()].map((t) => {
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
}
async function analyzeSessionData(sessionKey, session, meeting, driverLimit, progress) {
  progress(0.03, "Fetching session overview (drivers, laps, stints, classification)…");
  const ov = await fetchOverview(sessionKey);
  const { drivers, laps } = ov;

  // Official corner geometry — fetched live, never stored.
  const circuit = await fetchCircuit(meeting, progress);

  const driverInfo = buildDriverInfo(drivers);

  // stints lookup (tyre compound per lap + race-pace stints)
  const stintsByDriver = buildStintsMap(ov.stints);

  // best (non-pit-out) lap per driver
  let ranked = pickBestLaps(laps, driverInfo);
  if (ranked.length === 0) throw new Error("No timed laps found for this session yet. The session may not have started or data may still be publishing.");

  ranked = ranked.slice(0, Math.min(driverLimit, ranked.length));

  // per-driver telemetry for their best lap window
  const traces = await fetchBestTraces(sessionKey, ranked, driverInfo, progress);
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
  const cornerResults = rankCorners(traces, driverInfo, corners);

  // driver aggregates (+ tyre compound of the best lap)
  const driverStats = finishDriverStats(traces, driverInfo, cornerResults,
    (num, lap) => compoundFor(stintsByDriver, num, lap.lap_number));

  // team aggregates
  const teamStats = aggregateTeams(driverStats, cornerResults);

  // race pace (Race / Sprint only — needs full-lap stint data)
  const stype = session.session_type || "";
  const pace = (/race|sprint/i.test(stype) && !/qualif/i.test(stype)) ? computePace(laps, stintsByDriver) : [];

  return {
    session, meeting, driverStats, teamStats, cornerResults, traces, driverInfo,
    classification: ov.classification, cornerSource, circuit,
    weatherSum: summarizeWeather(ov.weather), flagEvents: summarizeFlags(ov.raceControl), pace,
  };
}

/* =====================================================================
 * COMBINED PRACTICE — pools every available practice session.
 * Each driver's overall-best practice lap (and its telemetry) is used,
 * so corners are ranked on the best each driver showed all weekend.
 * Telemetry is fetched only for those laps — one lap per driver total.
 * ===================================================================== */
async function analyzeCombinedPractice(practiceSessions, meeting, driverLimit, progress) {
  const sessions = practiceSessions.slice().sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
  if (sessions.length === 0) throw new Error("No practice sessions found for this event.");
  // 1. cheap overviews only (no telemetry yet)
  const per = [];
  let i = 0;
  for (const s of sessions) {
    i++;
    progress(0.02 + (0.1 * i) / sessions.length,
      `Combined practice ${i}/${sessions.length}: loading ${s.session_name} overview…`);
    const ov = await fetchOverview(s.session_key);
    per.push({ session: s, ov, info: buildDriverInfo(ov.drivers), sm: buildStintsMap(ov.stints) });
  }
  // 2. merge driver identities across sessions
  const driverInfo = new Map();
  for (const p of per) {
    for (const [num, inf] of p.info) {
      if (!driverInfo.has(num)) driverInfo.set(num, { ...inf });
      else if (!driverInfo.get(num).img && inf.img) driverInfo.get(num).img = inf.img;
    }
  }
  // 3. overall-best practice lap per driver (+ owning session)
  const best = new Map();
  per.forEach((p, idx) => {
    for (const [num, lap] of pickBestLaps(p.ov.laps, driverInfo)) {
      const cur = best.get(num);
      if (!cur || lap.lap_duration < cur.lap.lap_duration) best.set(num, { lap, sessionIdx: idx });
    }
  });
  let picks = [...best.entries()].sort((a, b) => a[1].lap.lap_duration - b[1].lap.lap_duration);
  if (picks.length === 0) throw new Error("No timed laps found in any practice session yet.");
  picks = picks.slice(0, Math.min(driverLimit, picks.length));
  // 4. telemetry for those laps only, from their own sessions
  const traces = new Map();
  let done = 0;
  for (const [num, { lap, sessionIdx }] of picks) {
    done++;
    const s = per[sessionIdx].session;
    const acr = (driverInfo.get(num) || {}).acronym || `#${num}`;
    progress(0.15 + (0.6 * done) / picks.length,
      `Combined practice: best-lap telemetry for ${acr} (${s.session_name}, ${done}/${picks.length})…`);
    const tr = await fetchOneTrace(s.session_key, num, lap, driverInfo);
    if (tr) traces.set(num, tr);
  }
  if (traces.size < 2) throw new Error("Not enough driver telemetry could be loaded (need at least 2 drivers). The API may be rate-limiting — wait a minute and retry, or analyze fewer drivers.");
  // 5. shared corners + rankings on the pooled best laps
  const circuit = await fetchCircuit(meeting, (f, t) => progress(0.78, t));
  const refNum = [...traces.entries()].sort((a, b) => a[1].lap.lap_duration - b[1].lap.lap_duration)[0][0];
  progress(0.82, "Detecting corners & ranking every turn…");
  await sleep(30);
  let corners = circuit ? mapOfficialCorners(circuit) : null;
  const cornerSource = corners ? "official" : "auto-detected";
  if (!corners) corners = detectCornersFromSpeed(traces.get(refNum).trace);
  if (corners.length === 0) throw new Error("Could not identify corners on this circuit from telemetry.");
  const cornerResults = rankCorners(traces, driverInfo, corners);
  const compoundOf = (num, lap) => {
    const own = best.get(num);
    return compoundFor(own ? per[own.sessionIdx].sm : new Map(), num, lap.lap_number);
  };
  const driverStats = finishDriverStats(traces, driverInfo, cornerResults, compoundOf);
  const teamStats = aggregateTeams(driverStats, cornerResults);
  // 6. context/classification from the final practice session
  const last = per[per.length - 1];
  const names = sessions.map(shortSessionName).join(" + ");
  const session = {
    session_key: "combined",
    session_name: `${names} (combined)`,
    session_type: "Practice",
    date_start: sessions[0].date_start,
    meeting_key: (meeting && meeting.meeting_key) || sessions[0].meeting_key,
  };
  return {
    session, meeting, driverStats, teamStats, cornerResults, traces, driverInfo,
    classification: last.ov.classification, cornerSource, circuit,
    weatherSum: summarizeWeather(last.ov.weather), flagEvents: summarizeFlags(last.ov.raceControl), pace: [],
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
  const combined = sessionKey === "COMBINED";
  const session = combined ? null : state.sessions.find((s) => String(s.session_key) === String(sessionKey));
  if (!combined && !session) { showError("Selected session is no longer available. Please re-select the Grand Prix and session."); return; }
  const meeting = state.meetingByKey.get(String($("gpSelect").value)) || null;
  const driverLimit = parseInt($("driverLimitSelect").value, 10) || 99;
  // lock the UI so a mid-run change can't mix two analyses
  const locked = ["yearSelect", "gpSelect", "sessionSelect", "driverLimitSelect", "analyzeBtn"];
  const wasEnabled = {};
  locked.forEach((id) => { wasEnabled[id] = !$(id).disabled; $(id).disabled = true; });

  try {
    const progress = (frac, text) => setStatus(text, frac);
    let a;
    if (combined) {
      if (!isGrandPrixMeeting(meeting)) throw new Error("Combined practice is only available for Grand Prix weekends.");
      const practices = practiceSessions(state.sessions);
      if (practices.length < 2) throw new Error("Fewer than 2 practice sessions are available for this event.");
      a = await analyzeCombinedPractice(practices, meeting, driverLimit, progress);
    } else {
      a = await analyzeSessionData(sessionKey, session, meeting, driverLimit, progress);
    }
    state.analysis = a;
    saveShareHash();

    setStatus("Rendering…", 0.95);
    await sleep(30);
    await renderAll();
    $("results").hidden = false;
    // ECharts measures its container at init (while hidden = 0px): resize now
    try { if (typeof speedChart !== "undefined" && speedChart) speedChart.resize(); } catch { /* ignore */ }
    setStatus(`Done — analyzed ${a.driverStats.length} drivers over ${a.cornerResults.length} corners (${a.cornerSource} apexes). ${combined ? "All practice sessions combined." : "Only the selected session was analyzed."}`, 1);
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

/* ---------------- Tabulator grids ---------------- */
const grids = {};
function sessionTag() {
  const a = state.analysis;
  if (!a) return "session";
  return `${String(a.session.session_name).replace(/[^\w]+/g, "")}_${a.session.session_key}`;
}
function makeGrid(name, data, columns, sortField, sortDir) {
  const elId = `${name}Grid`;
  if (grids[name]) { try { grids[name].destroy(); } catch { /* ignore */ } delete grids[name]; }
  if (typeof Tabulator === "undefined") return null;
  const t = new Tabulator(`#${elId}`, {
    data,
    columns,
    layout: "fitColumns",
    initialSort: sortField ? [{ column: sortField, dir: sortDir || "asc" }] : [],
  });
  grids[name] = t;
  // Tabulator's generated subtree needs three small ownership repairs to
  // satisfy axe aria-required-children/parent (verified live):
  //  1. header contents rowgroup -> row (so the header rowgroup owns a row),
  //  2. inner .tabulator-headers wrapper de-roled (transparent pass-through),
  //  3. tabindex removed from the scroll holder: our tables are auto-height
  //     (the page scrolls, nothing scrolls inside them), and a focusable
  //     roleless div is not an allowed child of the grid.
  // Nothing else is touched, so native grid/row/cell semantics,
  // aria-sort arrows and keyboard interaction stay intact.
  const fixTableA11y = () => {
    try {
      const root = document.getElementById(elId);
      if (!root) return;
      root.querySelectorAll('.tabulator-header-contents[role="rowgroup"]')
        .forEach((n) => n.setAttribute("role", "row"));
      root.querySelectorAll(".tabulator-headers[role]")
        .forEach((n) => n.removeAttribute("role"));
      root.querySelectorAll(".tabulator-tableholder[tabindex]")
        .forEach((n) => n.removeAttribute("tabindex"));
    } catch { /* headless test stubs: no live DOM */ }
  };
  fixTableA11y();
  try {
    t.on("tableBuilt", fixTableA11y);
    t.on("renderComplete", fixTableA11y);
  } catch { /* ignore */ }
  return t;
}
function downloadGridCSV(name, filename) {
  const g = grids[name];
  if (!g) { showError("Run an analysis first — there is nothing to download yet."); return; }
  try { g.download("csv", filename); }
  catch (e) { showError(`CSV download failed: ${(e && e.message) || e}`); }
}
const driverCellHtml = (info) =>
  `${portraitFor(info)}<span class="swatch" style="background:${info.colour}"></span><span class="best-cell">${esc(info.acronym)}</span>`;
const teamCellHtml = (name, colour) =>
  `<span class="swatch" style="background:${colour}"></span><span class="best-cell">${esc(name)}</span>`;

function renderCornerTable(a) {
  const data = a.cornerResults.map((c, idx) => {
    const best = c.ranking[0];
    const bd = a.driverInfo.get(best.num);
    return {
      id: idx,
      turn: `T${c.number}${c.official ? "" : "*"}`,
      apexPct: (100 * c.bin) / (N_BINS - 1),
      bestDriver: bd.acronym,
      bestDriverHtml: `${portraitFor(bd)}${teamCellHtml(bd.acronym, bd.colour)}`,
      bestAvg: best.avg,
      bestAvgHtml: `${best.avg.toFixed(1)} km/h <span style="color:var(--muted)">(min ${best.min.toFixed(0)})</span>`,
      bestTeam: c.bestTeam.team,
      bestTeamHtml: teamCellHtml(c.bestTeam.team, c.bestTeam.colour),
      top3: c.ranking.slice(0, 3)
        .map((r) => `${a.driverInfo.get(r.num).acronym}${r.gap > 0.0005 ? ` (+${r.gap.toFixed(1)})` : ""}`)
        .join(", "),
    };
  });
  const g = makeGrid("corner", data, [
    { title: "Turn", field: "turn", sorter: "string", formatter: (cell) => `<span class="best-cell">${esc(cell.getValue())}</span>` },
    { title: "Apex %", field: "apexPct", sorter: "number", hozAlign: "right", formatter: (cell) => `${cell.getValue().toFixed(1)}%` },
    { title: "Best driver", field: "bestDriver", sorter: "string", formatter: (cell) => cell.getRow().getData().bestDriverHtml },
    { title: "Avg speed", field: "bestAvg", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().bestAvgHtml },
    { title: "Best team", field: "bestTeam", sorter: "string", formatter: (cell) => cell.getRow().getData().bestTeamHtml },
    { title: "Top 3 (gap)", field: "top3", sorter: "string", headerSort: false },
  ], "apexPct", "asc");
  if (g) {
    g.on("rowMouseEnter", (e, row) => {
      try {
        const c = a.cornerResults[row.getData().id];
        if (c) { state.highlightBin = c.bin; redrawStaticMap(); }
      } catch { /* ignore */ }
    });
    g.on("rowMouseLeave", () => { state.highlightBin = null; redrawStaticMap(); });
  }
}

function renderDriverTable(a) {
  const data = a.driverStats.map((d) => ({
    id: d.num,
    driver: d.info.acronym,
    driverHtml: `${driverCellHtml(d.info)} <span style="color:var(--muted)">${esc(d.info.name)}</span>`,
    team: d.info.team,
    teamHtml: teamCellHtml(d.info.team, d.info.colour),
    bestLapS: d.lap.lap_duration,
    bestLapHtml: fmtLap(d.lap.lap_duration),
    compound: d.compound,
    compoundHtml: pillFor(d.compound),
    topS: d.topSpeed,
    topHtml: `${d.topSpeed.toFixed(0)} km/h`,
    avgS: d.avgSpeed,
    avgHtml: `${d.avgSpeed.toFixed(1)} km/h`,
    won: d.won,
    wonHtml: `${d.won}${d.won > 0 ? `<span class="tag">BEST</span>` : ""}`,
    deficit: d.deficit,
    deficitHtml: `+${d.deficit.toFixed(2)} km/h`,
  }));
  makeGrid("driver", data, [
    { title: "Driver", field: "driver", sorter: "string", formatter: (cell) => cell.getRow().getData().driverHtml },
    { title: "Team", field: "team", sorter: "string", formatter: (cell) => cell.getRow().getData().teamHtml },
    { title: "Best lap", field: "bestLapS", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().bestLapHtml },
    { title: "Tyre", field: "compound", sorter: "string", formatter: (cell) => cell.getRow().getData().compoundHtml },
    { title: "Top speed", field: "topS", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().topHtml },
    { title: "Avg speed", field: "avgS", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().avgHtml },
    { title: "Corners won", field: "won", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().wonHtml },
    { title: "Avg deficit", field: "deficit", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().deficitHtml },
  ], "bestLapS", "asc");
}

function renderTeamTable(a) {
  const data = a.teamStats.map((t) => ({
    team: t.team,
    teamHtml: teamCellHtml(t.team, t.colour),
    drivers: t.drivers.map((d) => d.info.acronym).join(", "),
    avgLapS: t.avgLap,
    avgLapHtml: fmtLap(t.avgLap),
    won: t.won,
    avgCorner: t.avgCorner,
    avgCornerHtml: `${t.avgCorner.toFixed(1)} km/h`,
    strongest: t.strongest == null ? "—" : `T${t.strongest}`,
  }));
  makeGrid("team", data, [
    { title: "Team", field: "team", sorter: "string", formatter: (cell) => cell.getRow().getData().teamHtml },
    { title: "Drivers", field: "drivers", sorter: "string", headerSort: false },
    { title: "Avg best lap", field: "avgLapS", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().avgLapHtml },
    { title: "Corners won", field: "won", sorter: "number", hozAlign: "right" },
    { title: "Avg corner speed", field: "avgCorner", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().avgCornerHtml },
    { title: "Strongest turn", field: "strongest", sorter: "string", hozAlign: "right" },
  ], "won", "desc");
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
  let rowEl = null;
  if (grids.corner) {
    try { const r = grids.corner.getRow(best.idx); if (r) rowEl = r.getElement(); } catch { /* ignore */ }
  }
  if (!rowEl) return;
  rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const cells = rowEl.querySelectorAll ? [...rowEl.querySelectorAll(".tabulator-cell")] : [];
  cells.forEach((c) => c.classList.remove("flash"));
  void rowEl.offsetWidth; // restart the CSS animation
  cells.forEach((c) => c.classList.add("flash"));
  setTimeout(() => cells.forEach((c) => c.classList.remove("flash")), 2100);
}

function renderClassification(a) {
  const rows = [...(a.classification || [])].sort((x, y) => (x.position ?? 999) - (y.position ?? 999));
  const data = rows.map((r) => {
    const info = a.driverInfo.get(r.driver_number) || { acronym: `#${r.driver_number}`, name: "", team: "", colour: "#999", img: "" };
    const dur = Array.isArray(r.duration) ? r.duration.filter(Boolean).join(" / ") : r.duration;
    return {
      pos: r.position ?? 999,
      posHtml: `${r.position ?? "—"}`,
      driver: info.acronym,
      driverHtml: `${portraitFor(info)}<span class="swatch" style="background:${info.colour}"></span>${esc(info.acronym)} <span style="color:var(--muted)">${esc(info.name)}</span>`,
      team: info.team,
      durHtml: `${dur != null && dur !== "" ? (typeof dur === "number" ? fmtLap(dur) : esc(dur)) : "—"}`,
      laps: r.number_of_laps ?? "—",
    };
  });
  if (!data.length) {
    const el = document.getElementById("resultGrid");
    if (el) el.innerHTML = `<p class="hint" style="padding:12px">Official classification not published for this session.</p>`;
    return;
  }
  makeGrid("result", data, [
    { title: "Pos", field: "pos", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().posHtml },
    { title: "Driver", field: "driver", sorter: "string", formatter: (cell) => cell.getRow().getData().driverHtml },
    { title: "Team", field: "team", sorter: "string" },
    { title: "Best / total", field: "durHtml", sorter: "string", hozAlign: "right", headerSort: false },
    { title: "Laps", field: "laps", sorter: "number", hozAlign: "right" },
  ], "pos", "asc");
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
  const s = (v) => (v == null || !isFinite(v) ? null : v);
  const data = a.driverStats.map((d) => {
    const L = d.lap;
    return {
      driver: d.info.acronym,
      driverHtml: `${portraitFor(d.info)}<span class="best-cell">${esc(d.info.acronym)}</span>`,
      s1: s(L.duration_sector_1), s2: s(L.duration_sector_2), s3: s(L.duration_sector_3),
      bestLapS: L.lap_duration,
      bestLapHtml: fmtLap(L.lap_duration),
      i1: s(L.i1_speed), i2: s(L.i2_speed), st: s(L.st_speed),
      compound: d.compound,
      compoundHtml: pillFor(d.compound),
    };
  });
  const sec = (t, f) => ({
    title: t, field: f, sorter: "number", hozAlign: "right",
    formatter: (cell) => { const v = cell.getValue(); return v == null ? "—" : v.toFixed(3); },
  });
  const trap = (t, f) => ({
    title: t, field: f, sorter: "number", hozAlign: "right",
    formatter: (cell) => { const v = cell.getValue(); return v == null ? "—" : `${v} km/h`; },
  });
  makeGrid("sector", data, [
    { title: "Driver", field: "driver", sorter: "string", formatter: (cell) => cell.getRow().getData().driverHtml },
    sec("S1", "s1"), sec("S2", "s2"), sec("S3", "s3"),
    { title: "Best lap", field: "bestLapS", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().bestLapHtml },
    trap("I1 trap", "i1"), trap("I2 trap", "i2"), trap("ST trap", "st"),
    { title: "Tyre", field: "compound", sorter: "string", formatter: (cell) => cell.getRow().getData().compoundHtml },
  ], "bestLapS", "asc");
}

/* ---------------- race pace & degradation ---------------- */
function renderPace(a) {
  const card = $("racePaceCard");
  if (!a.pace || a.pace.length === 0) { card.hidden = true; return; }
  card.hidden = false;
  const data = a.pace.map((p) => {
    const info = a.driverInfo.get(p.num) || { acronym: `#${p.num}`, colour: "#999", img: "" };
    return {
      driver: info.acronym,
      driverHtml: `${portraitFor(info)}<span class="swatch" style="background:${info.colour}"></span><span class="best-cell">${esc(info.acronym)}</span>`,
      stint: p.stint,
      compound: p.compound,
      compoundHtml: `${pillFor(p.compound)} <span style="color:var(--muted)">age ${esc(p.age)}</span>`,
      n: p.n,
      avgS: p.avg,
      avgHtml: fmtLap(p.avg),
      slope: p.slope,
      slopeHtml: `${p.slope >= 0 ? "+" : ""}${p.slope.toFixed(3)}`,
    };
  });
  makeGrid("pace", data, [
    { title: "Driver", field: "driver", sorter: "string", formatter: (cell) => cell.getRow().getData().driverHtml },
    { title: "Stint", field: "stint", sorter: "number", hozAlign: "right" },
    { title: "Compound", field: "compound", sorter: "string", formatter: (cell) => cell.getRow().getData().compoundHtml },
    { title: "Laps", field: "n", sorter: "number", hozAlign: "right" },
    { title: "Avg pace", field: "avgS", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().avgHtml },
    { title: "Deg (s/lap)", field: "slope", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().slopeHtml },
  ], "avgS", "asc");
}

/* ---------------- head-to-head ---------------- */
function populateH2H(a) {
  for (const id of ["h2hA", "h2hB"]) {
    const sel = $(id);
    sel.innerHTML = "";
    for (const d of a.driverStats) {
      sel.appendChild(mkOption(d.num, `${d.info.acronym} — ${d.info.team} (${fmtLap(d.lap.lap_duration)})`));
    }
  }
  if (a.driverStats.length >= 2) {
    $("h2hA").value = String(a.driverStats[0].num);
    $("h2hB").value = String(a.driverStats[1].num);
  }
}
function ensureGridHost(afterId, gridId) {
  let host = document.getElementById(gridId);
  if (!host) {
    host = document.createElement("div");
    host.id = gridId;
    host.className = "grid";
    host.style.marginTop = "12px";
    const anchor = document.getElementById(afterId);
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor.nextSibling);
  }
  return host;
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
  const data = a.cornerResults.map((c) => {
    const ra = c.ranking.find((r) => r.num === na), rb = c.ranking.find((r) => r.num === nb);
    const delta = ra.avg - rb.avg; // + means A faster
    if (delta >= 0) wa++; else wb++;
    const win = delta >= 0 ? A : B;
    return {
      turn: `T${c.number}`,
      aAvg: ra.avg, bAvg: rb.avg, delta,
      deltaHtml: `<span style="color:${delta >= 0 ? "var(--good)" : "var(--accent-2)"};font-weight:800">${delta >= 0 ? "+" : ""}${delta.toFixed(2)}</span>`,
      winner: win.info.acronym,
      winnerHtml: `<span class="swatch" style="background:${win.info.colour}"></span><span class="best-cell">${esc(win.info.acronym)}</span>`,
    };
  });
  const lapDelta = A.lap.lap_duration - B.lap.lap_duration;
  box.innerHTML =
    `<div class="chips" style="margin-bottom:10px">` +
    `<span class="chip">${portraitFor(A.info)}<b>${esc(A.info.acronym)}</b> ${wa} corners ${pillFor(A.compound)}</span>` +
    `<span class="chip">${portraitFor(B.info)}<b>${esc(B.info.acronym)}</b> ${wb} corners ${pillFor(B.compound)}</span>` +
    `<span class="chip">⏱️ <b>Lap delta</b> ${lapDelta === 0 ? "dead heat" : `${esc((lapDelta > 0 ? B : A).info.acronym)} by ${Math.abs(lapDelta).toFixed(3)}s`}</span>` +
    `</div>`;
  ensureGridHost("h2hResult", "h2hGrid");
  makeGrid("h2h", data, [
    { title: "Turn", field: "turn", sorter: "string", formatter: (cell) => `<span class="best-cell">${esc(cell.getValue())}</span>` },
    { title: `${A.info.acronym} km/h`, field: "aAvg", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getValue().toFixed(1) },
    { title: `${B.info.acronym} km/h`, field: "bAvg", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getValue().toFixed(1) },
    { title: "Δ (A−B)", field: "delta", sorter: "number", hozAlign: "right", formatter: (cell) => cell.getRow().getData().deltaHtml },
    { title: "Winner", field: "winner", sorter: "string", formatter: (cell) => cell.getRow().getData().winnerHtml },
  ], "delta", "desc");
  drawH2HMap(a, A, B);
  // sync the main speed chart to just these two
  renderSpeedChart(a, [na, nb]);
}

/* ---------------- weekend view ---------------- */
async function runWeekend() {
  const a0 = state.analysis;
  if (!a0) return;
  const sessions = state.sessions.filter((s) => !s.is_cancelled);
  if (sessions.length < 2) { showError("This event has fewer than 2 sessions — nothing to compare."); return; }
  // lock the main controls so a mid-run change can't mix two analyses
  const locked = ["yearSelect", "gpSelect", "sessionSelect", "driverLimitSelect", "analyzeBtn", "weekendBtn"];
  const wasEnabled = {};
  locked.forEach((id) => { wasEnabled[id] = !$(id).disabled; $(id).disabled = true; });
  clearError();
  try {
    const perSession = [];
    let si = 0;
    for (const s of sessions) {
      si++;
      try {
        const r = await analyzeSessionData(s.session_key, s, a0.meeting, 5,
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
    locked.forEach((id) => { $(id).disabled = !wasEnabled[id]; });
    if ($("sessionSelect").disabled) $("analyzeBtn").disabled = true;
  }
}
function cornerKey(c, idx) { return c.official ? `T${c.number}` : `#${idx}`; }
function renderWeekend(perSession) {
  const box = $("weekendResult");
  const ok = perSession.filter((p) => p.data);
  if (!ok.length) { box.innerHTML = `<p class="hint">No session could be analyzed for this weekend.</p>`; return; }
  const lines = ok.map((p) => {
    const f = p.data.driverStats[0];
    return `<span class="chip"><b>${esc(p.session.session_name)}</b> ${esc(f.info.acronym)} ${fmtLap(f.lap.lap_duration)} ${pillFor(f.compound)}</span>`;
  }).join("");
  // rows = union of corner keys in weekend order
  const order = [];
  for (const p of ok) {
    p.data.cornerResults.forEach((c, idx) => {
      const k = cornerKey(c, idx);
      if (!order.includes(k)) order.push(k);
    });
  }
  const cols = [{ title: "Turn", field: "turn", sorter: "string",
    formatter: (cell) => `<span class="best-cell">${esc(cell.getValue())}</span>` }];
  ok.forEach((p, i) => {
    cols.push({ title: p.session.session_name, field: `s${i}`, sorter: "string",
      formatter: (cell) => cell.getRow().getData()[`s${i}Html`] || `<span style="color:var(--muted)">—</span>` });
  });
  const data = order.map((k) => {
    const row = { turn: k };
    ok.forEach((p, i) => {
      const idx = p.data.cornerResults.findIndex((c, j) => cornerKey(c, j) === k);
      if (idx < 0) { row[`s${i}`] = ""; row[`s${i}Html`] = ""; return; }
      const t = p.data.cornerResults[idx].bestTeam;
      row[`s${i}`] = t.team;
      row[`s${i}Html`] = `<span class="swatch" style="background:${t.colour}"></span>${esc(t.team)}`;
    });
    return row;
  });
  const failed = perSession.filter((p) => !p.data)
    .map((p) => `<span class="chip">⚠️ ${esc(p.session.session_name)}: ${esc((p.error || "failed").slice(0, 80))}</span>`).join("");
  box.innerHTML = `<div class="chips" style="margin-bottom:10px">${lines}${failed}</div>`;
  ensureGridHost("weekendResult", "weekendGrid");
  makeGrid("weekend", data, cols, "turn", "asc");
}

/* ---------------- head-to-head duel map ----------------
 * The signature moment: the same lap outline, every segment colored by
 * whichever of the two drivers is faster there. Quiet everywhere else. */
function drawH2HMap(a, A, B) {
  const canvas = $("h2hMap");
  const legend = $("h2hLegend");
  const tA = a.traces.get(A.num), tB = a.traces.get(B.num);
  const shape = state.mapShape;
  const fit = fitCanvas(canvas, 420 / 900);
  const ctx = fit.ctx;
  ctx.clearRect(0, 0, fit.W, fit.H);
  if (!tA || !tB || !shape || !shape.x) {
    ctx.fillStyle = "#9aa4bd"; ctx.font = "15px sans-serif";
    ctx.fillText("Duel map needs the track outline — it was unavailable for this session.", 24, 60);
    if (legend) legend.textContent = "";
    return;
  }
  const pix = shapePixels(shape, fit.W, fit.H);
  const { PX, PY, n } = pix;
  const SEGS = 220;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  for (let sgm = 0; sgm < SEGS; sgm++) {
    const b0 = Math.floor((sgm / SEGS) * (N_BINS - 1));
    const b1 = Math.floor(((sgm + 1) / SEGS) * (N_BINS - 1));
    const mid = Math.floor((b0 + b1) / 2);
    const colour = tA.trace[mid] >= tB.trace[mid] ? A.info.colour : B.info.colour;
    const i0 = Math.floor((sgm / SEGS) * (n - 1));
    const i1 = Math.floor(((sgm + 1) / SEGS) * (n - 1));
    ctx.strokeStyle = colour; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(PX[i0], PY[i0]); ctx.lineTo(PX[i1], PY[i1]); ctx.stroke();
  }
  // apex markers (small, quiet — the duel is the color)
  ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const c of a.cornerResults) {
    const i = Math.max(0, Math.min(n - 1, Math.round((c.bin / (N_BINS - 1)) * (n - 1))));
    ctx.fillStyle = "#0b0e14";
    ctx.beginPath(); ctx.arc(PX[i], PY[i], 10, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(PX[i], PY[i], 10, 0, 7); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(String(c.number), PX[i], PY[i]);
  }
  if (legend) {
    legend.innerHTML =
      `<span><span class="swatch" style="background:${A.info.colour}"></span>${esc(A.info.acronym)} faster</span>` +
      `<span><span class="swatch" style="background:${B.info.colour}"></span>${esc(B.info.acronym)} faster</span>`;
  }
}

/* ---------------- ECharts speed traces ---------------- */
let speedChart = null;
function renderSpeedChart(a, preset) {
  const el = document.getElementById("speedChart");
  if (!el || typeof echarts === "undefined") return;
  if (speedChart) { try { speedChart.dispose(); } catch { /* ignore */ } speedChart = null; }
  const sorted = [...a.driverStats].sort((x, y) => x.lap.lap_duration - y.lap.lap_duration);
  const nums = sorted.map((d) => d.num);
  const show = Array.isArray(preset) && preset.length
    ? preset.filter((n) => nums.includes(n))
    : sorted.slice(0, 6).map((d) => d.num);
  const visible = new Set(show.length ? show : nums.slice(0, 1));
  const STEP = 4; // resample stride: 250 points per lap is plenty on screen
  const selected = {};
  const series = sorted.map((d) => {
    const tr = a.traces.get(d.num).trace;
    const data = [];
    for (let b = 0; b < N_BINS; b += STEP) {
      data.push([+((100 * b) / (N_BINS - 1)).toFixed(1), +tr[b].toFixed(1)]);
    }
    selected[d.info.acronym] = visible.has(d.num);
    return {
      name: d.info.acronym, type: "line", showSymbol: false, data,
      lineStyle: { color: d.info.colour, width: visible.has(d.num) ? 2.4 : 1.2 },
      emphasis: { focus: "series" },
    };
  });
  // corner apex guides: exact positions need a value x-axis (category axes
  // only match whole categories, which silently drops most guides)
  const guide = {
    name: "turns", type: "line", showSymbol: false, data: [],
    markLine: {
      silent: true, symbol: "none",
      lineStyle: { color: "rgba(255,255,255,0.28)", type: "dashed", width: 1 },
      label: { color: "rgba(255,255,255,0.6)", fontSize: 10, position: "start" },
      data: a.cornerResults.map((c) => ({ xAxis: +((100 * c.bin) / (N_BINS - 1)).toFixed(1), name: `T${c.number}` })),
    },
  };
  speedChart = echarts.init(el);
  speedChart.setOption({
    backgroundColor: "transparent",
    animationDuration: 500,
    grid: { left: 52, right: 18, top: 30, bottom: 64 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#0d1322", borderColor: "#242e48", textStyle: { color: "#f2f4f9", fontSize: 12 },
      formatter: (params) => {
        if (!params || !params.length) return "";
        const x = Array.isArray(params[0].value) ? params[0].value[0] : params[0].axisValue;
        let h = `<b>${x}% of lap</b>`;
        params.filter((p) => p.seriesName !== "turns").slice(0, 12).forEach((p) => {
          const y = Array.isArray(p.value) ? p.value[1] : p.value;
          h += `<br/>${p.marker} ${esc(p.seriesName)}: ${y} km/h`;
        });
        return h;
      },
    },
    legend: {
      type: "scroll", bottom: 34, textStyle: { color: "#9aa5bc", fontSize: 11 },
      selected, inactiveColor: "#4a5570",
    },
    dataZoom: [
      { type: "slider", bottom: 0, height: 22, borderColor: "#242e48", backgroundColor: "#0a0e18",
        fillerColor: "rgba(225,6,0,0.18)", handleStyle: { color: "#e10600" }, textStyle: { color: "#6b7590" } },
      { type: "inside" },
    ],
    xAxis: {
      type: "value", min: 0, max: 100, name: "lap %",
      nameLocation: "middle", nameGap: 26, nameTextStyle: { color: "#6b7590", fontSize: 11 },
      axisLine: { lineStyle: { color: "#242e48" } },
      axisLabel: { color: "#6b7590", fontSize: 10, formatter: (v) => `${v}%` },
    },
    yAxis: {
      type: "value", scale: true, name: "km/h", nameTextStyle: { color: "#6b7590", fontSize: 11 },
      splitLine: { lineStyle: { color: "#1a2236" } },
      axisLabel: { color: "#6b7590", fontSize: 10 },
    },
    series: [...series, guide],
  });
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
