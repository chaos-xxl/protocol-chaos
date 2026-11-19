#!/usr/bin/env python3
"""Render the README artwork with self-contained, outlined Inter lettering.

Artwork tooling only; not needed to run the server.
Install fonttools==4.61.1, then run:
    python3 scripts/render-hero.py --font /path/to/InterVariable.ttf --preview /path/to/preview.html

Inter is available from https://rsms.me/inter/. The font file is not embedded or
copied into the repository. The preview is written first, then its SVG figures
are exported to docs/assets/hero-dark.svg and hero-light.svg, with compact
variants for narrow README layouts.
"""

from __future__ import annotations

import argparse
import html
from pathlib import Path
from xml.etree import ElementTree

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

SLOGAN = "Connected plans. Shared memory. Yours to keep."
SUBTITLE = "An open memory protocol and MCP server for personal AI assistants."
DESCRIPTION = (
    "Claude Code, Codex and Hermes read and write the same user-owned memory "
    "repository on the user's computer or server. Within it, a street photography "
    "goal connects weekend photo walks and a first photo zine."
)
WIDTH, HEIGHT = 1600, 680
PALETTES = {
    "dark": {
        "paper": "#0c0e12", "surface": "#11161e", "node": "#1a202a",
        "ink": "#f3f4f6", "muted": "#bac2ce", "soft": "#8793a4",
        "rule": "#354152", "link": "#8b98ab", "accent": "#f5c451",
    },
    "light": {
        "paper": "#f6f4ef", "surface": "#eeebe3", "node": "#fffefa",
        "ink": "#252b34", "muted": "#505a68", "soft": "#616c79",
        "rule": "#c5c8cc", "link": "#727d8c", "accent": "#956300",
    },
}


def number(value):
    return format(round(value, 2), ".2f").rstrip("0").rstrip(".") or "0"


class Lettering:
    def __init__(self, filename):
        source = TTFont(filename)
        self.fonts = {}
        for weight in (400, 500, 600):
            if "fvar" in source:
                axes = {axis.axisTag: axis.defaultValue for axis in source["fvar"].axes}
                if "wght" in axes:
                    axes["wght"] = weight
                if "opsz" in axes:
                    axes["opsz"] = 32 if weight == 600 else 14
                font = instantiateVariableFont(source, axes, inplace=False)
            else:
                font = source
            self.fonts[weight] = (font, font.getGlyphSet(), font.getBestCmap())

    def draw(self, content, x, y, size, color, *, weight=400, tracking=0, align="left", max_width=None):
        font, glyphs, cmap = self.fonts[weight]
        scale = size / font["head"].unitsPerEm
        names = [cmap[ord(char)] for char in content]
        width = sum(glyphs[name].width * scale for name in names) + tracking * max(0, len(names) - 1)
        if max_width is not None and width > max_width:
            raise ValueError(f"Text does not fit: {content!r}, {width:.1f} > {max_width}")
        if align == "center":
            x -= width / 2
        elif align == "right":
            x -= width
        pen = SVGPathPen(glyphs, ntos=number)
        position = x
        for name in names:
            glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, position, y)))
            position += glyphs[name].width * scale + tracking
        return (
            f'<g data-label="{html.escape(content, quote=True)}" data-left="{number(x)}" '
            f'data-width="{number(width)}" data-limit="{number(max_width or width)}">'
            f'<path fill="{color}" d="{pen.getCommands()}"/></g>'
        )


def render(theme, lettering, compact=False):
    p = PALETTES[theme]
    prefix = "pc-hero-" + theme + ("-compact" if compact else "")
    width, height = (800, 800) if compact else (WIDTH, HEIGHT)
    pieces = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-labelledby="{prefix}-title {prefix}-desc">',
        f'<title id="{prefix}-title">Protocol Chaos: {SLOGAN}</title>',
        f'<desc id="{prefix}-desc">{html.escape(DESCRIPTION)}</desc>',
        "<defs>",
    ]
    for name, color in (("arrow", p["link"]), ("arrow-accent", p["accent"]), ("arrow-link", p["link"])):
        pieces.append(
            f'<marker id="{prefix}-{name}" viewBox="0 0 8 8" markerWidth="10" markerHeight="10" '
            f'refX="8" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse">'
            f'<path d="M0 0 8 4 0 8Z" fill="{color}"/></marker>'
        )
    pieces.extend([
        "</defs>",
        f'<rect width="{width}" height="{height}" fill="{p["paper"]}"/>',
    ])

    def text(content, x, y, size=24, role="ink", **kwargs):
        pieces.append(lettering.draw(content, x, y, size, p[role], **kwargs))

    def rect(x, y, width, height, fill, stroke, *, radius=8, stroke_width=1.5):
        pieces.append(
            f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" '
            f'fill="{p[fill]}" stroke="{p[stroke]}" stroke-width="{stroke_width}"/>'
        )

    if compact:
        text("PROTOCOL CHAOS", 48, 48, 20, "muted", weight=500, tracking=2.4, max_width=704)
        for content, baseline, role in (
            ("Connected plans.", 120, "ink"),
            ("Shared memory.", 192, "ink"),
            ("Yours to keep.", 264, "accent"),
        ):
            text(content, 48, baseline, 60, role, weight=600, tracking=-1.2, max_width=704)
        text("An open memory protocol and MCP server", 48, 320, 28, "muted", max_width=704)
        text("for personal AI assistants.", 48, 356, 28, "muted", max_width=704)
        rect(48, 496, 704, 264, "surface", "accent", stroke_width=2)
        text("YOUR MEMORY", 72, 532, 24, "accent", weight=500, tracking=1.2, max_width=320)
        text("Your device / server", 728, 532, 24, "muted", align="right", max_width=280)
        for center in (160, 400, 640):
            pieces.append(
                f'<path d="M{center} 456V488" fill="none" stroke="{p["link"]}" stroke-width="2" '
                f'marker-start="url(#{prefix}-arrow)" marker-end="url(#{prefix}-arrow)"/>'
            )
        for x, label in ((64, "Claude Code"), (304, "Codex"), (544, "Hermes")):
            rect(x, 392, 192, 56, "surface", "rule")
            text(label, x + 96, 428, 24, weight=500, align="center", max_width=160)
        pieces.append(
            f'<path d="M256 616V640Q256 648 248 648H240Q232 648 232 656V672" '
            f'fill="none" stroke="{p["link"]}" stroke-width="2"/>'
        )
        pieces.append(
            f'<path d="M544 616V640Q544 648 552 648H560Q568 648 568 656V672" '
            f'fill="none" stroke="{p["link"]}" stroke-width="2"/>'
        )
        rect(64, 552, 672, 64, "node", "rule")
        text("Learn street photography", 400, 592, 28, weight=500, align="center", max_width=624)
        for x, label in ((64, "Weekend photo walks"), (416, "First photo zine")):
            rect(x, 672, 320, 64, "node", "rule")
            text(label, x + 160, 712, 24, weight=500, align="center", max_width=288)
        pieces.append("</svg>")
        return "\n".join(pieces)

    text("PROTOCOL CHAOS", 80, 76, 20, "muted", weight=500, tracking=3, max_width=608)
    for content, baseline, role in (
        ("Connected plans.", 196, "ink"),
        ("Shared memory.", 284, "ink"),
        ("Yours to keep.", 372, "accent"),
    ):
        text(content, 80, baseline, 72, role, weight=600, tracking=-1.6, max_width=608)
    text("An open memory protocol and MCP server", 80, 436, 24, "muted", max_width=608)
    text("for personal AI assistants.", 80, 472, 24, "muted", max_width=608)

    rect(80, 556, 480, 64, "surface", "rule")
    text(">", 104, 596, 24, "soft", weight=500)
    text("npx protocol-chaos init", 144, 596, 24, "ink", max_width=384)

    text("YOUR ASSISTANTS", 800, 92, 20, "soft", weight=500, tracking=1.6, max_width=688)
    # The boundary denotes ownership and storage, not a hosted service.
    rect(768, 272, 752, 352, "surface", "accent", radius=8, stroke_width=2)
    text("YOUR MEMORY", 800, 316, 20, "accent", weight=500, tracking=1.6, max_width=256)
    text("Your computer or server", 1488, 316, 20, "muted", align="right", max_width=336)
    pieces.append(f'<path d="M800 336H1488" fill="none" stroke="{p["rule"]}" stroke-width="1"/>')

    # Each client has a separate read/write connection to the same repository.
    for center in (904, 1144, 1384):
        pieces.append(
            f'<path d="M{center} 196V264" fill="none" stroke="{p["link"]}" stroke-width="2" '
            f'marker-start="url(#{prefix}-arrow)" marker-end="url(#{prefix}-arrow)"/>'
        )
    for x, label in ((800, "Claude Code"), (1040, "Codex"), (1280, "Hermes")):
        rect(x, 124, 208, 64, "surface", "rule")
        text(label, x + 104, 164, 24, weight=500, align="center", max_width=176)

    # Separate rounded elbows preserve the two parent-child relationships.
    pieces.append(
        f'<path d="M1008 436V456Q1008 464 1000 464H968Q960 464 960 472V516" '
        f'fill="none" stroke="{p["link"]}" stroke-width="2"/>'
    )
    pieces.append(
        f'<path d="M1280 436V456Q1280 464 1288 464H1320Q1328 464 1328 472V516" '
        f'fill="none" stroke="{p["link"]}" stroke-width="2"/>'
    )
    rect(824, 356, 640, 80, "node", "rule")
    text("GOAL", 848, 384, 16, "soft", weight=500, tracking=1.2)
    text("Learn street photography", 848, 420, 28, weight=500, max_width=592)
    for x, kind, label in (
        (800, "PLAN", "Weekend photo walks"),
        (1168, "PROJECT", "First photo zine"),
    ):
        rect(x, 516, 320, 76, "node", "rule")
        text(kind, x + 24, 540, 16, "soft", weight=500, tracking=1.2)
        text(label, x + 24, 576, 24, weight=500, max_width=272)
    pieces.append("</svg>")
    return "\n".join(pieces)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, required=True, help="Inter variable TTF")
    parser.add_argument("--preview", type=Path, required=True, help="Self-contained HTML preview")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "docs" / "assets")
    args = parser.parse_args()
    lettering = Lettering(args.font)
    variants = {theme: render(theme, lettering) for theme in PALETTES}
    variants.update({theme + "-compact": render(theme, lettering, compact=True) for theme in PALETTES})
    preview = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Protocol Chaos hero preview</title>'
        '<style>body{margin:0;background:#e7e5df;font-family:Arial,sans-serif}'
        'main{max-width:1600px;margin:auto}section{margin:0 0 24px}svg{display:block;width:100%;height:auto}'
        'h2{font-size:16px;font-weight:500;margin:16px 20px}</style>'
        '<body><main>'
        + "".join(f'<section id="{theme}"><h2>{theme.title()}</h2>{svg}</section>' for theme, svg in variants.items())
        + "</main></body></html>"
    )
    args.preview.parent.mkdir(parents=True, exist_ok=True)
    args.preview.write_text(preview, encoding="utf-8")
    args.output.mkdir(parents=True, exist_ok=True)
    for theme, svg in variants.items():
        ElementTree.fromstring(svg)
        destination = args.output / ("hero-" + theme + ".svg")
        destination.write_text(svg + "\n", encoding="utf-8")
        print(f"{destination.name}: {destination.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
