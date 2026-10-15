#!/usr/bin/env python3
"""Procedural night-race background loop for the F1 Session Analyzer site.

Renders a seamless 10-second loop (240 frames @ 24fps) of a GENERIC
modern open-wheel race car (no real team livery, no logos, no branding)
in dark red / black speeding down a night track, seen from
behind-three-quarter. Frames go to a temp dir, then ffmpeg encodes
assets/bg.mp4 + assets/bg.webm and grabs assets/bg-poster.jpg.

Loop safety: every moving element is a periodic function of t = f/N with
an integer number of cycles per loop, so frame N continues frame 0 exactly.

Tweakables are the UPPER-CASE constants below (speed, colours, duration).
Requires: numpy, Pillow, ffmpeg on PATH.
"""
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw

# ----------------------------- tweakables -----------------------------
DURATION = 10.0          # seconds per seamless loop
FPS = 24                 # frames per second
SPEED = 3.0              # road-dash scroll cycles per loop (integer!)
ACCENT_COLOR = (220, 0, 0)     # Ferrari-style red accents / glow
CAR_COLOR = (148, 16, 16)      # generic dark-red bodywork (no real livery)
# ----------------------------------------------------------------------

N_FRAMES = int(DURATION * FPS)          # 240
RW, RH = 1280, 720                     # render size (ffmpeg scales to 854x480)
VP = (RW / 2.0, RH * 0.415)            # vanishing point
HORIZON = VP[1]
ROAD_BOTTOM_HALF = 472                 # road half-width at the bottom edge
ROAD_VP_HALF = 26                      # road half-width at the vanishing point

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(REPO_ROOT, "public", "assets")

rng = random.Random(7)


def persp(s):
    """Road parameter s in [0,1) -> (y, half_width). Accelerating, like perspective."""
    e = s ** 2.4
    y = HORIZON + (RH + 40 - HORIZON) * e
    hw = ROAD_VP_HALF + (ROAD_BOTTOM_HALF - ROAD_VP_HALF) * (s ** 1.6)
    return y, hw


# Soft radial glow sprite, precomputed once (no per-frame blur filters).
def make_glow_sprite(size=192):
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    r = np.sqrt((xx - size / 2) ** 2 + (yy - size / 2) ** 2) / (size / 2)
    g = np.clip(1.0 - r, 0.0, 1.0) ** 2.2
    return (g * 255.0).astype(np.float32)


GLOW = make_glow_sprite()


def add_glow(frame, x, y, size, color, strength):
    """Additive glow stamp. frame is float32 HxWx3."""
    s = int(size)
    if s <= 0:
        return
    sprite = GLOW
    if sprite.shape[0] != s:
        sprite = np.asarray(
            Image.fromarray(GLOW).resize((s, s), Image.BILINEAR)).astype(np.float32) / 255.0 * 255.0
        sprite = np.clip(sprite, 0, 255)
    else:
        sprite = GLOW
    h, w = frame.shape[:2]
    x0, y0 = int(x - s / 2), int(y - s / 2)
    x1, y1 = x0 + s, y0 + s
    fx0, fy0 = max(0, x0), max(0, y0)
    fx1, fy1 = min(w, x1), min(h, y1)
    if fx1 <= fx0 or fy1 <= fy0:
        return
    sx0, sy0 = fx0 - x0, fy0 - y0
    patch = (sprite[sy0:sy0 + (fy1 - fy0), sx0:sx0 + (fx1 - fx0)] / 255.0) * strength
    for c in range(3):
        frame[fy0:fy1, fx0:fx1, c] += patch * color[c]
    # caller clips


def build_static_base():
    """Sky, horizon glow, ground, road slab, centre sheen, distant lights."""
    yy, xx = np.mgrid[0:RH, 0:RW].astype(np.float32)
    top = np.array([7, 7, 10], np.float32)
    hor = np.array([20, 8, 10], np.float32)
    bot = np.array([6, 6, 7], np.float32)
    t = np.clip(yy / HORIZON, 0, 1)[..., None]
    sky = top[None, None, :] * (1 - t) + hor[None, None, :] * t
    g = np.clip(yy - HORIZON, 0, None)
    ground = bot[None, None, :] + np.zeros_like(sky)
    base = np.where((yy >= HORIZON)[..., None], ground, sky)

    # red horizon glow: horizontal band, gaussian falloff both axes
    band = np.exp(-((yy - (HORIZON - 26)) ** 2) / (2 * 62.0 ** 2))
    lateral = np.exp(-((xx - VP[0]) ** 2) / (2 * 430.0 ** 2))
    glow = (band * lateral)[..., None] * np.array([150, 14, 16], np.float32)
    base = base + glow * 0.55

    # road trapezoid slab
    road = Image.new("L", (RW, RH), 0)
    d = ImageDraw.Draw(road)
    d.polygon([(VP[0] - ROAD_VP_HALF, HORIZON), (VP[0] + ROAD_VP_HALF, HORIZON),
               (VP[0] + ROAD_BOTTOM_HALF, RH), (VP[0] - ROAD_BOTTOM_HALF, RH)], fill=255)
    m = (np.asarray(road).astype(np.float32) / 255.0)[..., None]
    asphalt = np.array([23, 23, 27], np.float32)
    base = base * (1 - m) + asphalt * m

    # faint red centre sheen reflected down the road (static)
    sheen_x = np.exp(-((xx - VP[0]) ** 2) / (2 * (60 + 1.1 * np.clip(yy - HORIZON, 0, None)) ** 2))
    sheen = (sheen_x * np.clip((yy - HORIZON) / RH, 0, 1) ** 1.5)[..., None]
    base = base + sheen * m * np.array([70, 8, 10], np.float32)

    # distant track lights: tiny static dots with small glows near horizon
    for _ in range(16):
        lx = VP[0] + rng.uniform(-560, 560)
        ly = HORIZON - rng.uniform(2, 60)
        col = rng.choice([(255, 200, 120), (255, 90, 70), (220, 225, 235)])
        add_glow(base, lx, ly, rng.uniform(26, 60), col, rng.uniform(0.25, 0.6))
    return np.clip(base, 0, 255)


def edge_curve_points(side, n=220):
    """Dense samples along a road edge for dash placement. side: -1 left, +1 right."""
    pts = []
    for i in range(n + 1):
        s = i / n
        y, hw = persp(s)
        pts.append((VP[0] + side * hw, y, s))
    return pts


def draw_dashes(draw, pts, offset, dash_count, dash_len, width_fn, colors, alpha_fn):
    """Loop-safe dashes along a sampled curve. offset in cycles (float)."""
    n = len(pts) - 1
    for i in range(dash_count):
        s0 = (i / dash_count + offset) % 1.0
        s1 = s0 + dash_len
        # collect wrapped segment
        seg = []
        m = 14
        for k in range(m + 1):
            s = (s0 + dash_len * k / m) % 1.0
            idx = int(s * n) % n
            x, y, ss = pts[idx]
            seg.append((x, y))
            w = width_fn(ss)
        col = colors[i % len(colors)]
        a = alpha_fn((s0 + dash_len / 2) % 1.0)
        if a <= 0:
            continue
        draw.line(seg, fill=col + (int(a),), width=max(2, int(w)), joint="curve")


def build_car_layer(cx, gy, frame_i):
    """Rear-three-quarter generic open-wheel silhouette on a transparent layer."""
    layer = Image.new("RGBA", (RW, RH), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    R = ACCENT_COLOR
    B = CAR_COLOR
    dark = (12, 12, 15, 255)
    tyre = (10, 10, 12, 255)

    # rear tyres
    for sx in (-1, 1):
        x = cx + sx * 108
        d.ellipse([x - 38, gy - 96, x + 38, gy - 4], fill=tyre)
        d.ellipse([x - 38, gy - 96, x + 38, gy - 4], outline=(38, 38, 44, 255), width=3)
        d.rectangle([x - 10, gy - 70, x + 10, gy - 30], fill=(24, 24, 28, 255))

    # floor + diffuser
    d.polygon([(cx - 150, gy), (cx + 150, gy), (cx + 118, gy - 30), (cx - 118, gy - 30)], fill=(14, 14, 18, 255))
    for k in range(-2, 3):
        d.line([(cx + k * 34, gy - 2), (cx + k * 30, gy - 28)], fill=(30, 30, 36, 255), width=4)

    # engine cover / bodywork
    d.polygon([(cx - 84, gy - 30), (cx + 84, gy - 30), (cx + 56, gy - 108), (cx - 56, gy - 108)], fill=B + (255,))
    d.polygon([(cx - 22, gy - 30), (cx + 22, gy - 30), (cx + 14, gy - 108), (cx - 14, gy - 108)], fill=(20, 8, 8, 255))
    d.line([(cx - 80, gy - 34), (cx - 54, gy - 104)], fill=R + (255,), width=5)
    d.line([(cx + 80, gy - 34), (cx + 54, gy - 104)], fill=R + (255,), width=5)

    # halo + cockpit
    d.polygon([(cx - 40, gy - 108), (cx + 40, gy - 108), (cx + 30, gy - 148), (cx - 30, gy - 148)], fill=(8, 8, 10, 255))
    d.line([(cx - 40, gy - 108), (cx - 30, gy - 148)], fill=(52, 52, 58, 255), width=7)
    d.line([(cx + 40, gy - 108), (cx + 30, gy - 148)], fill=(52, 52, 58, 255), width=7)
    d.line([(cx - 30, gy - 148), (cx + 30, gy - 148)], fill=(52, 52, 58, 255), width=7)

    # rear wing: main plane + flap + endplates
    d.rectangle([cx - 152, gy - 208, cx + 152, gy - 178], fill=dark)
    d.rectangle([cx - 152, gy - 208, cx + 152, gy - 200], fill=(26, 26, 32, 255))
    d.line([(cx - 152, gy - 193), (cx + 152, gy - 193)], fill=R + (255,), width=3)
    for sx in (-1, 1):
        d.rectangle([cx + sx * 152 - (8 if sx > 0 else 0) + (-8 if sx < 0 else 0),
                     gy - 224, cx + sx * 152 + (8 if sx > 0 else 0) + (8 if sx < 0 else -0),
                     gy - 150], fill=(110, 10, 10, 255))
    # beam wing hint
    d.rectangle([cx - 70, gy - 150, cx + 70, gy - 138], fill=(16, 16, 20, 255))

    # glowing red rain light
    d.rounded_rectangle([cx - 7, gy - 96, cx + 7, gy - 66], radius=6, fill=(255, 34, 34, 255))

    # underglow
    glow_layer = Image.new("RGBA", (RW, RH), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow_layer)
    gd.ellipse([cx - 150, gy - 14, cx + 150, gy + 26], fill=R + (52,))
    layer = Image.alpha_composite(layer, glow_layer)
    return layer


def main():
    n = N_FRAMES
    print(f"rendering {n} frames at {RW}x{RH} ...", flush=True)
    base = build_static_base()
    left_pts = edge_curve_points(-1)
    right_pts = edge_curve_points(1)

    # light-streak field: (angle_deg, phase, cycles, length, width, color, alpha)
    streaks = []
    palette = [(255, 42, 42, 120), (232, 232, 240, 100), (255, 170, 60, 110), (255, 42, 42, 80)]
    for k in range(18):
        ang = rng.uniform(-72, 72)  # degrees from "up", radiating from VP
        streaks.append((ang, rng.random(), rng.choice([1, 2]),
                        rng.uniform(120, 300), rng.uniform(2, 4),
                        palette[k % len(palette)]))

    # edge speed lines: (x, y0, cycles_down_per_loop, length, alpha)
    edges = []
    for k in range(6):
        side = -1 if k % 2 == 0 else 1
        edges.append((VP[0] + side * rng.uniform(430, 600), rng.uniform(0, RH),
                      rng.choice([1, 2]), rng.uniform(60, 140), rng.uniform(24, 46)))

    # vignette mask, precomputed once
    yy, xx = np.mgrid[0:RH, 0:RW].astype(np.float32)
    rr = np.sqrt(((xx - RW / 2) / (RW / 2)) ** 2 + ((yy - RH / 2) / (RH / 2)) ** 2) / np.sqrt(2)
    vig = (1.0 - 0.48 * np.clip(rr, 0, 1) ** 1.8)[..., None].astype(np.float32)

    tmp = tempfile.mkdtemp(prefix="bgframes_")
    try:
        for f in range(n):
            t = f / n
            frame = base.copy()

            # --- scrolling dashes (loop-safe: integer cycles mod 1) ---
            dyn = Image.new("RGBA", (RW, RH), (0, 0, 0, 0))
            dd = ImageDraw.Draw(dyn)
            off = (t * SPEED) % 1.0
            kerb = [(200, 20, 20), (205, 208, 214)]
            draw_dashes(dd, left_pts, off, 14, 0.030,
                        lambda s: 6 + 12 * s, kerb, lambda s: 60 + 150 * s)
            draw_dashes(dd, right_pts, off, 14, 0.030,
                        lambda s: 6 + 12 * s, kerb, lambda s: 60 + 150 * s)
            # centre dashes
            for i in range(10):
                s0 = (i / 10 + off) % 1.0
                y0, _ = persp(s0)
                y1, _ = persp((s0 + 0.022) % 1.0)
                if y1 < y0:  # wrapped segment: draw to bottom edge only
                    y1 = RH + 20
                a = int(30 + 90 * s0)
                w = max(2, int(2 + 5 * s0))
                dd.line([(VP[0], y0), (VP[0], y1)], fill=(210, 212, 218, a), width=w)

            # --- light streaks radiating from the vanishing point ---
            for (ang, ph, cyc, length, width, (r, g, b, a0)) in streaks:
                rpos = (t * cyc + ph) % 1.0
                rad = math.radians(ang)
                dx, dy = math.sin(rad), -math.cos(rad)
                reach = 120 + 560 * rpos
                x1, y1 = VP[0] + dx * reach, VP[1] + dy * reach
                x0, y0 = VP[0] + dx * max(0, reach - length * (0.4 + rpos)), VP[1] + dy * max(0, reach - length * (0.4 + rpos))
                a = int(a0 * (1 - rpos) * (0.35 + 0.65 * rpos) + 8)
                dd.line([(x0, y0), (x1, y1)], fill=(r, g, b, max(0, min(255, a))), width=max(1, int(width)))

            # --- edge speed lines drifting down (integer cycles => seamless) ---
            for (x, y0, cyc, ln, a0) in edges:
                y = (y0 + t * cyc * (RH + 200)) % (RH + 200) - 100
                dd.line([(x - ln / 2, y), (x + ln / 2, y)], fill=(225, 228, 235, int(a0)), width=2)

            frame_pil = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8)).convert("RGBA")
            frame_pil = Image.alpha_composite(frame_pil, dyn)
            frame = np.asarray(frame_pil.convert("RGB")).astype(np.float32)

            # --- car (behind-three-quarter, gentle periodic bob + sway) ---
            bob = 4.0 * math.sin(2 * math.pi * t + 1.3)
            sway = 9.0 * math.sin(2 * math.pi * t)
            cx, gy = VP[0] + sway, 566 + bob
            car = build_car_layer(cx, gy, f)
            frame_pil = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8)).convert("RGBA")
            frame_pil = Image.alpha_composite(frame_pil, car)
            frame = np.asarray(frame_pil.convert("RGB")).astype(np.float32)

            # --- blooms: rain light + underglow core ---
            add_glow(frame, cx, gy - 81, 90, (255, 40, 40), 0.85)
            add_glow(frame, cx, gy + 6, 300, (200, 12, 12), 0.30)

            # --- vignette (precomputed, single multiply) ---
            frame *= vig
            Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8)) \
                .save(os.path.join(tmp, f"{f:04d}.png"))
            if (f + 1) % 60 == 0:
                print(f"  frame {f + 1}/{n}", flush=True)

        # --- encode (exact spec commands, frames path substituted) ---
        mp4 = os.path.join(ASSETS, "bg.mp4")
        webm = os.path.join(ASSETS, "bg.webm")
        crf_mp4, crf_webm = 30, 40
        for attempt in range(3):
            subprocess.run(["ffmpeg", "-y", "-framerate", str(FPS),
                            "-i", os.path.join(tmp, "%04d.png"),
                            "-an", "-vf", "scale=854:480,format=yuv420p",
                            "-c:v", "libx264", "-profile:v", "main",
                            "-crf", str(crf_mp4), "-preset", "slow",
                            "-movflags", "+faststart", mp4], check=True)
            subprocess.run(["ffmpeg", "-y", "-framerate", str(FPS),
                            "-i", os.path.join(tmp, "%04d.png"),
                            "-an", "-vf", "scale=854:480",
                            "-c:v", "libvpx-vp9", "-crf", str(crf_webm),
                            "-b:v", "0", webm], check=True)
            s_mp4, s_webm = os.path.getsize(mp4), os.path.getsize(webm)
            print(f"pass {attempt + 1}: bg.mp4={s_mp4} bg.webm={s_webm} "
                  f"(crf {crf_mp4}/{crf_webm})", flush=True)
            if s_mp4 <= 3 * 1024 * 1024 and s_webm <= 3 * 1024 * 1024:
                break
            crf_mp4 = min(crf_mp4 + 2, 34)
            crf_webm = min(crf_webm + 2, 45)
        else:
            print("WARNING: over 3 MB after CRF bumps", flush=True)

        subprocess.run(["ffmpeg", "-y", "-i", mp4, "-frames:v", "1",
                        os.path.join(ASSETS, "bg-poster.jpg")], check=True)
        print("FINAL SIZES:",
              f"bg.mp4={os.path.getsize(mp4)}",
              f"bg.webm={os.path.getsize(webm)}",
              f"bg-poster.jpg={os.path.getsize(os.path.join(ASSETS, 'bg-poster.jpg'))}",
              flush=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        print("temp frames deleted", flush=True)


if __name__ == "__main__":
    sys.exit(main())
