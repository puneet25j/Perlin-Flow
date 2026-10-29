"""
Generate a cover image: a Perlin-noise flow field, with an optional
name block in the bottom-right corner.

How it works
  Particles drift across a 2-D Perlin noise field, each leaving a trail that
  slowly fades. Thousands of overlapping trails build up the flowing pattern.
  Text is optional: pass --greeting, --name and/or --title to add it, set in
  Fira Code (name in cyan, greeting and title in coral). With no text options
  you get the background only.

Background styles
  bold     Coloured dots (cyan, coral, teal) with long, bright trails.
  streams  Silky single-colour strokes that follow the curl of the noise,
           with a gentle current and swirling eddies.

Requirements
  Python 3.8+, numpy and Pillow:   pip install -r requirements.txt
  Font (only needed when you add text): Fira Code (SIL Open Font License).
  If FiraCode-VF.ttf is not next to this script, it is downloaded once from
  the Google Fonts repository.

Examples
  python cover.py                              # background only, bold style
  python cover.py --style streams              # silky strokes + eddies
  python cover.py --style streams --pattern 3  # a different swirl layout
  python cover.py --style streams --current 0.4  # more drift, fewer eddies
  python cover.py --particles 1400 --fade 0.015  # denser, longer trails
  python cover.py --name "Full Name" --title "Job Title"   # add text
  python cover.py --greeting "Hello World! I am" --name "Full Name"

Notes
  --pattern moves the swirls to a new layout; --seed only reshuffles the
  individual particles within the same layout. Pattern numbers match the
  Pattern control in the companion index.html.

  Ranges shown in --help are suggestions (the same limits as the sliders in
  index.html); values outside them still work.

  Output is 3168x792 px (2x LinkedIn's 1584x396). A render takes roughly
  20-70 seconds depending on the style and your machine.
"""

import argparse
import math
import os
import sys
import urllib.request

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------

# Colour palette.
BG_HEX = "#282c34"  # background
FLOW_COLORS = ["#9cdef2", "#e06c75", "#5fb6cc"]  # cyan, coral, teal particles
NAME_HEX = "#9cdef2"  # name
ACCENT_HEX = "#e06c75"  # greeting and title
STREAM_HEX = "#9cdef2"  # single colour of the streams style

# Background presets.
# [Ranges] are suggested values; for the options the page has sliders for, they
# are the same limits as the sliders in index.html. Values outside still work,
# but tend to look empty or washed out, or take much longer to render.
#
# Shared keys:
#   mode         "dots" (particle dots) or "streams" (continuous strokes)
#   particles    number of particles alive at any time          [100 to 4000]
#   alpha        peak opacity of each particle mark             [0.05 to 1]
#   fade         how much every trail fades toward the
#                background per frame (lower = longer trails)   [0.001 to 0.1]
#   frames       simulation steps before the image is saved     [100 to 3000]
#   scrim        strength of the dark halo behind the text      [0 to 1]
# Dots only:
#   freq         noise frequency of the heading field
#                (higher = smaller swirls)                      [0.002 to 0.008]
#   turns        how far the heading can rotate across the
#                noise range                                    [2 to 8]
#   lifespan     (min, max) particle lifetime in frames         [50 to 2000]
#   radius       dot radius in px at 1x                         [0.5 to 3]
# Streams only:
#   current      strength of a steady drift across the image
#                (0 = only eddies)                              [0 to 2]
#   current_deg  direction of that drift, in degrees            [-180 to 180]
#   zoom         noise frequency (higher = smaller swirls)      [0.001 to 0.01]
#   detail       weight of a second, finer noise octave         [0 to 1]
#   lifespan     (min, max) stroke lifetime in frames           [50 to 500]
#   stroke       stroke radius in output pixels                 [0.5 to 2]
#   gamma        tone curve for the strokes (<1 = brighter)     [0.5 to 1.5]
STYLES = {
    "bold": dict(
        mode="dots",
        particles=1300,
        alpha=0.38,
        fade=0.025,
        frames=1200,
        scrim=0.0,
        freq=0.004,
        turns=5.0,
        lifespan=(150, 600),
        radius=1.1,
    ),
    "streams": dict(
        mode="streams",
        particles=1300,
        alpha=0.95,
        fade=0.006,
        frames=900,
        scrim=0.92,
        current=0.8,
        current_deg=-20,
        zoom=0.0026,
        detail=0.3,
        lifespan=(120, 220),
        stroke=0.8,
        gamma=0.8,
    ),
}

# Fira Code variable font (weights 300-700), SIL Open Font License 1.1.
FONT_URL = (
    "https://github.com/google/fonts/raw/main/ofl/firacode/FiraCode%5Bwght%5D.ttf"
)
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FONT = os.path.join(HERE, "FiraCode-VF.ttf")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def hex_rgb(h):
    """Convert "#rrggbb" to a float RGB array in the range 0-1."""
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255


def hex_tuple(h):
    """Convert "#rrggbb" to an (r, g, b) tuple of 0-255 integers."""
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def mulberry32(seed):
    """Tiny deterministic 32-bit PRNG returning floats in [0, 1).

    Used only to build the noise permutation table, so that this script and
    script.js (which has the same function) produce the exact same
    noise field.
    """
    state = seed & 0xFFFFFFFF

    def next_float():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_float


class Perlin2D:
    """Two-dimensional gradient (Perlin) noise, vectorised with numpy.

    Space is divided into a grid of unit cells. Each grid corner gets a
    pseudo-random gradient direction (picked through a shuffled permutation
    table), and the value at a point blends the four corners' contributions
    with a smooth quintic curve. The result is smooth, natural-looking noise
    in roughly [-1, 1].
    """

    # Eight unit gradient directions (axes and diagonals).
    _D = 0.7071067811865476
    GX = np.array([1.0, -1.0, 0.0, 0.0, _D, -_D, _D, -_D])
    GY = np.array([0.0, 0.0, 1.0, -1.0, _D, _D, -_D, -_D])
    SCALE = 1.4142135623730951  # stretches the natural +-0.71 range to about +-1

    def __init__(self, seed=20261028):
        # Fisher-Yates shuffle of 0..255, doubled so lookups never need wrapping.
        rand = mulberry32(seed)
        perm = list(range(256))
        for i in range(255, 0, -1):
            j = int(rand() * (i + 1))
            perm[i], perm[j] = perm[j], perm[i]
        self.perm = np.array(perm + perm, dtype=np.int64)

    def __call__(self, x, y):
        x = np.asarray(x, dtype=np.float64)
        y = np.asarray(y, dtype=np.float64)
        x0, y0 = np.floor(x), np.floor(y)
        xi = x0.astype(np.int64) & 255  # cell coordinates, wrapped to the table
        yi = y0.astype(np.int64) & 255
        fx, fy = x - x0, y - y0  # position inside the cell, 0-1

        # Quintic fade curve 6t^5 - 15t^4 + 10t^3 for smooth blending.
        u = fx * fx * fx * (fx * (fx * 6 - 15) + 10)
        v = fy * fy * fy * (fy * (fy * 6 - 15) + 10)

        # Gradient index for each of the four cell corners.
        p = self.perm
        a, b = p[xi] + yi, p[xi + 1] + yi
        g00, g01 = p[a] & 7, p[a + 1] & 7
        g10, g11 = p[b] & 7, p[b + 1] & 7

        # Dot product of each corner's gradient with the offset to the point.
        gx, gy = self.GX, self.GY
        n00 = gx[g00] * fx + gy[g00] * fy
        n10 = gx[g10] * (fx - 1) + gy[g10] * fy
        n01 = gx[g01] * fx + gy[g01] * (fy - 1)
        n11 = gx[g11] * (fx - 1) + gy[g11] * (fy - 1)

        # Blend horizontally, then vertically.
        nx0 = n00 + u * (n10 - n00)
        nx1 = n01 + u * (n11 - n01)
        return (nx0 + v * (nx1 - nx0)) * self.SCALE


NOISE = Perlin2D()

# The noise grid is rotated against the image so its cell structure never
# lines up with the edges of the cover.
ROT_C, ROT_S = 0.8775825618903728, 0.479425538604203  # cos(0.5), sin(0.5)


def field(x, y, freq, ox, oy):
    """Sample the noise at image position (x, y) with frequency and offset."""
    return NOISE(
        (x * ROT_C - y * ROT_S) * freq + ox, (x * ROT_S + y * ROT_C) * freq + oy
    )


def pattern_offset(pattern):
    """Offset into the noise plane for a given pattern number.

    Each pattern samples a different, far-apart region of the noise, which
    gives a new swirl layout. Pattern 0 is the default layout.
    """
    return pattern * 61.7, pattern * 113.9


def ensure_font(path):
    """Return a usable font path, downloading Fira Code on first run if needed."""
    if os.path.exists(path):
        return path
    print(f"Fira Code not found at {path}, downloading it from Google Fonts...")
    try:
        urllib.request.urlretrieve(FONT_URL, path)
    except Exception as e:
        sys.exit(
            f"Couldn't download the font ({e}).\n"
            f"Download Fira Code from https://fonts.google.com/specimen/Fira+Code "
            f"and pass its .ttf file with --font."
        )
    return path


def load_font(path, css_px, weight, S):
    """Load the font at a CSS pixel size, scaled by the output factor S.

    With the variable Fira Code font, the requested weight (300-700) is set on
    its weight axis. A static .ttf is used as-is, so pass a Bold file there.
    """
    f = ImageFont.truetype(path, int(round(css_px * S)))
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def splat_offsets(radius):
    """Pixel offsets around a point that a disc of this radius can touch."""
    R = int(math.ceil(radius + 0.5))
    return [(dx, dy) for dy in range(-R, R + 1) for dx in range(-R, R + 1)]


def coverage(ix, iy, cx, cy, radius):
    """Antialiased coverage (0-1) of pixel (ix, iy) by a disc centred at (cx, cy)."""
    return np.clip(radius + 0.5 - np.hypot(ix + 0.5 - cx, iy + 0.5 - cy), 0, 1)


# --------------------------------------------------------------------------
# Backgrounds
# --------------------------------------------------------------------------


def render_dots(
    W,
    H,
    S,
    particles,
    alpha,
    fade,
    frames,
    freq,
    turns,
    lifespan,
    radius,
    seed,
    pattern=0,
):
    """Render the dot-style background (the "bold" style).

    Every frame, the whole image fades a little toward the background, each
    particle takes a step in the direction the noise field points, and a small
    antialiased dot is drawn where it lands. Because old dots fade slowly
    instead of being erased, they form trails. Where the field converges,
    many trails pile up into bright, feathered lines.

    W, H     cover size in CSS pixels (1584 x 396)
    S        output scale (2 gives a 3168 x 792 image)
    seed     random seed for particle starting positions and respawns
    pattern  which swirl layout to use (see pattern_offset)
    Returns an RGBA PIL image.
    """
    rng = np.random.default_rng(seed)
    ox, oy = pattern_offset(pattern)
    PW, PH = W * S, H * S  # output size in pixels
    bg = hex_rgb(BG_HEX)
    colors = np.stack([hex_rgb(c) for c in FLOW_COLORS])

    # The image holds each pixel's colour; it starts as plain background.
    img = np.empty((PH, PW, 3))
    img[:] = bg

    # Particle state: position (CSS px), age and lifetime (frames), colour.
    def spawn(n):
        return rng.random(n) * W, rng.random(n) * H, rng.uniform(*lifespan, n)

    px, py, life = spawn(particles)
    age = rng.random(particles) * life  # start at random points in their lives
    pc = colors[np.arange(particles) % len(colors)]

    r = radius * S
    offs = splat_offsets(r)

    for t in range(frames):
        if t % 200 == 0:
            print(f"  frame {t}/{frames}", flush=True)

        # Fade everything drawn so far toward the background colour.
        img += (bg - img) * fade

        # Heading comes from the noise (slowly drifting over time); speed from a
        # second, independent noise sample, between 1 and 2.5 px per frame.
        ang = field(px + t * 0.2, py, freq, ox, oy) * math.pi * turns
        spd = 1.75 + 0.75 * field(px, py, freq * 0.7, ox + 31.7, oy + 47.3)
        px += np.cos(ang) * spd
        py += np.sin(ang) * spd
        age += 1

        # Particles that outlive their lifespan or leave the frame respawn.
        dead = (age >= life) | (px < 0) | (px > W) | (py < 0) | (py > H)
        k = int(dead.sum())
        if k:
            px[dead], py[dead], life[dead] = spawn(k)
            age[dead] = 0

        # Draw each particle as an antialiased dot that dims as it ages.
        cx, cy = px * S, py * S
        bx, by = np.floor(cx).astype(int), np.floor(cy).astype(int)
        strength = (1 - age / life) * alpha
        for dx, dy in offs:
            ix, iy = bx + dx, by + dy
            cov = coverage(ix, iy, cx, cy, r)
            m = (cov > 0) & (ix >= 0) & (ix < PW) & (iy >= 0) & (iy < PH)
            if m.any():
                a = (strength[m] * cov[m])[:, None]
                yy, xx = iy[m], ix[m]
                img[yy, xx] += (pc[m] - img[yy, xx]) * a  # blend toward dot colour

    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8)).convert(
        "RGBA"
    )


def render_streams(
    W,
    H,
    S,
    particles,
    alpha,
    fade,
    frames,
    current,
    current_deg,
    zoom,
    detail,
    lifespan,
    stroke,
    gamma,
    seed,
    pattern=0,
):
    """Render the "streams" background: continuous, tapered single-colour strokes.

    Particles follow the curl of a noise "stream function" instead of using
    the noise as an angle directly. A curl field has no sources or sinks, so
    the lines never bunch up into the bright convergence lines of the dot
    style. They swirl into eddies and sweep along a gentle current instead.

    Each frame, every particle draws a short stroke from its previous to its
    new position. Strokes are faint at birth and death (a sine envelope over
    the particle's life), which gives the hair-like tapered look.

    Parameters match the "streams" entry in STYLES; W, H, S, seed and pattern
    are as in render_dots. Returns an RGBA PIL image.
    """
    rng = np.random.default_rng(seed)
    ox, oy = pattern_offset(pattern)
    PW, PH = W * S, H * S
    bg, fg = hex_rgb(BG_HEX), hex_rgb(STREAM_HEX)
    th = math.radians(current_deg)

    # "ink" is how much stroke colour each pixel holds: 0 = background, 1 = full.
    ink = np.zeros(PH * PW, dtype=np.float32)

    def spawn(n):
        return rng.random(n) * W, rng.random(n) * H, rng.uniform(*lifespan, n)

    px, py, life = spawn(particles)
    age = rng.random(particles) * life

    offs = splat_offsets(stroke)
    samples = 8  # discs per stroke segment, so the strokes look continuous

    def psi(x, y, t):
        """Stream function: two noise octaves plus a linear "current" ramp."""
        return (
            field(x + t * 0.2, y, zoom, ox, oy)
            + detail * field(x, y, zoom * 2.03, ox + 17.3, oy + 41.9)
            + current * (math.cos(th) * y - math.sin(th) * x) * zoom
        )

    for t in range(frames):
        if t % 150 == 0:
            print(f"  frame {t}/{frames}", flush=True)

        # Fade existing strokes toward the background.
        ink *= 1 - fade

        # Velocity is the curl of psi, (dpsi/dy, -dpsi/dx), estimated with
        # central differences. Only its direction is used; the speed comes from
        # a separate noise sample, between 1 and 2.5 px per frame.
        e = 0.75
        gx = (psi(px + e, py, t) - psi(px - e, py, t)) / (2 * e)
        gy = (psi(px, py + e, t) - psi(px, py - e, t)) / (2 * e)
        ang = np.arctan2(-gx, gy)
        spd = 1.75 + 0.75 * field(px, py, zoom * 0.7, ox + 31.7, oy + 47.3)

        x0, y0 = px.copy(), py.copy()  # previous positions (stroke start)
        px += np.cos(ang) * spd
        py += np.sin(ang) * spd
        age += 1
        dead = (age >= life) | (px < 0) | (px > W) | (py < 0) | (py > H)
        alive = ~dead

        # Stroke opacity for this frame: sine envelope over the particle's life,
        # split across the samples along the segment.
        envelope = np.sin(math.pi * np.clip(age / life, 0, 1))
        base = (envelope * alpha / samples * 2.2).astype(np.float32)

        # Accumulate this frame's strokes, then blend them onto the ink once.
        acc = np.zeros(PH * PW, dtype=np.float32)
        for s in range(samples):
            f = (s + 0.5) / samples
            cx = (x0 + (px - x0) * f)[alive] * S
            cy = (y0 + (py - y0) * f)[alive] * S
            ba = base[alive]
            bx, by = np.floor(cx).astype(int), np.floor(cy).astype(int)
            for dx, dy in offs:
                ix, iy = bx + dx, by + dy
                cov = coverage(ix, iy, cx, cy, stroke)
                m = (cov > 0) & (ix >= 0) & (ix < PW) & (iy >= 0) & (iy < PH)
                if m.any():
                    # add.at sums correctly when several samples hit the same pixel
                    amount = (ba[m] * cov[m]).astype(np.float32)
                    np.add.at(acc, iy[m] * PW + ix[m], amount)
        np.clip(acc, 0, 1, out=acc)
        nz = acc > 0
        ink[nz] += (1 - ink[nz]) * acc[nz]

        # Respawn dead particles at random positions with a fresh lifetime.
        k = int(dead.sum())
        if k:
            px[dead], py[dead], life[dead] = spawn(k)
            age[dead] = 0

    # Map ink to colour, with a gamma curve to lift the faint strokes.
    v = ink.reshape(PH, PW)[..., None]
    final = bg + (fg - bg) * v**gamma
    return Image.fromarray((np.clip(final, 0, 1) * 255 + 0.5).astype(np.uint8)).convert(
        "RGBA"
    )


# --------------------------------------------------------------------------
# Text
# --------------------------------------------------------------------------


def draw_text_block(
    img, S, font_path, greeting, name, title, right, bottom, scrim=0.0, skew=0.25
):
    """Draw the greeting / name / title block, right-aligned in the bottom-right corner.

    The name is set in Fira Code Bold, cyan, with slightly tight
    letter-spacing; the greeting and title use the coral accent. The greeting
    is italic; Fira Code has no italic, so it is slanted with a shear, the
    same way a browser fakes one. Every line gets a soft drop shadow
    (equivalent to CSS text-shadow: 0 2px 20px rgba(0,0,0,0.45)).

    img           RGBA background image to draw on
    S             output scale; sizes and margins below are CSS pixels at 1x
    right/bottom  margins from the right and bottom edges
    scrim         0-1 strength of a soft halo in the background colour behind
                  the text, for busy backgrounds
    skew          italic slant (0.25 is about 14 degrees)
    Empty strings are skipped. Returns a new RGBA image.
    """
    W, H = img.size
    cyan, coral = hex_tuple(NAME_HEX), hex_tuple(ACCENT_HEX)

    # One entry per line, top to bottom:
    # (text, size px, weight, letter-spacing px, rgb, alpha, italic, gap below px)
    specs = [
        (greeting, 20, 500, 0.3, coral, 0.9, True, 8),
        (name, 44, 700, -0.01 * 44, cyan, 1.0, False, 12),
        (title, 20, 500, 0.3, coral, 1.0, False, 0),
    ]
    specs = [s for s in specs if s[0]]
    if not specs:
        return img

    # Lay the lines out from the bottom margin upward. Each line's visible
    # glyph box (descenders included) sits on y_bottom, and the next line up
    # starts above its top.
    right_x = W - right * S
    lines, y_bottom = [], H - bottom * S
    for i, (text, size, weight, ls, rgb, alpha, italic, gap) in enumerate(
        reversed(specs)
    ):
        font = load_font(font_path, size, weight, S)
        sp = ls * S
        adv = [font.getlength(ch) for ch in text]  # per-character advances
        width = sum(adv) + sp * (len(text) - 1)
        box = font.getbbox(text)  # visible glyph bounds
        if i:
            y_bottom -= gap * S
        y = y_bottom - box[3]  # draw origin (line box top)
        top, base = y + box[1], y + font.getmetrics()[0]  # visible top, baseline
        # Right-align; shift a slanted line left by half its lean so it looks aligned.
        x = right_x - width - (skew * (base - top) * 0.5 if italic else 0)
        lines.append(
            dict(
                text=text,
                font=font,
                adv=adv,
                sp=sp,
                x=x,
                y=y,
                base=base,
                rgba=rgb + (int(255 * alpha),),
                italic=italic,
            )
        )
        y_bottom = top

    def render(mono=None):
        """Draw all lines on a transparent layer, in their colours or one colour."""
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        for ln in lines:
            layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
            d, x = ImageDraw.Draw(layer), ln["x"]
            # Character by character, so the letter-spacing can be applied.
            for ch, w in zip(ln["text"], ln["adv"]):
                d.text((x, ln["y"]), ch, font=ln["font"], fill=mono or ln["rgba"])
                x += w + ln["sp"]
            if ln["italic"]:
                # Shear around the baseline so the letters lean right.
                layer = layer.transform(
                    img.size,
                    Image.Transform.AFFINE,
                    (1, skew, -skew * ln["base"], 0, 1, 0),
                    resample=Image.Resampling.BICUBIC,
                )
            out = Image.alpha_composite(out, layer)
        return out

    # Text shadow: black text, blurred (CSS 20px blur = sigma 10px), 45% opacity,
    # moved 2px down.
    shadow = render((0, 0, 0, 255)).filter(ImageFilter.GaussianBlur(10 * S))
    r, g, b, a = shadow.split()
    shadow = Image.merge("RGBA", (r, g, b, a.point(lambda v: int(v * 0.45))))
    shadow = shadow.transform(img.size, Image.Transform.AFFINE, (1, 0, 0, 0, 1, -2 * S))

    if scrim > 0:
        # Halo: blur the text shape, boost it so it fills in solidly around the
        # letters, blur again for a soft edge, then fill with the background colour.
        m = (
            render((255, 255, 255, 255))
            .split()[3]
            .filter(ImageFilter.GaussianBlur(20 * S))
        )
        m = m.point(lambda v: min(255, v * 8)).filter(ImageFilter.GaussianBlur(16 * S))
        halo = Image.new("RGBA", img.size, hex_tuple(BG_HEX) + (255,))
        halo.putalpha(m.point(lambda v: int(v * scrim)))
        img = Image.alpha_composite(img, halo)

    img = Image.alpha_composite(img, shadow)
    return Image.alpha_composite(img, render())


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------


def main():
    """Parse the command line, render the background and text, and save the PNG."""
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )

    # Background
    ap.add_argument("--style", choices=STYLES, default="bold", help="background preset")
    ap.add_argument(
        "--pattern",
        type=int,
        default=0,
        help="swirl layout; each number gives a different one (0-99999)",
    )
    ap.add_argument(
        "--seed",
        type=int,
        default=7,
        help="reshuffles the individual particles, same layout (0-99999)",
    )
    ap.add_argument(
        "--particles", type=int, help="number of particles, i.e. density (100-4000)"
    )
    ap.add_argument("--alpha", type=float, help="particle brightness (0.05-1)")
    ap.add_argument(
        "--fade",
        type=float,
        help="trail fade per frame, lower = longer trails (0.001-0.1)",
    )
    ap.add_argument("--frames", type=int, help="number of simulation steps (100-3000)")
    ap.add_argument(
        "--radius", type=float, help="dot radius in px, bold style only (0.5-3)"
    )
    ap.add_argument(
        "--current",
        type=float,
        help="streams only: steady drift strength, 0 = only eddies (0-2)",
    )
    ap.add_argument(
        "--zoom",
        type=float,
        help="streams only: noise frequency, higher = smaller swirls (0.001-0.01)",
    )

    # Text (optional: nothing is drawn unless at least one line is given)
    ap.add_argument("--greeting", help='line above the name, e.g. "Hello World! I am"')
    ap.add_argument("--name", help='your name, e.g. "Full Name"')
    ap.add_argument("--title", help='line below the name, e.g. "Job Title"')
    ap.add_argument(
        "--no-text", action="store_true", help="skip the text, even if given"
    )
    ap.add_argument("--scrim", type=float, help="dark halo behind the text (0-1)")
    ap.add_argument(
        "--right",
        type=float,
        default=72,
        help="text margin from the right edge, px at 1x (0-600)",
    )
    ap.add_argument(
        "--bottom",
        type=float,
        default=44,
        help="text margin from the bottom edge, px at 1x (0-300)",
    )
    ap.add_argument(
        "--font", default=DEFAULT_FONT, help="path to a Fira Code .ttf file"
    )

    # Output
    ap.add_argument(
        "--width", type=int, default=1584, help="cover width in px at 1x (200-4000)"
    )
    ap.add_argument(
        "--height", type=int, default=396, help="cover height in px at 1x (100-2000)"
    )
    ap.add_argument(
        "--scale", type=int, default=2, help="output scale, 2 = 3168x792 (1-3)"
    )
    ap.add_argument("--out", default="cover.png", help="output PNG path")
    args = ap.parse_args()

    # Start from the preset and apply any values given on the command line.
    params = dict(STYLES[args.style])
    overrides = (
        "particles",
        "alpha",
        "fade",
        "frames",
        "radius",
        "current",
        "zoom",
        "scrim",
    )
    for key in overrides:
        value = getattr(args, key)
        if value is None:
            continue
        if key in params:
            params[key] = value
        else:  # e.g. --radius with streams, or --current/--zoom with bold
            print(f"Note: --{key} does nothing in the {args.style} style; ignored.")
    mode = params.pop("mode")
    scrim = params.pop("scrim")

    print(
        f"Rendering {args.style} background "
        f"(pattern {args.pattern}, seed {args.seed})..."
    )
    render = render_streams if mode == "streams" else render_dots
    img = render(
        W=args.width,
        H=args.height,
        S=args.scale,
        seed=args.seed,
        pattern=args.pattern,
        **params,
    )

    # Text is only drawn when at least one line was given on the command line.
    has_text = any((args.greeting, args.name, args.title))
    if has_text and not args.no_text:
        img = draw_text_block(
            img,
            S=args.scale,
            font_path=ensure_font(args.font),
            greeting=args.greeting or "",
            name=args.name or "",
            title=args.title or "",
            right=args.right,
            bottom=args.bottom,
            scrim=scrim,
        )
    elif not has_text:
        print("No --greeting/--name/--title given, so saving the background only.")

    img.convert("RGB").save(args.out, optimize=True)
    print(f"Saved {args.out} ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
