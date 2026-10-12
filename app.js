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
  $("sessionSelect").addEventListener("change", () => { $("analyzeBtn").disabled = !$("sessionSelect").value; });
  $("analyzeBtn").addEventListener("click", runAnalysis);
  $("resetBtn").addEventListener("click", () => {
    $("results").hidden = true; clearError();
    $("statusBox").hidden = true; $("progressBar").style.width = "0%";
  });
  await loadMeetings();
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
    setStatus("Fetching session overview (drivers, laps, classification)…", 0.03);
    const [drivers, laps, classification] = await Promise.all([
      apiGet(`${OPENF1}/drivers?session_key=${sessionKey}`, "drivers"),
      apiGet(`${OPENF1}/laps?session_key=${sessionKey}`, "laps"),
      apiGet(`${OPENF1}/session_result?session_key=${sessionKey}`, "session classification").catch(() => []),
    ]);
    if (!Array.isArray(drivers) || !Array.isArray(laps)) {
      throw new Error("The API returned an unexpected response for drivers/laps. Please retry in a minute.");
    }

    // Official corner geometry — fetched live, never stored.
    let circuit = null;
    if (meeting && meeting.circuit_info_url) {
      setStatus("Fetching official circuit corner data…", 0.06);
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
        });
      }
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
      setStatus(`Fetching best-lap telemetry for ${acr} (${done}/${ranked.length})…`, 0.06 + 0.7 * (done / ranked.length));
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

    setStatus("Detecting corners & ranking every turn…", 0.8);
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

    // driver aggregates
    const driverStats = [...traces.entries()].map(([num, d]) => {
      let won = 0, defSum = 0;
      cornerResults.forEach((c) => {
        const me = c.ranking.find((r) => r.num === num);
        if (c.ranking[0].num === num) won++;
        defSum += c.ranking[0].avg - me.avg;
      });
      return { num, info: driverInfo.get(num), lap: d.lap, topSpeed: d.topSpeed, avgSpeed: d.avgSpeed, won, deficit: defSum / cornerResults.length };
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

    state.analysis = { session, meeting, driverStats, teamStats, cornerResults, traces, driverInfo, classification, cornerSource, circuit };

    setStatus("Rendering…", 0.95);
    await sleep(30);
    await renderAll();
    $("results").hidden = false;
    setStatus(`Done — analyzed ${traces.size} drivers over ${cornerResults.length} corners (${cornerSource} apexes). Only the selected session was analyzed.`, 1);
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
  renderCornerTable(a);
  renderDriverTable(a);
  renderTeamTable(a);
  await renderTrackMap(a);
  renderSpeedChart(a);
  renderClassification(a);
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
  for (const c of a.cornerResults) {
    const best = c.ranking[0];
    const bd = a.driverInfo.get(best.num);
    const top3 = c.ranking.slice(0, 3)
      .map((r) => `${esc(a.driverInfo.get(r.num).acronym)}${r.gap > 0.0005 ? ` (+${r.gap.toFixed(1)})` : ""}`)
      .join(", ");
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="best-cell">T${c.number}${c.official ? "" : "*"}</td>` +
      `<td class="num">${(100 * c.bin / (N_BINS - 1)).toFixed(1)}%</td>` +
      `<td><span class="swatch" style="background:${bd.colour}"></span><span class="best-cell">${esc(bd.acronym)}</span></td>` +
      `<td class="num">${best.avg.toFixed(1)} km/h <span style="color:var(--muted)">(min ${best.min.toFixed(0)})</span></td>` +
      `<td><span class="swatch" style="background:${c.bestTeam.colour}"></span>${esc(c.bestTeam.team)}</td>` +
      `<td>${top3}</td>`;
    tb.appendChild(tr);
  }
}

function renderDriverTable(a) {
  const tb = $$("#driverTable tbody");
  tb.innerHTML = "";
  for (const d of a.driverStats) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><span class="swatch" style="background:${d.info.colour}"></span><span class="best-cell">${esc(d.info.acronym)}</span> <span style="color:var(--muted)">${esc(d.info.name)}</span></td>` +
      `<td>${esc(d.info.team)}</td>` +
      `<td class="num">${fmtLap(d.lap.lap_duration)}</td>` +
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

async function renderTrackMap(a) {
  const canvas = $("trackMap");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setStatus("Drawing track map…", 0.97);
  let shape = null;
  try { shape = await getTrackShape(a); } catch (e) { console.warn("track shape failed", e); }
  if (!shape) {
    ctx.fillStyle = "#9aa4bd"; ctx.font = "16px sans-serif";
    ctx.fillText("Track outline unavailable (location data missing for this session).", 30, 60);
    $("mapLegend").textContent = "";
    return;
  }
  const { x, y } = shape;
  const n = x.length;
  // fit to canvas (loop-based min/max: safe for large arrays)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
    if (y[i] < minY) minY = y[i];
    if (y[i] > maxY) maxY = y[i];
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite) || maxX === minX || maxY === minY) {
    ctx.fillStyle = "#9aa4bd"; ctx.font = "16px sans-serif";
    ctx.fillText("Track outline data was invalid for this session.", 30, 60);
    $("mapLegend").textContent = "";
    return;
  }
  const pad = 60, W = canvas.width, H = canvas.height;
  const sc = Math.min((W - 2 * pad) / Math.max(1e-9, maxX - minX), (H - 2 * pad) / Math.max(1e-9, maxY - minY));
  const px = (i) => pad + (x[i] - minX) * sc + ((W - 2 * pad) - (maxX - minX) * sc) / 2;
  const py = (i) => pad + (maxY - y[i]) * sc + ((H - 2 * pad) - (maxY - minY) * sc) / 2;

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
    ctx.beginPath(); ctx.moveTo(px(i0), py(i0)); ctx.lineTo(px(i1), py(i1)); ctx.stroke();
  }
  // corner apex markers
  ctx.font = "bold 13px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const c of a.cornerResults) {
    const i = Math.round((c.bin / (N_BINS - 1)) * (n - 1));
    ctx.fillStyle = "#0b0e14";
    ctx.beginPath(); ctx.arc(px(i), py(i), 13, 0, 7); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px(i), py(i), 13, 0, 7); ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.fillText(String(c.number), px(i), py(i));
  }
  $("mapLegend").innerHTML = [...new Map(a.teamStats.map((t) => [t.team, t.colour])).entries()]
    .map(([t, col]) => `<span><span class="swatch" style="background:${col}"></span>${esc(t)}</span>`).join("");
}

/* ---- speed traces ---- */
function renderSpeedChart(a) {
  const box = $("traceToggles");
  box.innerHTML = "";
  const sorted = [...a.driverStats].sort((x, y) => x.lap.lap_duration - y.lap.lap_duration);
  const visible = new Set(sorted.slice(0, 6).map((d) => d.num));
  for (const d of sorted) {
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" ${visible.has(d.num) ? "checked" : ""} />` +
      `<span class="swatch" style="background:${d.info.colour}"></span>${esc(d.info.acronym)}`;
    lab.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? visible.add(d.num) : visible.delete(d.num);
      drawSpeedChart(a, visible);
    });
    box.appendChild(lab);
  }
  drawSpeedChart(a, visible);
}

function drawSpeedChart(a, visible) {
  const canvas = $("speedChart");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
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
    const info = a.driverInfo.get(r.driver_number) || { acronym: `#${r.driver_number}`, name: "", team: "", colour: "#999" };
    const dur = Array.isArray(r.duration) ? r.duration.filter(Boolean).join(" / ") : r.duration;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="num">${r.position ?? "—"}</td>` +
      `<td><span class="swatch" style="background:${info.colour}"></span>${esc(info.acronym)} <span style="color:var(--muted)">${esc(info.name)}</span></td>` +
      `<td>${esc(info.team)}</td>` +
      `<td class="num">${dur != null && dur !== "" ? (typeof dur === "number" ? fmtLap(dur) : esc(dur)) : "—"}</td>` +
      `<td class="num">${r.number_of_laps ?? "—"}</td>`;
    tb.appendChild(tr);
  }
}

document.addEventListener("DOMContentLoaded", init);
