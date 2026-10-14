#!/usr/bin/env python3
"""Emit protocol/raster test vectors from the Python reference implementation.

web/tests/conformance.mjs asserts the JavaScript core against this file, so both
implementations stay pinned to the same bytes.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from funnyprint import protocol as P  # noqa: E402
from funnyprint import raster as R  # noqa: E402


def main() -> int:
    out: dict = {"crc": [], "auth": [], "frames": [], "raster": []}

    rng = random.Random(20261014)
    for n in (1, 7, 9):
        data = bytes(rng.randrange(256) for _ in range(n))
        out["crc"].append({"data": data.hex(), "crc": P.crc16_xmodem(data)})

    for _ in range(6):
        challenge = bytes(rng.randint(1, 254) for _ in range(10))
        mac = "%012x" % rng.randrange(1 << 48)
        low, high = P.derive_crcs(challenge, mac)
        out["auth"].append({"challenge": challenge.hex(), "mac": mac, "low": low, "high": high})

    out["frames"] = [
        {"name": "hello", "hex": P.hello_frame().hex()},
        {"name": "challenge", "hex": P.challenge_frame(bytes(range(2, 12))).hex()},
        {"name": "auth_reply", "hex": P.auth_reply_frame("AB" * 10).hex()},
        {"name": "density", "hex": P.density_frame(3).hex()},
        {"name": "print_start", "hex": P.print_status_frame(0x1234, P.FLAG_START).hex()},
        {"name": "print_end", "hex": P.print_status_frame(3, P.FLAG_FINISH).hex()},
        {"name": "raster", "hex": P.data_frame(1, bytes([0xFF]) * 96).hex()},
    ]

    cases = [
        ("alternating", 8, 1, [0, 255, 0, 255, 0, 255, 0, 255], 128, False),
        ("all_white", 8, 1, [255] * 8, 128, False),
        ("all_black", 8, 1, [0] * 8, 128, False),
        ("two_bytes", 16, 1, [0] * 8 + [255] * 8, 128, False),
        ("gradient", 16, 2, list(range(0, 256, 8)), 128, False),
        ("flat_gray_disabled", 8, 1, [127] * 8, 128, False),
        ("flat_gray_enabled", 8, 1, [127] * 8, 128, True),
        ("checker", 16, 2, [0 if (i + (i // 16)) % 2 == 0 else 255 for i in range(32)], 128, True),
    ]
    for name, w, h, pixels, threshold, dither in cases:
        img = Image.new("L", (w, h))
        img.putdata(pixels)
        if dither:
            packed = R.pack_bits(R.floyd_steinberg(img, threshold))
        else:
            packed = R.pack_bits([p < threshold for p in pixels])
        out["raster"].append({
            "name": name, "width": w, "height": h, "pixels": pixels,
            "threshold": threshold, "dither": dither, "packed": packed.hex(),
        })

    path = Path(__file__).resolve().parent / "vectors.json"
    path.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {path} ({len(out['crc'])} crc, {len(out['auth'])} auth, "
          f"{len(out['frames'])} frames, {len(out['raster'])} raster vectors)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
