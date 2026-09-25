"""Draw Cloak's icon, with no image library involved.

The window borrows its icon from the interpreter otherwise, so the app shows up
in the taskbar as pythonw.exe — which is what makes it look like a console
window someone left open. This writes the .ico that fixes that, plus the .svg
the browser tab uses, from one description of the mark.

The mark is a fingerprint: concentric arcs around a dot, which is the thing the
proxy is actually about.

    python tools/make_icon.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICO = ROOT / "src" / "cloakproxy" / "web" / "static" / "cloak.ico"
SVG = ROOT / "src" / "cloakproxy" / "web" / "static" / "cloak.svg"

BG = (0x16, 0x1A, 0x26)          # the app's own surface colour
INK = (0x6F, 0xB0, 0xFF)         # and its accent
SIZES = (16, 20, 24, 32, 48, 64, 128, 256)

# The mark, in a 0..1 box: a hood seen head-on, with the face in shadow. It's
# the one shape that belongs to this tool rather than to every other network
# utility, where arcs and shields are common currency.
#
# Two things make it read as a hood and not a ring: the crown is pointed (a
# smaller exponent on the top half draws a cowl, a larger one on the bottom
# flares it into shoulders), and the face opening runs past the hem, so the
# silhouette is an arch, open at the bottom.
#
# Small sizes get a heavier cut of the same drawing — at 16px a thin hood turns
# to mush, so the shadow narrows and the cloth thickens.
LARGE = {"outer": (0.310, 0.415), "inner": (0.170, 0.272), "flare": 0.30,
         "crown": 1.45, "shoulder": 2.6, "drop": 0.152, "hem": 0.880}
SMALL = {"outer": (0.330, 0.435), "inner": (0.150, 0.248), "flare": 0.32,
         "crown": 1.55, "shoulder": 2.8, "drop": 0.168, "hem": 0.910}
RADIUS = 0.235                   # corner rounding of the tile


def cut(size: int) -> dict:
    return SMALL if size <= 24 else LARGE


def _cowl(dx: float, dy: float, a: float, b: float, crown: float,
          shoulder: float) -> float:
    """<= 1 inside. Pointed above the waist, flared below it."""
    n = crown if dy < 0 else shoulder
    return (abs(dx / a) ** n) + (abs(dy / b) ** n)


def _inside_tile(x: float, y: float) -> bool:
    """Is this point inside the rounded square?"""
    dx, dy = abs(x - .5), abs(y - .5)
    flat = .5 - RADIUS
    if dx <= flat or dy <= flat:
        return dx <= .5 and dy <= .5
    return math.hypot(dx - flat, dy - flat) <= RADIUS


def _spread(y: float, shape: dict) -> float:
    """How far the cloth has fallen open at this height."""
    if y <= .50:
        return 1.0
    return 1.0 + shape["flare"] * ((y - .50) / (shape["hem"] - .50)) ** 1.6


def _on_mark(x: float, y: float, shape: dict) -> bool:
    """Is this point on the cloth of the hood?"""
    if y > shape["hem"]:
        return False
    ax, ay = shape["outer"]
    if _cowl(x - .5, y - .50, ax * _spread(y, shape), ay,
             shape["crown"], shape["shoulder"]) > 1:
        return False
    bx, by = shape["inner"]                     # the face, in shadow
    return _cowl(x - .5, y - (.50 + shape["drop"]), bx, by, 2.0, 2.6) > 1


def render(size: int, samples: int = 4) -> bytes:
    """Rasterise to RGBA, supersampled so the curves don't look chewed."""
    rows = bytearray()
    shape = cut(size)
    step = 1.0 / (size * samples)
    for py in range(size):
        rows.append(0)                             # PNG filter: none
        for px in range(size):
            hits = ink = 0
            for sy in range(samples):
                for sx in range(samples):
                    x = (px * samples + sx + .5) * step
                    y = (py * samples + sy + .5) * step
                    if not _inside_tile(x, y):
                        continue
                    hits += 1
                    if _on_mark(x, y, shape):
                        ink += 1
            total = samples * samples
            if not hits:
                rows.extend((0, 0, 0, 0))
                continue
            cover = ink / hits
            colour = tuple(round(BG[i] + (INK[i] - BG[i]) * cover) for i in range(3))
            rows.extend((*colour, round(255 * hits / total)))
    return bytes(rows)


def png(size: int) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)   # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(render(size), 9))
            + chunk(b"IEND", b""))


def ico(sizes=SIZES) -> bytes:
    """An ICO holding PNGs, which every Windows since Vista reads."""
    images = [png(s) for s in sizes]
    offset = 6 + 16 * len(images)
    out = [struct.pack("<3H", 0, 1, len(images))]
    for size, data in zip(sizes, images):
        out.append(struct.pack("<4B2H2I", size if size < 256 else 0,
                               size if size < 256 else 0, 0, 0, 1, 32,
                               len(data), offset))
        offset += len(data)
    return b"".join(out + images)


def svg() -> str:
    """The same mark for the browser tab, traced rather than sampled."""
    sh = LARGE

    def trace(a, b, cy, crown, shoulder, flare=False):
        pts = []
        for i in range(129):
            t = math.tau * i / 128
            ct, st = math.cos(t), math.sin(t)
            n = crown if st < 0 else shoulder
            y = cy + b * math.copysign(abs(st) ** (2 / n), st)
            aa = a * (_spread(y, sh) if flare else 1.0)
            x = .5 + aa * math.copysign(abs(ct) ** (2 / n), ct)
            pts.append((x * 64, min(y * 64, sh["hem"] * 64)))
        return " ".join(f"{x:.2f},{y:.2f}" for x, y in pts)

    outer = trace(*sh["outer"], .50, sh["crown"], sh["shoulder"], flare=True)
    inner = trace(*sh["inner"], .50 + sh["drop"], 2.0, 2.6)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
            f'<rect width="64" height="64" rx="{RADIUS * 64:.1f}" fill="#161a26"/>'
            f'<path fill="#6fb0ff" fill-rule="evenodd" '
            f'd="M{outer} Z M{inner} Z"/></svg>')


if __name__ == "__main__":
    ICO.write_bytes(ico())
    SVG.write_text(svg(), encoding="utf-8")
    print(f"{ICO.relative_to(ROOT)}  {ICO.stat().st_size:,} bytes  {len(SIZES)} sizes")
    print(f"{SVG.relative_to(ROOT)}  {SVG.stat().st_size:,} bytes")
