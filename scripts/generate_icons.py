#!/usr/bin/env python3
"""Generate PWA icons (192 & 512) as a saffron diya-glow circle.
Pure stdlib (zlib + struct) — no dependencies required.
Run:  python3 scripts/generate_icons.py
"""
import os, struct, zlib, math

OUT = os.path.join(os.path.dirname(__file__), "..", "app", "icons")
os.makedirs(OUT, exist_ok=True)

ACCENT = (255, 107, 0)   # Saffron
BG     = (253, 251, 247) # Sattvic Creme


def make_png(size):
    cx = cy = (size - 1) / 2
    R = size / 2
    rows = []
    for y in range(size):
        row = bytearray([0])  # filter: none
        for x in range(size):
            dx, dy = x - cx, y - cy
            r = math.hypot(dx, dy)
            if r <= R * 0.98:
                # radial glow: bright center -> softer edge (clamp)
                t = r / R
                a = ACCENT[0] + (255 - ACCENT[0]) * t
                b = ACCENT[1] + (200 - ACCENT[1]) * t
                c = ACCENT[2] * (1 - 0.4 * t)
                # Om "dot" hint near center
                if r < R * 0.16:
                    a, b, c = 255, 220, 120
                row += bytes((int(a), int(b), int(c), 255))
            else:
                row += bytes(BG + (255,))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    return png


for size in (192, 512):
    path = os.path.join(OUT, f"icon-{size}.png")
    with open(path, "wb") as f:
        f.write(make_png(size))
    print("wrote", path, os.path.getsize(path), "bytes")