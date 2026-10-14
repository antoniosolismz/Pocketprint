#!/usr/bin/env python3
"""Check that generated files still match their generators.

    python3 tools/check-generated.py

Two vendored artefacts are built by scripts rather than written by hand: the Code 128 symbol
table and the app icons. If a generator and its committed output ever disagree, one of them was
edited by hand and the repository is no longer reproducible — which, in a project whose whole
point is "here is how I verified it", is worth failing a build over. CI runs this on every push.

The two are compared differently, on purpose:

  * the Code 128 table is plain text, so it is compared byte for byte;
  * the icons are PNGs, and PNG *bytes* legitimately differ between Pillow and zlib versions.
    Comparing them byte-wise would fail on a dependency bump for no real reason, so the icons
    are compared by decoded pixels. A change in the drawing code moves pixels and still fails;
    a change in the encoder does not.
"""
from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = ROOT / "web" / "vendor" / "code128-table.js"
ICONS = ROOT / "web" / "icons"
GENERATORS = [
    ("the Code 128 table", ROOT / "tools" / "make-code128-table.py"),
    ("the app icons", ROOT / "tools" / "make-icons.py"),
]


def pixels(path: Path) -> tuple[int, int, str]:
    """A hash of the decoded pixels, plus the dimensions, so encoders can differ freely."""
    from PIL import Image

    with Image.open(path) as img:
        rgb = img.convert("RGB")
        digest = hashlib.sha256(rgb.tobytes()).hexdigest()[:16]
        return rgb.width, rgb.height, digest


def main() -> int:
    if not TABLE.exists() or not ICONS.is_dir():
        print("expected generated files are missing; nothing to check", file=sys.stderr)
        return 2

    table_before = TABLE.read_bytes()
    icons_before = {p.name: pixels(p) for p in sorted(ICONS.glob("*.png"))}

    for label, script in GENERATORS:
        proc = subprocess.run([sys.executable, str(script)], capture_output=True, text=True)
        if proc.returncode != 0:
            print(f"FAIL  {label}: its generator failed", file=sys.stderr)
            print(proc.stdout + proc.stderr, file=sys.stderr)
            return 1

    failures = 0

    if TABLE.read_bytes() != table_before:
        print("FAIL  the Code 128 table differs from what its generator produces")
        print("      re-run tools/make-code128-table.py and commit the result")
        failures += 1
    else:
        print("  ok  Code 128 table matches its generator")

    icons_after = {p.name: pixels(p) for p in sorted(ICONS.glob("*.png"))}
    if icons_after != icons_before:
        print("FAIL  the icons differ from what their generator produces")
        for name in sorted(set(icons_before) | set(icons_after)):
            if icons_before.get(name) != icons_after.get(name):
                print(f"      {name}: {icons_before.get(name)} -> {icons_after.get(name)}")
        print("      re-run tools/make-icons.py and commit the result")
        failures += 1
    else:
        print(f"  ok  {len(icons_after)} icons match their generator (compared as pixels, "
              "since PNG bytes vary by Pillow version)")

    if failures:
        print("\ngenerated files are out of sync with their generators", file=sys.stderr)
        return 1
    print("\ngenerated files are reproducible from their generators")
    return 0


if __name__ == "__main__":
    sys.exit(main())
