#!/usr/bin/env python3
"""Generate the app icons. Committed output lives in web/icons/.

    python3 tools/make-icons.py

Kept as a script rather than binary blobs appearing from nowhere: the icons should be
reproducible from the repo, and re-renderable if the palette in index.html changes.
The motif is the app itself — a receipt with a torn edge, dark ink on paper, one accent
line — so the home-screen icon looks like the thing it prints.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

BG = (22, 24, 28)          # --panel, the app background
INK = (233, 234, 236)      # --ink
PAPER = (232, 226, 212)    # --accent, the paper tone
ACCENT = (127, 209, 168)   # --go

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"


def draw_icon(size: int, maskable: bool = False) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)

    # maskable icons get cropped to a circle by the launcher: keep the motif inside 80%
    pad = int(size * (0.24 if maskable else 0.15))
    w = size - pad * 2
    x0, y0 = pad, pad
    top = y0 + int(w * 0.06)
    body = y0 + int(w * 0.82)          # where the paper ends and the tear begins
    depth = int(w * 0.075)
    teeth = 6

    # One polygon: paper, then a torn bottom edge drawn as even V-notches. Building it as a
    # single path (rather than triangles stamped over the paper) is what keeps the teeth
    # uniform right up to both corners.
    pts = [(x0, top), (x0 + w, top), (x0 + w, body)]
    tw = w / teeth
    for i in range(teeth):
        pts.append((int(x0 + w - (i + 0.5) * tw), body - depth))
        pts.append((int(x0 + w - (i + 1) * tw), body))
    d.polygon(pts, fill=PAPER)

    # printed lines: dark ink, ragged right edge. Fewer and thicker so they still read at
    # the 48 px size a launcher may actually use.
    line_h = max(3, int(w * 0.085))
    gap = int(w * 0.075)
    y = top + int(w * 0.15)
    widths = [0.70, 0.86, 0.58, 0.44]
    for i, frac in enumerate(widths):
        lw = int(w * frac * 0.76)
        colour = ACCENT if i == 2 else (58, 60, 64)
        d.rectangle([x0 + int(w * 0.10), y, x0 + int(w * 0.10) + lw, y + line_h], fill=colour)
        y += line_h + gap

    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    written = []
    for size in (192, 512):
        p = OUT / f"icon-{size}.png"
        draw_icon(size).save(p, "PNG", optimize=True)
        written.append(p)
    p = OUT / "icon-maskable-512.png"
    draw_icon(512, maskable=True).save(p, "PNG", optimize=True)
    written.append(p)
    p = OUT / "apple-touch-icon-180.png"
    draw_icon(180).save(p, "PNG", optimize=True)
    written.append(p)
    for p in written:
        print(f"  {p.relative_to(OUT.parent.parent)}  {p.stat().st_size} bytes")


if __name__ == "__main__":
    main()
