"""F1 turn-by-turn corner analyzer powered by FastF1 (deep-analysis engine).

Same analysis contract as the website (index.html), but with richer data:
higher-rate telemetry (speed, throttle, brake, gear) and official corner
positions mapped to exact track distances — plus seasons back to 2018.

ZERO-STORAGE RULE: FastF1 caches to disk by default (and even creates its
requests-cache sqlite file when caching is "disabled"). This script points
the cache at a temp directory that is closed and deleted on exit, so every
run fetches live data and keeps nothing. Nothing persists on disk
unless you explicitly pass --save-plots.

Supports every session identifier FastF1 offers — FP1, FP2, FP3, Q, SQ, S,
R — but analyzes ONLY the single session you select.

Usage:
    pip install -r requirements.txt
    python corner_analysis.py --year 2024 --gp Singapore --session FP1
    python corner_analysis.py --year 2024 --gp Singapore --session Q --top 10 --plots
"""

import argparse
import atexit
import gc
import shutil
import tempfile
import time

import fastf1

# -- honor the zero-storage rule BEFORE any other FastF1 call ---------------
# FastF1 always creates its requests-cache sqlite file on first use, even
# with set_disabled(). So instead: point the cache at a temp directory that
# is closed + deleted when the script exits. Data is therefore fetched live
# on every run and nothing remains on disk afterwards.
_TMP_CACHE_DIR = tempfile.mkdtemp(prefix="fastf1_nostore_")
fastf1.Cache.enable_cache(_TMP_CACHE_DIR)


def _cleanup_cache_dir():
    """Release FastF1's sqlite file lock, then remove the temp cache dir."""
    try:
        sess = getattr(fastf1.Cache, "_requests_session_cached", None)
        backend = getattr(sess, "cache", None)
        for obj in (backend, sess):
            if obj is not None and hasattr(obj, "close"):
                try:
                    obj.close()
                except Exception:
                    pass
    except Exception:
        pass
    gc.collect()
    for _ in range(20):
        try:
            shutil.rmtree(_TMP_CACHE_DIR)
            return
        except OSError:
            time.sleep(0.5)
    shutil.rmtree(_TMP_CACHE_DIR, ignore_errors=True)


atexit.register(_cleanup_cache_dir)

import numpy as np
import pandas as pd

N_BINS = 1000          # resampled points per lap (matches website)
CORNER_HALF_WIDTH_M = 50.0  # corner window: apex +/- 50 m


def parse_args():
    p = argparse.ArgumentParser(description="Turn-by-turn F1 driver/team corner analysis (FastF1 engine).")
    p.add_argument("--year", type=int, required=True, help="Season, e.g. 2024 (2018+)")
    p.add_argument("--gp", required=True, help='Grand Prix name or round, e.g. "Singapore" or 18')
    p.add_argument("--session", required=True,
                   help="Session identifier: FP1, FP2, FP3, Q, SQ, S or R (only this session is analyzed)")
    p.add_argument("--top", type=int, default=0,
                   help="Analyze only the N fastest laps (0 = all drivers). Fewer drivers = faster.")
    p.add_argument("--plots", action="store_true", help="Show interactive track map + speed-trace plots.")
    p.add_argument("--save-plots", default=None, metavar="DIR",
                   help="Optional: save plots into DIR (default is zero-storage: show/print only).")
    return p.parse_args()


def fmt_lap(seconds):
    if seconds is None or not np.isfinite(seconds):
        return "--"
    m = int(seconds // 60)
    return f"{m}:{seconds - m * 60:06.3f}"


def team_color(team, fallback="#9aa4bd"):
    try:
        from fastf1 import plotting
        return plotting.get_team_color(team)
    except Exception:
        return fallback


def main():
    args = parse_args()
    gp = int(args.gp) if str(args.gp).isdigit() else args.gp

    print(f"Loading {args.year} {args.gp} {args.session} live (cache disabled, nothing stored)...")
    ses = fastf1.get_session(args.year, gp, args.session)
    ses.load(telemetry=True, weather=False)  # ONLY the selected session
    print(f"Analyzing: {ses.event['EventName']} - {ses.name} ({ses.event.year})")

    laps = ses.laps.copy()
    laps = laps[pd.notna(laps["LapTime"]) & pd.isna(laps["PitOutTime"])].copy()
    if laps.empty:
        raise SystemExit("No timed non-pit-out laps found for this session (data may still be publishing).")

    # fastest lap per driver
    laps["LapTimeS"] = laps["LapTime"].dt.total_seconds()
    best_idx = laps.groupby("Driver")["LapTimeS"].idxmin()
    best = laps.loc[best_idx].sort_values("LapTimeS").reset_index(drop=True)
    if args.top and args.top > 0:
        best = best.head(args.top)
    print(f"Best laps found for {len(best)} drivers; loading telemetry...")

    # telemetry -> uniform distance grid (reference = overall fastest lap)
    ref_tel = None
    traces = {}
    for _, row in best.iterrows():
        drv = row["Driver"]
        try:
            lap = ses.laps.pick_drivers([drv]).pick_fastest()
            tel = lap.get_telemetry()[["Distance", "Speed", "Throttle", "Brake"]].dropna()
            if len(tel) < 100:
                print(f"  ! {drv}: too few telemetry points, skipped")
                continue
            traces[drv] = {"tel": tel, "row": row}
            if ref_tel is None and drv == best.iloc[0]["Driver"]:
                ref_tel = tel
        except Exception as e:
            print(f"  ! {drv}: telemetry failed ({e}), skipped")
    if len(traces) < 2:
        raise SystemExit("Need at least 2 drivers with telemetry; try again later (API rate limits).")
    if ref_tel is None:
        ref_tel = next(iter(traces.values()))["tel"]

    lap_length = float(ref_tel["Distance"].max())
    grid = np.linspace(0, lap_length, N_BINS)
    for drv, d in traces.items():
        tel = d["tel"].sort_values("Distance")
        d["speed"] = np.interp(grid, tel["Distance"].to_numpy(), tel["Speed"].to_numpy())
        d["throttle"] = np.interp(grid, tel["Distance"].to_numpy(), tel["Throttle"].to_numpy())
        d["top"] = float(np.max(d["speed"]))
        d["avg"] = float(np.mean(d["speed"]))

    # official corners (Distance available because telemetry is loaded)
    corners = ses.get_circuit_info().corners
    if corners is None or corners.empty or "Distance" not in corners or corners["Distance"].isna().all():
        raise SystemExit("Official corner distances unavailable for this circuit.")
    corners = corners.dropna(subset=["Distance"]).sort_values("Distance").reset_index(drop=True)

    # per-corner rankings by mean speed in window
    corner_results = []
    for _, c in corners.iterrows():
        label = f"{int(c['Number'])}{c['Letter']}" if str(c.get("Letter", "")).strip() else str(int(c["Number"]))
        apex = float(c["Distance"])
        lo, hi = apex - CORNER_HALF_WIDTH_M, apex + CORNER_HALF_WIDTH_M
        m = (grid >= lo) & (grid <= hi)
        ranking = sorted(
            ((drv, float(np.mean(d["speed"][m])), float(np.min(d["speed"][m]))) for drv, d in traces.items()),
            key=lambda r: -r[1],
        )
        best_avg = ranking[0][1]
        teams = {}
        for drv, avg, _ in ranking:
            t = traces[drv]["row"]["Team"]
            teams.setdefault(t, []).append(avg)
        team_rank = sorted(((t, sum(v) / len(v)) for t, v in teams.items()), key=lambda r: -r[1])
        corner_results.append({"turn": label, "apex_m": apex, "ranking": ranking,
                               "best_avg": best_avg, "best_team": team_rank[0]})

    # ---- turn-by-turn report ----
    print("\n=== TURN-BY-TURN: best driver & best team per corner (avg speed in +/-50 m window) ===")
    rows = []
    for cr in corner_results:
        (d0, a0, _), *rest = cr["ranking"]
        top3 = ", ".join([d0] + [f"{d} (+{cr['best_avg'] - a:.1f})" for d, a, _ in rest[:2]])
        rows.append({"Turn": cr["turn"], "Apex_m": round(cr["apex_m"]),
                     "Best driver": d0, "Avg km/h": round(a0, 1),
                     "Best team": cr["best_team"][0], "Top 3": top3})
    print(pd.DataFrame(rows).to_string(index=False))

    # ---- driver report ----
    print("\n=== DRIVER ANALYSIS (best lap of the selected session) ===")
    drows = []
    for drv, d in sorted(traces.items(), key=lambda kv: kv[1]["row"]["LapTimeS"]):
        won = sum(1 for cr in corner_results if cr["ranking"][0][0] == drv)
        deficit = np.mean([cr["best_avg"] - next(a for dd, a, _ in cr["ranking"] if dd == drv)
                           for cr in corner_results])
        drows.append({"Driver": drv, "Team": d["row"]["Team"], "Best lap": fmt_lap(d["row"]["LapTimeS"]),
                      "Top km/h": round(d["top"]), "Avg km/h": round(d["avg"], 1),
                      "Corners won": won, "Avg deficit km/h": round(float(deficit), 2)})
    print(pd.DataFrame(drows).to_string(index=False))

    # ---- team report ----
    print("\n=== TEAM ANALYSIS ===")
    trows = []
    for team in sorted({d["row"]["Team"] for d in traces.values()}):
        members = [(drv, d) for drv, d in traces.items() if d["row"]["Team"] == team]
        won = sum(1 for cr in corner_results if cr["best_team"][0] == team)
        cavg = np.mean([a for cr in corner_results for drv, a, _ in cr["ranking"]
                        if traces[drv]["row"]["Team"] == team])
        gaps = []
        for cr in corner_results:
            mine = np.mean([a for drv, a, _ in cr["ranking"] if traces[drv]["row"]["Team"] == team])
            gaps.append((cr["best_team"][1] - mine, cr["turn"]))
        strong = min(gaps)[1]
        trows.append({"Team": team, "Drivers": ", ".join(d for d, _ in members),
                      "Avg best lap": fmt_lap(np.mean([d["row"]["LapTimeS"] for _, d in members])),
                      "Corners won": won, "Avg corner km/h": round(float(cavg), 1),
                      "Strongest turn": strong})
    trows.sort(key=lambda r: (-r["Corners won"], -r["Avg corner km/h"]))
    print(pd.DataFrame(trows).to_string(index=False))

    if args.plots or args.save_plots:
        make_plots(ses, grid, traces, corners, corner_results, args.save_plots)
    print("\nDone. Only the selected session was analyzed; nothing was stored (temp cache auto-deleted).")


def make_plots(ses, grid, traces, corners, corner_results, save_dir):
    import matplotlib.pyplot as plt

    # track map coloured by fastest team per segment
    fig, ax = plt.subplots(figsize=(10, 7))
    ref_drv = min(traces, key=lambda d: traces[d]["row"]["LapTimeS"])
    ref_xy = ses.laps.pick_drivers([ref_drv]).pick_fastest().get_telemetry()[["X", "Y", "Distance"]]
    segs = 240
    for s in range(segs):
        m = (grid >= grid[int(s / segs * (N_BINS - 1))]) & (grid <= grid[int((s + 1) / segs * (N_BINS - 1))])
        if not m.any():
            continue
        mid_speed = {t: np.mean([traces[d]["speed"][m].mean()
                                 for d in traces if traces[d]["row"]["Team"] == t])
                     for t in {traces[d]["row"]["Team"] for d in traces}}
        best_team = max(mid_speed, key=mid_speed.get)
        pts = ref_xy[(ref_xy["Distance"] >= grid[m][0]) & (ref_xy["Distance"] <= grid[m][-1])]
        if len(pts) > 1:
            ax.plot(pts["X"], pts["Y"], color=team_color(best_team), linewidth=4)
    for _, c in corners.iterrows():
        ax.text(c["X"], c["Y"], str(int(c["Number"])), fontsize=8, ha="center", va="center",
                bbox=dict(boxstyle="circle,pad=0.4", fc="black", ec="white"), color="white")
    ax.set_title(f"{ses.event['EventName']} {ses.event.year} - {ses.name}: fastest team per segment")
    ax.axis("equal")
    ax.axis("off")

    # speed traces
    fig2, ax2 = plt.subplots(figsize=(10, 4))
    for drv, d in sorted(traces.items(), key=lambda kv: kv[1]["row"]["LapTimeS"])[:8]:
        ax2.plot(grid, d["speed"], label=drv, color=team_color(d["row"]["Team"]), linewidth=1.5)
    for _, c in corners.iterrows():
        ax2.axvline(float(c["Distance"]), color="gray", linestyle="--", alpha=0.4)
    ax2.set_xlabel("Track distance (m)")
    ax2.set_ylabel("Speed (km/h)")
    ax2.set_title("Best-lap speed traces (top 8)")
    ax2.legend(ncol=4, fontsize=8)

    if save_dir:
        import os
        os.makedirs(save_dir, exist_ok=True)
        fig.savefig(os.path.join(save_dir, "track_map.png"), dpi=120, bbox_inches="tight")
        fig2.savefig(os.path.join(save_dir, "speed_traces.png"), dpi=120, bbox_inches="tight")
        print(f"Plots saved to {save_dir}")
    else:
        plt.show()


if __name__ == "__main__":
    main()
