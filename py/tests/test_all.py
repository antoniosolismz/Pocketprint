#!/usr/bin/env python3
"""Self-contained test suite (no pytest needed): python3 py/tests/test_all.py"""
from __future__ import annotations

import base64
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image  # noqa: E402

from funnyprint import protocol as P  # noqa: E402
from funnyprint import raster as R  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


# ---------------------------------------------------------------- CRC / auth


def test_crc_matches_app_variant() -> None:
    """The app accumulates without per-step masking; confirm it equals CRC-16/XMODEM."""
    def app_variant(data: bytes) -> int:
        def i32(x: int) -> int:
            x &= 0xFFFFFFFF
            return x - 2 ** 32 if x >= 2 ** 31 else x

        acc = 0
        for byte in data:
            for i in range(8):
                old = acc
                acc = i32(old << 1)
                if ((old >> 15) & 1) ^ ((byte >> (7 - i)) & 1):
                    acc = i32(acc ^ 0x1021)
        return acc & 0xFFFF

    rng = random.Random(7)
    same = 0
    for _ in range(2000):
        msg = bytes(rng.randrange(256) for _ in range(7))
        if app_variant(msg) == P.crc16_xmodem(msg):
            same += 1
    check("crc16_xmodem == app's int32 variant on 7-byte inputs", same == 2000, f"{same}/2000")
    check("crc16_xmodem known vector", P.crc16_xmodem(b"123456789") == 0x31C3,
          hex(P.crc16_xmodem(b"123456789")))
    check("crc16_xmodem empty input is 0", P.crc16_xmodem(b"") == 0)


def test_auth_derivation() -> None:
    challenge = bytes(range(1, 11))
    mac = "a1b2c3d4e5f6"
    low, high = P.derive_crcs(challenge, mac)
    check("lowCrc length 20 hex", len(low) == 20 and all(c in "0123456789ABCDEF" for c in low))
    check("highCrc length 20 hex", len(high) == 20 and all(c in "0123456789ABCDEF" for c in high))
    low2 = high2 = ""
    for b in challenge:
        h = f"{P.crc16_xmodem(bytes([b]) + bytes.fromhex(mac)):04X}"
        low2 += h[2:4]
        high2 += h[0:2]
    check("lowCrc = last two nibbles of each CRC", low == low2)
    check("highCrc = first two nibbles of each CRC", high == high2)
    check("highCrc is 10 bytes when hex-decoded", len(bytes.fromhex(high)) == 10)
    # the documented shortcut: an all-zero challenge repeats one CRC ten times
    low0, high0 = P.derive_crcs(bytes(10), "112233445566")
    check("all-zero challenge repeats a single CRC (documented property)",
          len(set(high0[i:i + 2] for i in range(0, 20, 2))) == 1, high0)
    expected = f"{P.crc16_xmodem(bytes([0]) + bytes.fromhex('112233445566')):04X}"[0:2]
    check("that repeated byte is the CRC high byte", high0[0:2] == expected, f"{high0[0:2]} vs {expected}")


def test_service_uuid() -> None:
    check("LX-D02 service UUID is 0xFFE6", P.SERVICE_UUID.startswith("0000ffe6"), P.SERVICE_UUID)
    check("write characteristic hint is ffe1", P.WRITE_CHAR_HINT == "ffe1")
    check("notify characteristic hint is ffe2", P.NOTIFY_CHAR_HINT == "ffe2")


# ------------------------------------------------------------------- frames


def test_frame_layouts() -> None:
    hello = P.hello_frame()
    check("hello is 12 bytes: 5A 01 + ten zeros", hello == bytes.fromhex("5a01" + "00" * 10), hello.hex())

    ch = P.challenge_frame(bytes(range(2, 12)))
    check("challenge is 12 bytes: 5A 0A + 10", ch[:2] == bytes([0x5A, 0x0A]) and ch[2:12] == bytes(range(2, 12)) and len(ch) == 12)

    ar = P.auth_reply_frame("AB" * 10)
    check("auth reply is 12 bytes: 5A 0B + 10", ar[:2] == bytes([0x5A, 0x0B]) and ar[2:12] == b"\xAB" * 10 and len(ar) == 12)

    d = P.density_frame(3)
    check("density is 3 bytes: 5A 0C <level>", d == bytes.fromhex("5a0c03") and len(d) == 3)

    ps = P.print_status_frame(0x0142, P.FLAG_START)
    check("print start is 6 bytes: 5A 04 <count:u16be> 00 00", ps == bytes.fromhex("5a0401420000") and len(ps) == 6)
    pe = P.print_status_frame(0x0142, P.FLAG_FINISH)
    check("print end is 6 bytes: 5A 04 <count:u16be> 01 00", pe == bytes.fromhex("5a0401420100") and len(pe) == 6)

    df = P.data_frame(1, b"\xff" * 96)
    check("raster frame is 100 bytes", len(df) == 100)
    check("raster header + big-endian INDEX (1, not the byte offset 96)",
          df[:3] == bytes([0x55, 0x00, 0x01]), df[:3].hex())
    check("raster payload occupies [3..98]", df[3:99] == b"\xff" * 96)
    check("raster trailer is 0x00", df[99] == 0x00)
    check("raster index is big-endian past one byte",
          P.data_frame(300, b"\x00" * 96)[1:3] == bytes([0x01, 0x2c]))


def test_rejects_bad_frames() -> None:
    for bad in (b"", b"\x01", b"\x00\x01\x02", bytes([0x55, 0, 0])):
        check(f"non-0x5A frame ignored ({bad!r})", P.parse_notification(bad) is None)
    for fn, args in ((P.data_frame, (0, b"short")), (P.challenge_frame, (b"short",)),
                     (P.density_frame, (9,)), (P.print_status_frame, (70000, 0))):
        try:
            fn(*args)
            check(f"{fn.__name__} rejects bad input", False)
        except ValueError:
            check(f"{fn.__name__} rejects bad input", True)


def test_notification_parsing() -> None:
    hello = bytes([0x5A, 0x01, 0, 0]) + bytes.fromhex("010203040506") + bytes(6)
    check("hello carries the MAC at [4..10]", P.parse_notification(hello).mac == "010203040506")

    status = bytes([0x5A, 0x02, 88, 1, 2, 0, 1, 3, 0x0e, 0x74])
    n = P.parse_notification(status)
    check("status: battery 88%", n.battery == 88)
    check("status: out of paper flagged", n.no_paper is True)
    check("status: 'charged' is a distinct state from 'charging'", n.charging is False)
    check("status: low battery flagged", n.low_battery is True)

    check("lost packet carries a 1-based index", P.parse_notification(bytes([0x5A, 0x05, 0x00, 0x03])).u16 == 3)
    check("finished carries the packet count", P.parse_notification(bytes([0x5A, 0x06, 0x00, 0x2A])).u16 == 0x2A)
    check("auth result 01 means ok", P.parse_notification(bytes([0x5A, 0x0B, 0x01])).auth_ok is True)
    check("auth result 00 means refused", P.parse_notification(bytes([0x5A, 0x0B, 0x00])).auth_ok is False)
    check("hold and cooldown are two-byte frames",
          P.parse_notification(bytes([0x5A, 0x08])).cmd == P.RESP_HOLD and
          P.parse_notification(bytes([0x5A, 0x07])).cmd == P.RESP_COOLDOWN)


# ------------------------------------------------------------------- raster


def test_raster_matches_java_semantics() -> None:
    img = Image.new("L", (8, 1))
    img.putdata([0, 255, 0, 255, 0, 255, 0, 255])
    check("MSB-first packing, 1 = black", R.rasterize(img, width=8, dither=False, threshold=128)[0] == b"\xAA")
    for name, pixels, expected in (("all white", [255] * 8, b"\x00"), ("all black", [0] * 8, b"\xFF")):
        im = Image.new("L", (8, 1)); im.putdata(pixels)
        check(f"{name} -> {expected.hex()}", R.rasterize(im, width=8, dither=False)[0] == expected)
    img2 = Image.new("L", (16, 1)); img2.putdata([0] * 8 + [255] * 8)
    check("byte order across the row", R.rasterize(img2, width=16, dither=False)[0] == b"\xFF\x00")


def test_raster_geometry() -> None:
    img = Image.new("L", (400, 300), 255)
    data, w, h = R.rasterize(img, width=384, dither=False)
    check("scales to the print head width", w == 384, str(w))
    check("row-major byte count = w/8 * h", len(data) == (w // 8) * h, f"{len(data)} vs {(w//8)*h}")
    check("two rows per raster packet", P.align_raster(data) and len(P.align_raster(data)) % 96 == 0)
    check("packet count is ceil(rows/2)", (len(P.align_raster(data)) // 96) == -(-h // 2),
          f"{len(P.align_raster(data))//96} vs {-(-h//2)}")
    aligned = P.align_raster(b"\x01" * 50)
    check("align_raster pads to a multiple of 96", len(aligned) == 96 and aligned[:50] == b"\x01" * 50)
    check("align_raster leaves exact multiples alone", P.align_raster(b"\x02" * 96) == b"\x02" * 96)
    check("blank_raster is whole rows of white", P.blank_raster(3) == bytes(3 * 48))


# -------------------------------------------------- end-to-end against a mock


def test_full_session_against_mock_printer() -> None:
    mac = "aabbccddeeff"
    state: dict = {}
    session = P.PrinterSession(rng=random.Random(3))

    out = session.begin()
    check("session opens with hello", out[0] == bytes.fromhex("5a01" + "00" * 10))

    out = session.on_notification(P.mock_printer_reply(out[0], mac, state)[0])
    check("host answers the hello with a challenge", out[0][:2] == bytes([0x5A, 0x0A]))
    check("host learned the MAC", session.mac == mac)

    out = session.on_notification(P.mock_printer_reply(out[0], mac, state)[0])
    check("host sends the auth reply despite the junk challenge payload",
          out[0][:2] == bytes([0x5A, 0x0B]) and session.last_auth_check is False)
    check("auth reply carries the CRC high bytes", out[0][2:12].hex().upper() == session.high_crc)

    session.on_notification(P.mock_printer_reply(out[0], mac, state)[0])
    check("printer accepted the auth reply", session.authenticated)

    raster = bytes([0xAA]) * 96 + bytes([0x55]) * 30
    out = session.start_job(raster, density=4)
    check("density goes out before the job opens",
          out[0] == bytes.fromhex("5a0c04") and out[1] == P.print_status_frame(2, 0), [f.hex() for f in out])
    check("totalPkg = ceil(len/96)", session.total_pkg == 2, str(session.total_pkg))

    for frame in out:
        for reply in P.mock_printer_reply(frame, mac, state):
            session.on_notification(reply)

    guard = 0
    while not session.finished and guard < 10:
        guard += 1
        frame = session.next_stream_frame()
        if frame is None:
            break
        for reply in P.mock_printer_reply(frame, mac, state):
            session.on_notification(reply)

    check("printer received both packets", sorted(state["received"]) == [0, 1], str(sorted(state["received"])))
    check("packet 0 payload preserved", state["received"][0] == bytes([0xAA]) * 96)
    check("packet 1 payload preserved and zero-padded",
          state["received"][1] == bytes([0x55]) * 30 + bytes(66))
    check("printer reported finished", session.finished)
    finish = session.finish_frames()
    check("host closes the job with the six-byte print end", finish == [P.print_status_frame(2, 1)])
    check("closing twice sends nothing the second time", session.finish_frames() == [])
    for frame in finish:
        for reply in P.mock_printer_reply(frame, mac, state):
            session.on_notification(reply)
    check("density reached the printer", state.get("density") == 4)
    check("mocked job marked as ended", state.get("print_ended") is True)


def test_flow_control() -> None:
    session = P.PrinterSession(rng=random.Random(9))
    session.authenticated = True
    session.start_job(bytes(96 * 4), density=0)

    first = session.next_stream_frame()
    check("stream starts at index 0", first[1:3] == bytes([0, 0]))
    check("index advances", session.next_stream_frame()[1:3] == bytes([0, 1]))

    session.on_notification(bytes([0x5A, P.RESP_HOLD]), now=0.0)
    check("hold stops the stream", session.next_stream_frame(0.0) is None)

    session.on_notification(bytes([0x5A, P.RESP_LOST_PACKET, 0, 1]), now=0.0)
    check("lost packet 1 rewinds to index 0 and clears the hold",
          session.cursor == 0 and session.hold is False)
    check("stream resumes at index 0", session.next_stream_frame(0.0)[1:3] == bytes([0, 0]))

    session.on_notification(bytes([0x5A, P.RESP_COOLDOWN]), now=0.0)
    check("cooldown pauses the stream", session.next_stream_frame(0.0) is None)
    check("cooldown does not rewind the index", session.cursor == 1)
    check("stream resumes after the cooldown window", session.next_stream_frame(0.2) is not None)

    session.on_notification(bytes([0x5A, P.RESP_FINISHED, 0x00, 0x04]), now=0.2)
    check("finished stops the stream", session.next_stream_frame(0.2) is None and session.finished)


def test_out_of_range_and_unknown() -> None:
    session = P.PrinterSession()
    session.authenticated = True
    session.start_job(bytes(96))
    first = session.next_stream_frame()
    check("a one-packet job streams exactly one frame", first is not None and first[1:3] == bytes([0, 0]))
    check("nothing to stream past the last packet", session.next_stream_frame() is None)
    check("an unknown command is ignored, not fatal",
          session.on_notification(bytes([0x5A, 0x7F])) == []
          and session.on_notification(bytes([0x5A, 0x40, 1, 2, 3])) == [])


def test_base64_write_encoding() -> None:
    """The stock app writes base64 of every frame; our own transports send raw bytes."""
    frame = P.print_status_frame(2, 0)
    payload = base64.b64encode(frame).decode()
    check("base64 round-trips a frame", base64.b64decode(payload) == frame)
    check("a six-byte frame is 8 base64 chars", len(payload) == 8, str(len(payload)))


def main() -> int:
    for fn in [
        test_crc_matches_app_variant,
        test_auth_derivation,
        test_service_uuid,
        test_frame_layouts,
        test_rejects_bad_frames,
        test_notification_parsing,
        test_raster_matches_java_semantics,
        test_raster_geometry,
        test_full_session_against_mock_printer,
        test_flow_control,
        test_out_of_range_and_unknown,
        test_base64_write_encoding,
    ]:
        print(f"\n== {fn.__name__} ==")
        fn()
    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + ", ".join(FAILURES))
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
