# Regenerates web/public icons, favicon.svg and og-image.png in the dealt tasteskill system:
# palette white-link-blue (ground #f4f4f4, cards #fff, ink #111, muted #6b6b6b, action #1a4be0),
# type Outfit, mark "initial" (the letter on a rounded square in ink).
# Needs Pillow + fontTools and Outfit TTFs (outfit-400.ttf, outfit-500.ttf) in a folder.
# Usage: python3 scripts/make_assets.py web/public path/to/outfit-fonts
import sys
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

OUT, FONTS = sys.argv[1], sys.argv[2]
F = lambda w, s: ImageFont.truetype(f"{FONTS}/outfit-{w}.ttf", s)
GROUND, CARD, INK, MUTED, LINE, ACTION = "#f4f4f4", "#ffffff", "#111111", "#6b6b6b", "#e1e1e1", "#1a4be0"
INV_SURFACE, INV_MUTED = "#1e1e1e", "#9a9a9a"
CRIT, GOOD = "#d03b3b", "#0ca30c"

def mark(size, full_bleed=False, letter_scale=0.62):
    k = 4
    S = size * k
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0) if not full_bleed else INK)
    d = ImageDraw.Draw(im)
    if not full_bleed:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=round(S * 0.25), fill=INK)
    f = F(500, round(S * letter_scale))
    d.text((S / 2, S / 2 + S * 0.02), "Y", font=f, fill=CARD, anchor="mm")
    return im.resize((size, size), Image.LANCZOS)

mark(256).save(f"{OUT}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
mark(32).save(f"{OUT}/favicon-32.png")
mark(180, full_bleed=True, letter_scale=0.5).convert("RGB").save(f"{OUT}/apple-touch-icon.png")
mark(192).save(f"{OUT}/icon-192.png")
mark(512).save(f"{OUT}/icon-512.png")
mark(512, full_bleed=True, letter_scale=0.42).convert("RGB").save(f"{OUT}/icon-maskable-512.png")

# favicon.svg: the real Outfit "Y" outline, so it renders without the font installed
font = TTFont(f"{FONTS}/outfit-500.ttf")
gs = font.getGlyphSet()
gname = font.getBestCmap()[ord("Y")]
pen = SVGPathPen(gs); gs[gname].draw(pen)
bp = BoundsPen(gs); gs[gname].draw(bp)
xmin, ymin, xmax, ymax = bp.bounds
gw, gh = xmax - xmin, ymax - ymin
scale = 16 / gh  # letter 16 units tall on a 32 grid
tx = 16 - (xmin + gw / 2) * scale
ty = 16 + (ymin + gh / 2) * scale
svg = (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='{INK}'/>"
       f"<path fill='#ffffff' transform='translate({tx:.2f} {ty:.2f}) scale({scale:.5f} {-scale:.5f})' d='{pen.getCommands()}'/></svg>\n")
open(f"{OUT}/favicon.svg", "w").write(svg)

# ---- share card: a still of the overview's first screen ---------------------------
K = 2
W, H = 1200 * K, 630 * K
og = Image.new("RGB", (W, H), GROUND)
d = ImageDraw.Draw(og)

def text(x, y, s, font, fill, anchor="la", track=0.0):
    """Draw with letter-spacing (track in em), as the CSS tracking does."""
    if not track:
        d.text((x * K, y * K), s, font=font, fill=fill, anchor=anchor); return
    cx = x * K
    for ch in s:
        d.text((cx, y * K), ch, font=font, fill=fill, anchor=anchor)
        cx += d.textlength(ch, font=font) + track * font.size

M = 64
m = mark(40 * K)
og.paste(m, (M * K, 48 * K), m)
text(M + 52, 68, "Yatra Insight", F(500, 24 * K), INK, anchor="lm", track=-0.02)
text(M, 136, "Portfolio overview", F(500, 18 * K), MUTED)
text(M, 162, "Tourism projects at a glance", F(400, 66 * K), INK, track=-0.03)
text(M, 252, "48 projects across 27 states and territories, as of this month", F(400, 24 * K), MUTED)

# KPI cards (one figure size, ink text, colour only in the small marks)
cards = [("Physical progress", "50.8%", "Planned 62.6%", CRIT),
         ("Schedule performance", "0.85", "25 projects late", CRIT),
         ("Funds utilisation", "54.6%", "of approved cost", None),
         ("Critical issues", "8", "need escalation", CRIT)]
cw = (1200 - 2 * M - 3 * 20) / 4
for i, (label, value, foot, mk) in enumerate(cards):
    x0 = M + i * (cw + 20)
    d.rounded_rectangle([x0 * K, 312 * K, (x0 + cw) * K, 436 * K], radius=20 * K, fill=CARD, outline=LINE, width=K)
    text(x0 + 24, 334, label, F(500, 15 * K), MUTED)
    text(x0 + 24, 358, value, F(400, 44 * K), INK, track=-0.03)
    if mk:
        d.polygon([((x0 + 24) * K, 413 * K), ((x0 + 32) * K, 413 * K), ((x0 + 28) * K, 419 * K)], fill=mk)
        text(x0 + 38, 416, foot, F(500, 15 * K), INK, anchor="lm")
    else:
        text(x0 + 24, 416, foot, F(400, 15 * K), MUTED, anchor="lm")

# the ink band: the ask panel
d.rounded_rectangle([M * K, 460 * K, (1200 - M) * K, 582 * K], radius=20 * K, fill=INK)
text(M + 32, 492, "Ask about delays, costs and milestones", F(400, 26 * K), CARD, track=-0.02)
bx1 = 1200 - M - 32
bw = d.textlength("Get an answer", font=F(500, 17 * K)) / K + 48
d.rounded_rectangle([(bx1 - bw) * K, 528 * K, bx1 * K, 562 * K], radius=8 * K, fill=CARD)
text(bx1 - bw / 2, 545, "Get an answer", F(500, 17 * K), INK, anchor="mm")
d.rounded_rectangle([(M + 32) * K, 528 * K, (bx1 - bw - 12) * K, 562 * K], radius=8 * K, fill=INV_SURFACE, outline="#3a3a3a", width=K)
text(M + 52, 545, "Which projects are delayed by more than 90 days?", F(400, 16 * K), INV_MUTED, anchor="lm")

og.resize((1200, 630), Image.LANCZOS).save(f"{OUT}/og-image.png", optimize=True)
print("ok")
