#!/usr/bin/env python3
"""Emit protocol/raster test vectors from the Python reference implementation.

The JavaScript core (web/funnyprint.js) is then asserted against this file by
web/tests/conformance.mjs, so both implementations are pinned to the same bytes.
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

    rng = random.Random(20261013)
    for n in (1, 7, 9):
        data = bytes(rng.randrange(256) for _ in range(n))
        out["crc"].append({"data": data.hex(), "crc": P.crc16_xmodem(data)})

    for _ in range(6):
        challenge = bytes(rng.randint(1, 254) for _ in range(10))
        mac = "%012x" % rng.randrange(1 << 48)
        low, high = P.derive_crcs(challenge, mac)
        out["auth"].append({"challenge": challenge.hex(), "mac": mac, "low": low, "high": high})

    out["frames"] = [
        {"name": "hardware_info", "hex": P.hardware_info_frame().hex()},
        {"name": "handshake", "hex": P.handshake_frame(bytes(range(2, 12))).hex()},
        {"name": "app_check", "hex": P.app_check_frame("AB" * 10).hex()},
        {"name": "move_paper", "hex": P.move_paper_frame().hex()},
        {"name": "print_status_start", "hex": P.print_status_frame(0x1234, 0, 2).hex()},
        {"name": "print_status_finish", "hex": P.print_status_frame(3, 1, 1).hex()},
        {"name": "data_frame", "hex": P.data_frame(0x0180, bytes([0xFF]) * 96).hex()},
    ]

    # raster vectors: raw luminance -> packed bits
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
            bits = R.floyd_steinberg(img, threshold)
            packed = R.pack_bits(bits)
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
