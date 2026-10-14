#!/usr/bin/env python3
"""Command line front end.

  funnyprint scan                        list nearby BLE devices
  funnyprint info --name LX              connect and report MAC/auth/status
  funnyprint text "hello" --name LX      print text
  funnyprint image photo.png --name LX   print an image
  funnyprint test --name LX              print the calibration sheet
  funnyprint feed --name LX              advance paper (prints blank rows)
  funnyprint dry-run --text "hello"      emit the exact frames, no Bluetooth needed
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # py/ so the package imports

from funnyprint import protocol as P  # noqa: E402
from funnyprint import raster as R  # noqa: E402


def build_raster(args) -> tuple[bytes, int, int]:
    from PIL import Image

    if getattr(args, "test", False):
        img = calibration_page(args.width)
    elif getattr(args, "text", None):
        img = R.text_to_image(args.text, width=args.width)
    else:
        img = Image.open(args.image)
    return R.rasterize(img, width=args.width, threshold=args.threshold, dither=not args.no_dither)


def calibration_page(width: int):
    """Frame, dot rule and grey ramp, so you can pick the right width for the model."""
    from PIL import Image, ImageDraw, ImageFont

    height = 300
    img = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(img)

    def font(size):
        try:
            return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", size)
        except OSError:
            return ImageFont.load_default()

    draw.text((6, 6), "POCKET PRINT — CALIBRATION", fill=0, font=font(16))
    draw.text((6, 26), f"{width} dots requested", fill=0, font=font(12))
    draw.rectangle((1, 44, width - 3, 84), outline=0, width=2)
    draw.text((6, 88), "frame = full width", fill=0, font=font(12))
    for x in range(0, width, 8):
        major = x % 64 == 0
        draw.rectangle((x, 106, x + (1 if major else 0), 106 + (14 if major else 7)), fill=0)
        if major:
            draw.text((x + 2, 122), str(x), fill=0, font=font(11))
    draw.text((6, 138), "rule: tick every 8 dots, label every 64", fill=0, font=font(12))
    y = 156
    for band in range(10):
        v = round(band * 255 / 9)
        draw.rectangle((6, y, width - 6, y + 8), fill=v)
        y += 10
    draw.text((6, y + 4), "grey ramp 0 -> 255", fill=0, font=font(12))
    draw.rectangle((6, y + 24, 6 + (width - 18) // 3, y + 54), fill=0)
    draw.rectangle((12 + (width - 18) // 3, y + 24, 12 + 2 * (width - 18) // 3, y + 54), outline=0, width=2)
    cx = width - 20 - (width - 18) // 6
    draw.ellipse((cx - 14, y + 26, cx + 14, y + 54), outline=0, width=2)
    return img


def dump_frames(raster: bytes, density: int, mac: str = "a1b2c3d4e5f6") -> list[str]:
    """Simulate a whole job and print every frame as hex. No Bluetooth involved."""
    session = P.PrinterSession()
    state: dict = {}
    out: list[str] = []

    def emit(direction: str, frame: bytes) -> None:
        out.append(f"{direction:12} {len(frame):>3}B  {frame.hex()}")

    def pump(frame: bytes) -> None:
        """Send one host frame and chase every device reply it provokes."""
        queue = [frame]
        guard = 0
        while queue and guard < 200:
            guard += 1
            host_frame = queue.pop(0)
            emit("host →", host_frame)
            for reply in P.mock_printer_reply(host_frame, mac, state):
                emit("device →", reply)
                queue.extend(session.on_notification(reply, now=0.0))

    for frame in session.begin():
        pump(frame)
    for frame in session.start_job(raster, density=density):
        pump(frame)

    guard = 0
    while not session.finished and guard < 5000:
        guard += 1
        frame = session.next_stream_frame(now=0.0)
        if frame is None:
            break
        pump(frame)

    for frame in session.finish_frames():
        pump(frame)

    for line in session.log:
        out.append(f"{'# log':12} {line}")
    return out


def cmd_scan(args) -> int:
    from funnyprint.client import scan
    devices = asyncio.run(scan(args.timeout))
    if not devices:
        print("no devices found")
        return 1
    for d in devices:
        mark = "printer?" if d["known"] else "        "
        print(f"{mark} {d['address']:<20} {d['rssi']:>5} dBm  {d['name']}")
    return 0


def cmd_info(args) -> int:
    async def run():
        from funnyprint.client import BleakTransport
        transport = BleakTransport(args.device, args.name, log=print)
        session = P.PrinterSession()

        async def handle(data: bytes):
            for frame in session.on_notification(data, now=asyncio.get_event_loop().time()):
                await transport.write(frame)

        transport.onData = lambda data: asyncio.create_task(handle(data))
        async with transport:
            for frame in session.begin():
                await transport.write(frame)
            for _ in range(60):
                if session.authenticated and session.status:
                    break
                await asyncio.sleep(0.1)
            print(f"MAC: {session.mac}")
            print(f"authenticated: {session.authenticated}")
            print(f"status: {session.status}")
            for line in session.log:
                print("  " + line)
    asyncio.run(run())
    return 0


def cmd_print(args) -> int:
    if getattr(args, "dry_run", False):
        if getattr(args, "test", False):
            raster, w, h = build_raster(args)
        elif getattr(args, "text", None):
            from PIL import Image
            raster, w, h = build_raster(args)
        else:
            raster, w, h = build_raster(args)
        packets = len(P.align_raster(raster)) // P.DATA_PAYLOAD_LEN
        print(f"raster {w}×{h} dots, {len(raster)} bytes, {packets} packet(s), density {args.density}")
        for line in dump_frames(raster, args.density):
            print(line)
        return 0

    if getattr(args, "test", False) or getattr(args, "text", None):
        raster, w, h = build_raster(args)
    else:
        raster, w, h = build_raster(args)
    packets = len(P.align_raster(raster)) // P.DATA_PAYLOAD_LEN
    print(f"raster {w}×{h} dots, {len(raster)} bytes, {packets} packet(s), density {args.density}")

    async def run():
        from funnyprint.client import BleakTransport, run_job
        transport = BleakTransport(args.device, args.name, log=print)
        session = P.PrinterSession()
        async with transport:
            ok = False
            for copy_index in range(args.copies):
                if args.copies > 1:
                    print(f"copy {copy_index + 1}/{args.copies}")
                ok = await run_job(transport, session, raster, density=args.density)
                if not ok:
                    return 1
                await asyncio.sleep(0.3)
            print("done" if ok else "the printer never confirmed the job")
            return 0 if ok else 1
    return asyncio.run(run())


def cmd_feed(args) -> int:
    async def run():
        from funnyprint.client import BleakTransport, run_job
        transport = BleakTransport(args.device, args.name, log=print)
        session = P.PrinterSession()
        raster = P.blank_raster(args.rows)
        async with transport:
            ok = await run_job(transport, session, raster, density=0)
            return 0 if ok else 1
    return asyncio.run(run())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="funnyprint", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--device", help="BLE address (MAC/UUID)")
    common.add_argument("--name", help="match a device by name prefix")
    common.add_argument("--width", type=int, default=384, help="print width in dots")
    common.add_argument("--threshold", type=int, default=128, help="dither threshold, lower = darker")
    common.add_argument("--density", type=int, default=3, choices=range(1, 8), help="print head density 1-7")
    common.add_argument("--no-dither", action="store_true")
    common.add_argument("--copies", type=int, default=1)

    p_scan = sub.add_parser("scan", help="list BLE devices")
    p_scan.add_argument("--timeout", type=float, default=8.0)
    p_scan.set_defaults(func=cmd_scan)

    p_info = sub.add_parser("info", help="connect and report MAC/status", parents=[common])
    p_info.set_defaults(func=cmd_info)

    p_text = sub.add_parser("text", help="print text", parents=[common])
    p_text.add_argument("text")
    p_text.add_argument("--dry-run", action="store_true")
    p_text.set_defaults(func=cmd_print)

    p_img = sub.add_parser("image", help="print an image", parents=[common])
    p_img.add_argument("image")
    p_img.add_argument("--dry-run", action="store_true")
    p_img.set_defaults(func=cmd_print)

    p_test = sub.add_parser("test", help="print the calibration sheet", parents=[common])
    p_test.add_argument("--dry-run", action="store_true")
    p_test.set_defaults(func=cmd_print, text=None, image=None, test=True)

    p_feed = sub.add_parser("feed", help="advance paper", parents=[common])
    p_feed.add_argument("--rows", type=int, default=6)
    p_feed.set_defaults(func=cmd_feed)

    p_dry = sub.add_parser("dry-run", help="simulate a text job and dump every frame", parents=[common])
    p_dry.add_argument("--text", default="Pocket Print check")
    p_dry.set_defaults(func=cmd_print, image=None, test=False, dry_run=True)

    args = parser.parse_args(argv)
    for attr, default in (("test", False), ("image", None), ("text", None), ("dry_run", False)):
        if not hasattr(args, attr):
            setattr(args, attr, default)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
