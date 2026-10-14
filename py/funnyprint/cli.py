#!/usr/bin/env python3
"""Command line front end.

  funnyprint scan                         list nearby BLE devices
  funnyprint info --device ADDR           connect and show what the printer reports
  funnyprint text "hello" --device ADDR   print text
  funnyprint image photo.png --device ADDR
  funnyprint test --device ADDR           print the calibration sheet
  funnyprint dry-run --text "hello"       emit the exact frames, no Bluetooth needed
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

    if args.test:
        img = calibration_page(args.width)
    elif args.text:
        img = R.text_to_image(args.text, width=args.width)
    else:
        img = Image.open(args.image)
    return R.rasterize(
        img,
        width=args.width,
        threshold=args.threshold,
        dither=not args.no_dither,
    )


def calibration_page(width: int):
    """Same idea as the web app's test page: frame, dot rule, grey ramp."""
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


def dump_frames(raster: bytes, copies: int, mac: str = "a1b2c3d4e5f6") -> list[str]:
    """Simulate a full authenticated session and print every frame as hex."""
    session = P.PrinterSession()
    state: dict = {"device_type": 6}
    out: list[str] = []

    def emit(direction: str, frame: bytes) -> None:
        out.append(f"{direction:14} {frame.hex()}")

    for _copy in range(copies):
        to_send = list(session.begin())
        started = False
        for _ in range(4000):
            if not to_send:
                if session.authenticated and not started:
                    started = True
                    to_send = list(session.start_print(raster, 1))
                    continue
                break
            frame = to_send.pop(0)
            emit("host →", frame)
            for reply in P.mock_printer_reply(frame, mac, state):
                emit("device →", reply)
                to_send.extend(session.on_notification(reply))
    for line in session.log:
        out.append(f"{'# log':14} {line}")
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
        transport.onData = lambda data: [asyncio.create_task(transport.write(f))
                                         for f in session.on_notification(data)]
        async with transport:
            for frame in session.begin():
                await transport.write(frame)
            for _ in range(60):
                if session.authenticated:
                    break
                await asyncio.sleep(0.1)
            print(f"MAC: {session.mac}")
            print(f"device type: {session.device_type}")
            print(f"authenticated: {session.authenticated}")
            for line in session.log:
                print(f"  {line}")
    asyncio.run(run())
    return 0


def cmd_print(args) -> int:
    raster, w, h = build_raster(args)
    packets = (len(raster) + P.DATA_PAYLOAD_LEN - 1) // P.DATA_PAYLOAD_LEN
    print(f"raster {w}×{h} dots, {len(raster)} bytes, {packets} packet(s), "
          f"threshold {args.threshold}{'' if not args.no_dither else ', no dithering'}")
    if args.dry_run:
        for line in dump_frames(raster, args.copies):
            print(line)
        return 0

    async def run():
        from funnyprint.client import BleakTransport
        transport = BleakTransport(args.device, args.name, log=print)
        session = P.PrinterSession()
        done = asyncio.Event()

        async def handle(data: bytes) -> None:
            for frame in session.on_notification(data):
                await transport.write(frame)

        transport.onData = lambda data: asyncio.create_task(handle(data))
        async with transport:
            for frame in session.begin():
                await transport.write(frame)
            for _ in range(80):
                if session.authenticated or done.is_set():
                    break
                await asyncio.sleep(0.1)
            if not session.authenticated:
                print("printer refused the handshake; nothing sent")
                return 1
            for copy_index in range(args.copies):
                if args.copies > 1:
                    print(f"copy {copy_index + 1}/{args.copies}")
                print(f"job: {packets} packet(s)")
                for frame in session.start_print(raster, 1):
                    await transport.write(frame)
                for _ in range(300):
                    if session.job_done:
                        break
                    await asyncio.sleep(0.1)
                if not session.job_done:
                    print("warning: no confirmation from the device")
            print("done")
        return 0

    return asyncio.run(run())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="funnyprint", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--device", help="BLE address (MAC/UUID)")
    common.add_argument("--name", help="match a device by name prefix")
    common.add_argument("--width", type=int, default=384, help="print width in dots")
    common.add_argument("--threshold", type=int, default=128)
    common.add_argument("--no-dither", action="store_true")
    common.add_argument("--copies", type=int, default=1)

    p_scan = sub.add_parser("scan", help="list BLE devices")
    p_scan.add_argument("--timeout", type=float, default=8.0)
    p_scan.set_defaults(func=cmd_scan)

    p_info = sub.add_parser("info", help="connect and report MAC/type/auth", parents=[common])
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

    args = parser.parse_args(argv)
    if not hasattr(args, "test"):
        args.test = False
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
