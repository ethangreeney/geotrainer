#!/usr/bin/env python3
"""Rectilinear (photograph-geometry) views from a round's equirectangular pano.

    python3 render.py views <round-dir>
        view_front/right/back/left.jpg — four 100-degree views, the round as the
        player saw it. Skips views that already exist.

    python3 render.py look <round-dir> <yaw> <pitch> <fov> <out.jpg> [x0 y0 cols rows gcols grows]
        One aimed view. With the optional sector args, samples from zoom-5 tiles
        cached in <round-dir>/z5/ (a cols x rows crop whose top-left tile is
        (x0,y0) of a gcols x grows grid) instead of pano_full.jpg.

Convention: the equirect centre is the way the camera car faced = yaw 0,
yaw grows clockwise (east of heading), pitch up is positive.
"""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 512
VIEW_W, VIEW_H = 1344, 1008
FILL = 24  # dark grey where the source has no pixels to give


def _lerp(a, b, t):
    """a + (b - a) * t, in float32 and in place — these arrays are tens of MB."""
    a = a.astype(np.float32, copy=False)
    out = b.astype(np.float32)
    out -= a
    out *= t
    out += a
    return out


def _bilinear(eq, ur, vr, wrap):
    """Sample eq at float coords. wrap: the source closes the 360, so the
    column after the last one is column zero — otherwise the seam shows."""
    hc, wc = eq.shape[:2]
    fu = (ur % 1.0)[..., None]
    fv = (vr % 1.0)[..., None]
    x0 = np.floor(ur).astype(np.int32)
    y0 = np.floor(vr).astype(np.int32)
    x1, y1 = x0 + 1, y0 + 1
    if wrap:
        x0 %= wc
        x1 %= wc
    else:
        np.clip(x0, 0, wc - 1, out=x0)
        np.clip(x1, 0, wc - 1, out=x1)
    np.clip(y0, 0, hc - 1, out=y0)
    np.clip(y1, 0, hc - 1, out=y1)
    top = _lerp(eq[y0, x0], eq[y0, x1], fu)
    bot = _lerp(eq[y1, x0], eq[y1, x1], fu)
    return _lerp(top, bot, fv)


def render(eq, w_full, h_full, u0, v0, yaw_deg, pitch_deg, fov_deg, w=VIEW_W, h=VIEW_H):
    """Sample a w x h rectilinear view from an equirect (or a crop of one).

    eq is the pixel array actually in memory; (u0, v0) is where its top-left
    corner sits on the full w_full x h_full equirect. For a whole pano u0=v0=0.
    """
    fov_deg = min(max(float(fov_deg), 1.0), 170.0)  # f blows up as fov nears 180
    pitch_deg = min(max(float(pitch_deg), -90.0), 90.0)
    # A 100-degree view off an 8192-wide pano drops ~1.7 source pixels per output
    # pixel; point-sampling that crawls all over the lane markings and guardrails
    # this tool exists to read. Oversample and let LANCZOS do the averaging.
    ss = 2 if w_full / 360 > 1.3 * w / fov_deg else 1
    sw, sh = w * ss, h * ss

    # Ray through each output pixel: (x, -y, f) in camera space, pitched about
    # the x axis. Kept as a row and a column vector so numpy broadcasts rather
    # than materialising a 2D copy per term.
    yaw, pitch, fov = (math.radians(a) for a in (yaw_deg, pitch_deg, fov_deg))
    f = (sw / 2) / math.tan(fov / 2)
    cp, sp = math.cos(pitch), math.sin(pitch)
    xs = (np.arange(sw, dtype=np.float32) - sw / 2 + 0.5)[None, :]
    ys = (np.arange(sh, dtype=np.float32) - sh / 2 + 0.5)[:, None]
    dy = -ys * cp + f * sp
    dz = ys * sp + f * cp
    lon = np.arctan2(xs, dz) + yaw
    lat = np.arcsin(np.clip(dy / np.sqrt(xs * xs + ys * ys + f * f), -1, 1))
    u = ((lon / (2 * np.pi) + 0.5) % 1.0) * w_full
    v = (0.5 - lat / np.pi) * h_full
    ur = (u - u0) % w_full  # relative to the crop, wrap-safe
    vr = v - v0
    hc, wc = eq.shape[:2]
    whole = wc >= w_full - 1  # the source closes the 360
    out = _bilinear(eq, ur, vr, whole)
    # Outside a sector cache there is nothing to show, and stretching its edge
    # pixels across the frame would look like real imagery. Say so instead.
    gap = np.zeros(out.shape[:2], bool)
    if not whole:
        gap |= ur > wc - 1
    if hc < h_full - 1:
        gap |= (vr < 0) | (vr > hc - 1)
    out[gap] = FILL
    img = Image.fromarray((out + 0.5).astype(np.uint8))
    return img.resize((w, h), Image.LANCZOS) if ss > 1 else img


def load_pano(rdir):
    """The round's stitched equirect, and the size of the sphere inside it.

    Tiles pad the canvas up to a multiple of 512: the common 13x7 grid stitches
    to 6656x3584 over a 6656x3328 sphere. An equirect is always 2:1, so trust
    the width — read the padding as ground and every downward look gets a black
    hole punched through it.
    """
    for name in ("pano_full.jpg", "pano.jpg"):
        p = rdir / name
        if p.exists():
            eq = np.asarray(Image.open(p).convert("RGB"))
            return eq, eq.shape[1], eq.shape[1] // 2
    sys.exit(f"no pano in {rdir} — run brief.mjs first")


def load_sector(rdir, x0, y0, cols, rows, gcols):
    """The cached z5 tiles for a sector, as one canvas. None if none are there.

    Below roughly 45 degrees down Google stops holding zoom-5 detail and answers
    with a 256px stand-in for the same patch of sphere. Scale it up like stitch.py
    does: it covers its cell either way, and a cell left part-filled punches tile-
    shaped holes through the view.
    """
    canvas = np.full((rows * TILE, cols * TILE, 3), FILL, np.uint8)
    found = 0
    for r in range(rows):
        for c in range(cols):
            p = rdir / "z5" / f"z5_{y0 + r}_{(x0 + c) % gcols}.jpg"
            if not p.exists():
                continue
            try:
                t = Image.open(p).convert("RGB")
            except OSError:
                continue
            if t.size != (TILE, TILE):
                t = t.resize((TILE, TILE))
            canvas[r * TILE : (r + 1) * TILE, c * TILE : (c + 1) * TILE] = np.asarray(t)
            found += 1
    return canvas if found else None


def cmd_views(rdir):
    wanted = [("front", 0), ("right", 90), ("back", 180), ("left", 270)]
    todo = [(n, y) for n, y in wanted if not (rdir / f"view_{n}.jpg").exists()]
    if not todo:
        return
    eq, w, h = load_pano(rdir)
    for name, yaw in todo:
        render(eq, w, h, 0, 0, yaw, -5, 100).save(rdir / f"view_{name}.jpg", quality=87)


def cmd_look(rdir, yaw, pitch, fov, out, sector):
    canvas = None
    if sector:
        x0, y0, cols, rows, gcols, grows = sector
        if cols > 0 and rows > 0 and gcols > 0 and grows > 0:
            canvas = load_sector(rdir, x0, y0, cols, rows, gcols)
    if canvas is None:  # no sector asked for, or nothing cached — use the stitch
        eq, w, h = load_pano(rdir)
        img = render(eq, w, h, 0, 0, yaw, pitch, fov)
    else:
        img = render(canvas, gcols * TILE, grows * TILE, x0 * TILE, y0 * TILE, yaw, pitch, fov)
    img.save(out, quality=90)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "views" and len(sys.argv) == 3:
        cmd_views(Path(sys.argv[2]))
    elif mode == "look" and len(sys.argv) in (7, 13):
        rdir = Path(sys.argv[2])
        yaw, pitch, fov = (float(a) for a in sys.argv[3:6])
        sector = [int(a) for a in sys.argv[7:13]] if len(sys.argv) == 13 else None
        cmd_look(rdir, yaw, pitch, fov, sys.argv[6], sector)
    else:
        sys.exit(__doc__)
