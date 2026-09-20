#!/usr/bin/env python3
"""Generate the plugin icon set from noctalia's shipped Tabler font.

The icons are committed PNGs, so installing the plugin needs neither the font nor
Pillow - copying the files is enough. Regenerating them does need both:

    python3 tools/make-icons.py            # rewrite every icon
    python3 tools/make-icons.py --check    # verify the files on disk, write nothing
    python3 tools/make-icons.py --list     # print the slot -> glyph manifest

Glyph source, shipped by the `noctalia-git` package and found through `--font`,
`$NOCTALIA_FONT` or the default path:

    /usr/share/noctalia/assets/fonts/noctalia-tabler.ttf         the icon font
    /usr/share/noctalia/assets/fonts/tabler.json                 name -> {category, codepoint}
    /usr/share/noctalia/assets/fonts/tabler-icons-license.txt    MIT, (c) 2020-2025 Pawel Kuna

Why every scale is written
--------------------------
ONLYOFFICE expands `%scale%(default)` into five keys (100/125/150/175/200 %) and
then picks the one nearest `applicationPixelRatio() * 100` - see
`Common.UI.iconsStr2IconsObj` / `getSuitableIcons` in the editor's utils.js. It
does **not** fall back to the 100 % file, so a missing `icon@1.25x.png` renders
as nothing at all on a 1.25 display. That is exactly what happened here.
"""

import argparse
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESOURCES = os.path.join(ROOT, "plugin", "resources")

DEFAULT_FONT_DIR = "/usr/share/noctalia/assets/fonts"
FONT_FILE = "noctalia-tabler.ttf"
MAP_FILE = "tabler.json"
LICENSE_FILE = "tabler-icons-license.txt"
VENDORED_LICENSE = os.path.join(RESOURCES, "icons", "LICENSE-tabler.txt")

# Base pixel sizes follow the shipped plugins: entry and ribbon icons are 28 px
# at 100 % (Send's entry icon, AI's big icons), menu icons are 20 px (AI's set).
ENTRY_BASE = 28
RIBBON_BASE = 28
MENU_BASE = 20

# 1.0 -> "icon.png", 1.25 -> "icon@1.25x.png", ...
SCALES = ((1.0, ""), (1.25, "@1.25x"), (1.5, "@1.5x"), (1.75, "@1.75x"), (2.0, "@2x"))

TILE_BG = (0x5B, 0x4C, 0x1A)
TILE_FG = (0xF2, 0xE9, 0xC9)
MENU_FG = {"light": (0x33, 0x33, 0x33), "dark": (0xE8, 0xE8, 0xE8)}

# Fraction of the cell the glyph's em box occupies, and the tile corner radius.
MENU_FILL = 1.0
TILE_FILL = 0.72
TILE_RADIUS = 0.22
SUPERSAMPLE = 4

# One source of truth for every icon in the repo: slot -> Tabler glyph name.
GLYPHS = {
    "latex": "math-function",
    "document": "math-symbols",
    "selection": "select",
    "display": "matrix",
    "report": "report",
    "report-on": "eye",
    "report-off": "eye-off",
    "inline-dollar": "currency-dollar",
    "display-dollar": "sum",
    "inline-paren": "parentheses",
    "display-bracket": "brackets",
}
LOGO_GLYPH = "math-function"
THEMES = ("light", "dark")

MIN_VISIBLE_FRACTION = 0.05


def slot_names():
    return sorted(GLYPHS)


def entry_paths(suffix):
    """The per-theme plugin entry icon plus the store icon."""
    paths = [os.path.join(RESOURCES, theme, "icon" + suffix + ".png") for theme in THEMES]
    paths.append(os.path.join(RESOURCES, "store", "icons", "icon" + suffix + ".png"))
    return paths


def expected_files():
    """Every file this tool owns: {path, size, kind, theme, glyph}."""
    files = []
    for factor, suffix in SCALES:
        for path in entry_paths(suffix):
            files.append(
                {"path": path, "size": int(round(ENTRY_BASE * factor)), "kind": "tile", "glyph": LOGO_GLYPH}
            )
        for theme in THEMES:
            for name in slot_names():
                for base, build in ((RIBBON_BASE, ribbon_path), (MENU_BASE, menu_path)):
                    files.append(
                        {
                            "path": build(theme, name, suffix),
                            "size": int(round(base * factor)),
                            "kind": "glyph",
                            "theme": theme,
                            "glyph": GLYPHS[name],
                        }
                    )
    files.append({"path": VENDORED_LICENSE, "size": 0, "kind": "license"})
    return files


def ribbon_path(theme, name, suffix):
    return os.path.join(RESOURCES, "icons", theme, "big", name + suffix + ".png")


def menu_path(theme, name, suffix):
    return os.path.join(RESOURCES, "icons", theme, name + suffix + ".png")


def load_pillow():
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        raise SystemExit(
            "error: Pillow is required to regenerate the icons (install python-pillow).\n"
            "       The committed PNGs are enough to install and run the plugin."
        )
    return Image, ImageDraw, ImageFont


def find_font_dir(explicit):
    candidates = [explicit, os.environ.get("NOCTALIA_FONT"), DEFAULT_FONT_DIR]
    for candidate in candidates:
        if candidate and all(
            os.path.isfile(os.path.join(candidate, name)) for name in (FONT_FILE, MAP_FILE)
        ):
            return candidate
    raise SystemExit(
        "error: the noctalia Tabler font was not found. Looked in: "
        + ", ".join([c for c in candidates if c])
        + f"\n       expected {FONT_FILE} and {MAP_FILE} beside each other;"
        + "\n       install noctalia-git or pass --font <dir>."
    )


def load_glyph_map(font_dir):
    with open(os.path.join(font_dir, MAP_FILE), encoding="utf-8") as handle:
        table = json.load(handle)
    resolved = {}
    missing = []
    for name in sorted(set(GLYPHS.values()) | {LOGO_GLYPH}):
        entry = table.get(name)
        if not entry:
            missing.append(name)
        else:
            resolved[name] = int(str(entry["codepoint"]).replace("U+", ""), 16)
    if missing:
        raise SystemExit(
            "error: the glyph map has no entry for: "
            + ", ".join(missing)
            + f"\n       ({os.path.join(font_dir, MAP_FILE)})"
        )
    return resolved


def render_mask(Image, ImageDraw, ImageFont, font_path, codepoint, cell, fill):
    """A greyscale mask of one glyph, its em box centred in a `cell` px canvas.

    Tabler draws on a 24-unit grid and centres the ink inside the em box, so the
    em box is what gets placed. Normalising the ink instead would stretch `sum`
    and squash `report` to the same height.
    """
    work = cell * SUPERSAMPLE
    em = max(1, int(round(work * fill)))
    font = ImageFont.truetype(font_path, em)
    canvas = Image.new("L", (work, work), 0)
    offset = (work - em) // 2
    ImageDraw.Draw(canvas).text((offset, offset), chr(codepoint), font=font, fill=255)
    return canvas.resize((cell, cell), Image.LANCZOS)


def compose(Image, ImageDraw, cell, mask, fg, bg=None):
    image = Image.new("RGBA", (cell, cell), (0, 0, 0, 0))
    if bg is not None:
        work = cell * SUPERSAMPLE
        tile = Image.new("RGBA", (work, work), (0, 0, 0, 0))
        ImageDraw.Draw(tile).rounded_rectangle(
            [0, 0, work - 1, work - 1], radius=int(work * TILE_RADIUS), fill=bg + (255,)
        )
        image = tile.resize((cell, cell), Image.LANCZOS)
    tinted = Image.new("RGBA", (cell, cell), fg + (0,))
    tinted.putalpha(mask)
    return Image.alpha_composite(image, tinted)


def generate(font_dir, quiet=False):
    Image, ImageDraw, ImageFont = load_pillow()
    glyphs = load_glyph_map(font_dir)
    font_path = os.path.join(font_dir, FONT_FILE)

    written = 0
    for entry in expected_files():
        if entry["kind"] == "license":
            os.makedirs(os.path.dirname(entry["path"]), exist_ok=True)
            shutil.copyfile(os.path.join(font_dir, LICENSE_FILE), entry["path"])
            written += 1
            continue
        cell = entry["size"]
        codepoint = glyphs[entry["glyph"]]
        if entry["kind"] == "tile":
            mask = render_mask(Image, ImageDraw, ImageFont, font_path, codepoint, cell, TILE_FILL)
            image = compose(Image, ImageDraw, cell, mask, TILE_FG, TILE_BG)
        else:
            mask = render_mask(Image, ImageDraw, ImageFont, font_path, codepoint, cell, MENU_FILL)
            image = compose(Image, ImageDraw, cell, mask, MENU_FG[entry["theme"]])
        os.makedirs(os.path.dirname(entry["path"]), exist_ok=True)
        image.save(entry["path"], "PNG")
        written += 1

    if not quiet:
        print(f"wrote {written} files under {os.path.normpath(RESOURCES)}")
    return written


def check(quiet=False):
    """Verify every owned file: present, correct size, visibly non-blank.

    This is the guard for the defect the manifest exists for: a missing scale
    variant renders as *nothing* in the editor, with no error anywhere.
    """
    Image, _ImageDraw, _ImageFont = load_pillow()
    problems = []
    checked = 0

    for entry in expected_files():
        path = entry["path"]
        rel = os.path.relpath(path, ROOT)
        if not os.path.isfile(path):
            problems.append(f"missing: {rel}")
            continue
        if entry["kind"] == "license":
            checked += 1
            continue
        try:
            with Image.open(path) as image:
                size = image.size
                # tobytes() rather than the deprecated getdata(): one byte per pixel.
                opaque = sum(1 for value in image.convert("RGBA").getchannel("A").tobytes() if value > 8)
        except Exception as error:  # pragma: no cover - corrupt file
            problems.append(f"unreadable: {rel} ({error})")
            continue
        if size != (entry["size"], entry["size"]):
            problems.append(f"wrong size: {rel} is {size[0]}x{size[1]}, expected {entry['size']}px")
        floor = int(entry["size"] * entry["size"] * MIN_VISIBLE_FRACTION)
        if opaque < floor:
            problems.append(f"blank: {rel} has {opaque} visible pixels (floor {floor})")
        checked += 1

    if not quiet:
        if problems:
            print(f"{len(problems)} problem(s):")
            for problem in problems:
                print("  " + problem)
        else:
            print(f"{checked} files ok (every scale, both themes, non-blank)")
    return 1 if problems else 0


def main(argv):
    parser = argparse.ArgumentParser(description="Generate or verify the plugin icon set.")
    parser.add_argument("--check", action="store_true", help="verify the files on disk, write nothing")
    parser.add_argument("--list", action="store_true", help="print the slot -> glyph manifest")
    parser.add_argument("--font", metavar="DIR", help=f"directory holding {FONT_FILE} and {MAP_FILE}")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    if args.list:
        # `icon` is the entry/store slot; its files are literally icon*.png.
        print(f"{'icon':<22} {LOGO_GLYPH}")
        for name in slot_names():
            print(f"{name:<22} {GLYPHS[name]}")
        files = expected_files()
        print(f"\n{len(files)} files = 5 scales x (2 entry themes + store)"
              f" + 5 scales x 2 themes x {len(slot_names())} x (ribbon + menu) + 1 license")
        return 0

    if args.check:
        return check(args.quiet)

    generate(find_font_dir(args.font), args.quiet)
    return check(args.quiet)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
