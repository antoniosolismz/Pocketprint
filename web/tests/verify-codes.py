#!/usr/bin/env python3
"""Decode-and-compare verification for web/codes.js.

    python3 web/tests/verify-codes.py

This is the honest test of the barcode/QR layer: it takes the bitmaps the app would send
to the printer, decodes them with an INDEPENDENT decoder (OpenCV for QR, python-barcode for
Code 128) and fails if anything does not read back exactly.

Why it exists as a separate step: cv2 and python-barcode are Python, the app is JavaScript.
Keeping them apart means neither side can "agree" with itself.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def main() -> int:
    import cv2
    import numpy as np
    from barcode import Code128

    tmp = Path(tempfile.mkdtemp(prefix="pocketprint-verify-"))
    try:
        proc = subprocess.run(
            ["node", str(HERE / "emit-bitmaps.mjs"), str(tmp)],
            capture_output=True, text=True)
        if proc.returncode != 0:
            print("emitter failed:\n" + proc.stdout + proc.stderr)
            return 2
        print(f"  {proc.stdout.strip()}")

        print("\n== QR decode round-trip (OpenCV, independent decoder) ==")
        manifest = json.loads((tmp / "manifest.json").read_text())
        detector = cv2.QRCodeDetector()
        for entry in manifest:
            img = cv2.imread(str(tmp / entry["file"]), cv2.IMREAD_GRAYSCALE)
            if img is None:
                check(f"{entry['file']} readable", False, "cv2 could not open it")
                continue
            # a real printer's dots are square and 1:1; give the decoder the same courtesy
            scale = 1 if entry["w"] > 200 else 3
            if scale > 1:
                img = np.kron(img, np.ones((scale, scale), dtype=np.uint8))
            data, _, _ = detector.detectAndDecode(img)
            label = entry["file"] + (" (composed label)" if entry.get("composed") else "")
            check(f"{label} decodes", data == entry["payload"],
                  f"decoded {data[:48]!r} expected {entry['payload'][:48]!r}")

        print("\n== Code 128 vs python-barcode, live ==")
        emitted = json.loads((tmp / "code128.json").read_text())
        for payload, bits in emitted.items():
            expected = Code128(payload).build()[0]
            check(f"{payload!r} matches python-barcode", bits == expected,
                  f"{len(bits)} vs {len(expected)} modules")

        print("\n== the codes still read after being laid out for print ==")
        # A composed label is what the app actually prints; make sure the QR in it is not
        # damaged by the barcode below it or by the centring offset.
        for entry in manifest:
            if not entry.get("composed"):
                continue
            img = cv2.imread(str(tmp / entry["file"]), cv2.IMREAD_GRAYSCALE)
            data, _, _ = detector.detectAndDecode(img)
            check(f"QR survives composition in {entry['file']}", data == entry["payload"],
                  f"decoded {data[:40]!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures:
        print(f"FAILED: {len(failures)} -> {failures}")
        return 1
    print("code verification passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
