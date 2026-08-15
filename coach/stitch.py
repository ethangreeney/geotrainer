#!/usr/bin/env python3
"""Stitch a round's pano_{row}_{col}.jpg tiles into one pano.jpg (4x2 grid).

Usage: python3 stitch.py <round-dir> [<round-dir> ...]
Missing tiles are left as dark gray cells; rounds with no tiles are skipped.
"""
import sys
from pathlib import Path

from PIL import Image

TILE = 512
MAX_W = 2048  # overview width; individual tiles remain the zoom mechanism


def stitch(rdir: Path) -> bool:
    tiles = {}
    for f in rdir.glob("pano_*_*.jpg"):
        try:
            y, x = (int(p) for p in f.stem.split("_")[1:3])
        except ValueError:
            continue
        tiles[(y, x)] = f
    if not tiles:
        return False
    rows = max(y for y, _ in tiles) + 1
    cols = max(x for _, x in tiles) + 1
    out = Image.new("RGB", (cols * TILE, rows * TILE), (40, 40, 40))
    for (y, x), f in tiles.items():
        try:
            out.paste(Image.open(f).convert("RGB").resize((TILE, TILE)), (x * TILE, y * TILE))
        except OSError:
            pass
    if out.width > MAX_W:
        out = out.resize((MAX_W, out.height * MAX_W // out.width))
    out.save(rdir / "pano.jpg", quality=82)
    return True


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        ok = stitch(Path(arg))
        print(("stitched " if ok else "no tiles ") + arg)
