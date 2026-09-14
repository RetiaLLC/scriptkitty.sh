#!/usr/bin/env python3
"""Render the site's raster icons from the two committed logo SVGs.

  web/assets/scriptkitty-logo.svg  full line work (header, large use)
  web/assets/scriptkitty-mark.svg  simplified square mark - the prompt, nose,
                                   lashes and ear lines are dropped because they
                                   turn to mush below ~48px

Outputs favicon.ico / favicon-*.png / apple-touch-icon.png / a transparent PNG
master. Re-run after editing either SVG:

    pip install cairosvg pillow && python3 scripts/build_icons.py
"""
import io
import pathlib

import cairosvg
from PIL import Image

WEB = pathlib.Path(__file__).resolve().parent.parent / "web"
MARK = (WEB / "assets/scriptkitty-mark.svg").read_bytes()
LOGO = (WEB / "assets/scriptkitty-logo.svg").read_bytes()


def render(svg, w, h=None):
    png = cairosvg.svg2png(bytestring=svg, output_width=w, output_height=h)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def flatten(img, bg):
    out = Image.new("RGBA", img.size, bg)
    out.alpha_composite(img)
    return out.convert("RGB")


# favicons come from the simplified mark: an .ico carrying 16/32/48 for the
# browsers that want a raster, and the SVG itself for the ones that don't
render(MARK, 48, 48).save(WEB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
(WEB / "favicon.svg").write_bytes(MARK)

# iOS home-screen icon: no alpha there, and the art is drawn for paper
touch = Image.new("RGBA", (180, 180), (255, 255, 255, 255))
art = render(LOGO, 152)
touch.alpha_composite(art, (14, (180 - art.height) // 2))
touch.convert("RGB").save(WEB / "apple-touch-icon.png")

# transparent master for social cards and anywhere a raster is easier
render(LOGO, 1024).save(WEB / "assets/scriptkitty-logo.png")

print("wrote favicon.ico, favicon.svg, apple-touch-icon.png, assets/scriptkitty-logo.png")
