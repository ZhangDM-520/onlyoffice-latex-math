#!/usr/bin/env python3
"""Generate the plugin icons (pure Python, no image libraries).

Every icon is rasterised from the same "sigma" glyph so the toolbar, context
menu and store entries stay visually consistent. Run from the repo root:

    python3 tools/make-icons.py
"""

import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "plugin", "resources")

TILE_COLOR = (0x5B, 0x4C, 0x1A)
TILE_GLYPH = (0xF2, 0xE9, 0xC9)
GLYPH_LIGHT_THEME = (0x33, 0x33, 0x33)
GLYPH_DARK_THEME = (0xE8, 0xE8, 0xE8)

# Sigma drawn as an open polyline in unit coordinates.
SIGMA = [
    (0.30, 0.20),
    (0.70, 0.20),
    (0.42, 0.50),
    (0.70, 0.80),
    (0.30, 0.80),
]
STROKE_WIDTH = 0.11
SUPERSAMPLE = 4


def write_png(path, width, height, pixel_fn):
    """pixel_fn(x, y) -> (r, g, b, a)."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        for x in range(width):
            raw.extend(pixel_fn(x, y))

    def chunk(tag, payload):
        data = tag + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(png)


def distance_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length_sq = vx * vx + vy * vy
    t = 0.0 if length_sq == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / length_sq))
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return (dx * dx + dy * dy) ** 0.5


def glyph_coverage(px, py):
    """Anti-aliased coverage of the sigma glyph at a unit-coordinate point."""
    half = STROKE_WIDTH / 2
    best = 0.0
    for (ax, ay), (bx, by) in zip(SIGMA, SIGMA[1:]):
        distance = distance_to_segment(px, py, ax, ay, bx, by)
        coverage = max(0.0, min(1.0, (half - distance) * 26.0))
        best = max(best, coverage)
    return best


def rounded_rect_coverage(px, py, radius):
    limit = 1.0
    if 0.0 <= px <= limit and 0.0 <= py <= limit:
        inside_core = (radius <= px <= limit - radius) or (radius <= py <= limit - radius)
        if inside_core:
            return 1.0
        cx = min(max(px, radius), limit - radius)
        cy = min(max(py, radius), limit - radius)
        dx, dy = px - cx, py - cy
        distance = (dx * dx + dy * dy) ** 0.5
        return max(0.0, min(1.0, (radius - distance) * 26.0))
    return 0.0


def _sample(size, x, y, fn):
    total = 0.0
    for sx in range(SUPERSAMPLE):
        for sy in range(SUPERSAMPLE):
            px = (x + (sx + 0.5) / SUPERSAMPLE) / size
            py = (y + (sy + 0.5) / SUPERSAMPLE) / size
            total += fn(px, py)
    return total / (SUPERSAMPLE * SUPERSAMPLE)


def tile_pixel(size, x, y):
    """Rounded tile with the glyph knocked out of it."""
    tile_alpha = _sample(size, x, y, lambda px, py: rounded_rect_coverage(px, py, 0.22))
    glyph_alpha = _sample(size, x, y, glyph_coverage)
    alpha = max(tile_alpha, glyph_alpha)
    if alpha <= 0:
        return (0, 0, 0, 0)

    def blend(base, top, top_alpha):
        return int(round(base * (1 - top_alpha) + top * top_alpha))

    color = tuple(blend(TILE_COLOR[i], TILE_GLYPH[i], min(1.0, glyph_alpha)) for i in range(3))
    return color + (int(round(alpha * 255)),)


def glyph_pixel(color, size, x, y):
    """Bare glyph for the light/dark themed menu icons."""
    alpha = _sample(size, x, y, glyph_coverage)
    if alpha <= 0:
        return (0, 0, 0, 0)
    return color + (int(round(alpha * 255)),)


def main():
    tile_targets = [
        "light/icon.png",
        "light/icon@2x.png",
        "dark/icon.png",
        "dark/icon@2x.png",
        "store/icons/icon.png",
        "store/icons/icon@1.25x.png",
        "store/icons/icon@1.5x.png",
        "store/icons/icon@1.75x.png",
        "store/icons/icon@2x.png",
    ]
    for target in tile_targets:
        size = 64 if "@2x" in target else 32
        write_png(os.path.join(ROOT, target), size, size, lambda x, y, s=size: tile_pixel(s, x, y))

    glyph_targets = [
        (GLYPH_LIGHT_THEME, "icons/light/latex.png"),
        (GLYPH_LIGHT_THEME, "icons/light/latex@2x.png"),
        (GLYPH_LIGHT_THEME, "icons/light/big/latex.png"),
        (GLYPH_LIGHT_THEME, "icons/light/big/latex@2x.png"),
        (GLYPH_DARK_THEME, "icons/dark/latex.png"),
        (GLYPH_DARK_THEME, "icons/dark/latex@2x.png"),
        (GLYPH_DARK_THEME, "icons/dark/big/latex.png"),
        (GLYPH_DARK_THEME, "icons/dark/big/latex@2x.png"),
    ]
    for color, target in glyph_targets:
        size = 64 if "@2x" in target else 32
        write_png(
            os.path.join(ROOT, target),
            size,
            size,
            lambda x, y, s=size, c=color: glyph_pixel(c, s, x, y),
        )

    print("icons written to", os.path.normpath(ROOT))


if __name__ == "__main__":
    main()
