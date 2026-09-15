#!/usr/bin/env python3
"""Render the social card (og:image) for scriptkitty.sh.

Uses the site's own logo and its self-hosted fonts so the card matches the page
it links to. The woff2 files are converted to TTF in memory because Pillow can't
read woff2 directly.

    pip install cairosvg pillow fonttools brotli
    python3 scripts/build_og_image.py
"""
import io
import pathlib

import cairosvg
import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
FONTS = WEB / "vendor/fonts"

W, H = 1200, 630
BG_IN, BG_OUT = (0x12, 0x20, 0x1a), (0x0b, 0x10, 0x17)   # matches .detect-hero
TEXT = (0xee, 0xf2, 0xf7)
SECONDARY = (0xc4, 0xce, 0xdb)
MUTED = (0x8a, 0x95, 0xa5)
ACCENT = (0x7b, 0xf1, 0xad)


def ttf(glob_pattern):
    """Load a self-hosted woff2 as a Pillow-usable TTF buffer."""
    src = next(p for p in sorted(FONTS.glob(glob_pattern)) if "latin-ext" not in p.name)
    buf = io.BytesIO()
    TTFont(src).save(buf)
    buf.seek(0)
    return buf.read()


MONO_TTF = ttf("jetbrains-mono-*.woff2")
SANS_TTF = ttf("space-grotesk-*.woff2")


def font(data, size, weight):
    f = ImageFont.truetype(io.BytesIO(data), size)
    f.set_variation_by_axes([weight])
    return f


# background: radial-gradient(130% 130% at 15% 0%, #12201a, #0b1017)
yy, xx = np.mgrid[0:H, 0:W]
dist = np.hypot(xx - 0.15 * W, yy.astype(float))
t = np.clip(dist / (1.30 * max(W, H)), 0, 1)[..., None]
bg = (np.array(BG_IN) * (1 - t) + np.array(BG_OUT) * t).astype(np.uint8)
card = Image.fromarray(bg, "RGB").convert("RGBA")

# hairline accent frame, same tint as the hero panel's border. Drawn on its own
# layer: ImageDraw replaces alpha rather than blending, so a translucent fill
# painted straight onto the card would flatten to full-strength green.
frame = Image.new("RGBA", card.size, (0, 0, 0, 0))
ImageDraw.Draw(frame).rounded_rectangle(
    [28, 28, W - 29, H - 29], radius=26, outline=(*ACCENT, 56), width=2)
card.alpha_composite(frame)
d = ImageDraw.Draw(card)

LOGO_W, LX, GAP, MARGIN = 340, 100, 60, 100
logo = Image.open(io.BytesIO(
    cairosvg.svg2png(bytestring=(WEB / "assets/scriptkitty-logo.svg").read_bytes(),
                     output_width=LOGO_W))).convert("RGBA")
x = LX + LOGO_W + GAP
avail = W - x - MARGIN

name, tld = "scriptkitty", ".sh"
wordmark = font(MONO_TTF, 76, 700)
while d.textlength(name + tld, font=wordmark) > avail and wordmark.size > 40:
    wordmark = font(MONO_TTF, wordmark.size - 1, 700)
headline = font(SANS_TTF, 40, 500)
sub = font(MONO_TTF, 24, 400)

LINE2_GAP, HEAD_GAP, SUB_GAP = 52, 44, 60
head_lines = ("Flash your board", "in the browser")
block_h = (wordmark.size + HEAD_GAP + LINE2_GAP + headline.size + SUB_GAP + sub.size)
y = (H - block_h) // 2

card.alpha_composite(logo, (LX, (H - logo.height) // 2))

d.text((x, y), name, font=wordmark, fill=TEXT)
d.text((x + d.textlength(name, font=wordmark), y), tld, font=wordmark, fill=ACCENT)

y += wordmark.size + HEAD_GAP
for i, line in enumerate(head_lines):
    d.text((x, y + i * LINE2_GAP), line, font=headline, fill=SECONDARY)

y += LINE2_GAP + headline.size + SUB_GAP
d.text((x, y), "Nugget · Nibble · Pusheen · DEF CON badge", font=sub, fill=MUTED)

out = WEB / "assets/og-image.png"
card.convert("RGB").save(out, optimize=True)
print(f"wrote {out.relative_to(ROOT)} ({W}x{H}, {out.stat().st_size // 1024} KB)")
