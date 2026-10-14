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
    mismatches = 0
    for _ in range(5000):
        msg = bytes(rng.randrange(256) for _ in range(7))
        mismatches += app_variant(msg) != P.crc16_xmodem(msg)
    check("crc16_xmodem == app's int32 variant on 7-byte inputs", mismatches == 0,
          f"{mismatches} mismatches")
    check("crc16_xmodem known vector", P.crc16_xmodem(b"123456789") == 0x31C3,
          hex(P.crc16_xmodem(b"123456789")))


def test_auth_derivation() -> None:
    challenge = bytes(range(1, 11))
    mac = "a1b2c3d4e5f6"
    low, high = P.derive_crcs(challenge, mac)
    check("lowCrc length 20 hex", len(low) == 20 and all(c in "0123456789ABCDEF" for c in low))
    check("highCrc length 20 hex", len(high) == 20 and all(c in "0123456789ABCDEF" for c in high))
    # recompute independently, in the exact shape the app builds it
    low2 = high2 = ""
    for b in challenge:
        h = f"{P.crc16_xmodem(bytes([b]) + bytes.fromhex(mac)):04X}"
        low2 += h[2:4]
        high2 += h[0:2]
    check("lowCrc = last two nibbles of each CRC", low == low2)
    check("highCrc = first two nibbles of each CRC", high == high2)
    check("highCrc is 10 bytes when hex-decoded", len(bytes.fromhex(high)) == 10)


# ------------------------------------------------------------------- frames


def test_frame_layouts() -> None:
    hs = P.handshake_frame(bytes(range(2, 12)))
    check("handshake frame length 12", len(hs) == 12)
    check("handshake magic/cmd", hs[0] == 0x5A and hs[1] == 0x0A)
    check("handshake carries 10 challenge bytes", hs[2:12] == bytes(range(2, 12)))

    ps = P.print_status_frame(0x1234, 0, 2)
    check("0x04 frame: 5A 04 <u16 totalPkg> <flag> <copies>",
          ps[:6] == bytes([0x5A, 0x04, 0x12, 0x34, 0x00, 0x02]) and len(ps) == 12,
          ps.hex())

    ac = P.app_check_frame("AA" * 10)
    check("0x0B app check frame carries 10 bytes at offset 2",
          ac[:2] == bytes([0x5A, 0x0B]) and ac[2:12] == b"\xAA" * 10)

    df = P.data_frame(0x0180, b"\xff" * 96)
    check("0x55 data frame is 100 bytes", len(df) == 100)
    check("0x55 header + big-endian offset", df[:3] == bytes([0x55, 0x01, 0x80]), df[:3].hex())
    check("0x55 trailer is 0x00", df[99] == 0x00)
    check("0x55 payload occupies [3..98]", df[3:99] == b"\xff" * 96)

    check("move paper frame", P.move_paper_frame()[:6] == bytes([0x5A, 0x03, 0x82, 0x00, 0x03, 0x00]))
    check("hardware info frame", P.hardware_info_frame()[:2] == bytes([0x5A, 0x01]))


def test_rejects_bad_frames() -> None:
    for bad in (b"", b"\x01", b"\x00\x01\x02", base64.b64decode("AQID")):
        check(f"non-0x5A frame ignored ({bad!r})", P.parse_notification(bad) is None)
    try:
        P.data_frame(0, b"short")
        check("data_frame rejects wrong payload size", False)
    except ValueError:
        check("data_frame rejects wrong payload size", True)


def test_notification_parsing() -> None:
    hw = bytes([0x5A, 0x01, 0, 0]) + bytes.fromhex("010203040506") + bytes([9])
    n = P.parse_notification(hw)
    check("0x01 MAC parsed from [4..9]", n.mac == "010203040506", n.mac)
    check("0x01 device type parsed from [10]", n.device_type == 9, str(n.device_type))

    req = bytes([0x5A, 0x05, 0x00, 0x03])
    check("0x05 request is 1-based u16 BE", P.parse_notification(req).packet_index == 3)

    end = bytes([0x5A, 0x06, 0x00, 0x2A, 0x01])
    check("0x06 print end carries totalPkg + count", P.parse_notification(end).print_end == (0x2A, 1))


# ------------------------------------------------------------------- raster


def test_raster_matches_java_semantics() -> None:
    # 8x1 image: alternate black/white -> 0b10101010 = 0xAA, MSB first, 1 = black
    img = Image.new("L", (8, 1))
    img.putdata([0, 255, 0, 255, 0, 255, 0, 255])
    packed, w, h = R.rasterize(img, width=8, dither=False, threshold=128)
    check("MSB-first packing, 1 = black", packed == b"\xAA", packed.hex())

    img2 = Image.new("L", (8, 1))
    img2.putdata([255] * 8)
    check("all white -> zeros", R.rasterize(img2, width=8, dither=False)[0] == b"\x00")
    img3 = Image.new("L", (8, 1))
    img3.putdata([0] * 8)
    check("all black -> 0xFF", R.rasterize(img3, width=8, dither=False)[0] == b"\xFF")

    img4 = Image.new("L", (16, 1))
    img4.putdata([0] * 8 + [255] * 8)
    check("second byte order", R.rasterize(img4, width=16, dither=False)[0] == b"\xFF\x00")


def test_raster_size_and_padding() -> None:
    img = Image.new("L", (400, 300), 255)
    data, w, h = R.rasterize(img, width=384, dither=False)
    check("scales to requested width", w == 384, str(w))
    check("row-major byte count = w/8 * h", len(data) == (w // 8) * h, f"{len(data)} vs {(w//8)*h}")
    check("aspect preserved", h == round(300 * 384 / 400), str(h))

    odd, w2, h2 = R.rasterize(img, width=100, dither=False)
    check("non-multiple-of-8 width still packs continuously",
          len(odd) == (100 * h2 + 7) // 8)

    aligned = P.align_raster(b"\x01" * 50)
    check("align_raster pads to a multiple of 96", len(aligned) == 96 and aligned[:50] == b"\x01" * 50)
    aligned2 = P.align_raster(b"\x02" * 96)
    check("align_raster leaves exact multiples alone", aligned2 == b"\x02" * 96)


# -------------------------------------------------- end-to-end against a mock


def test_full_session_against_mock_printer() -> None:
    mac = "aabbccddeeff"
    state: dict = {"device_type": 6}
    session = P.PrinterSession(rng=random.Random(3))

    out = session.begin()
    check("session starts with 0x01 hardware info", out[0][:2] == bytes([0x5A, 0x01]))

    # printer answers with hardware info -> host handshakes
    reply = P.mock_printer_reply(out[0], mac, state)
    out = session.on_notification(reply[0])
    check("host answers 0x01 with 0x0A handshake", out[0][:2] == bytes([0x5A, 0x0A]))
    check("host learned the MAC", session.mac == mac)

    # printer echoes lowCrc -> host sends app check
    reply = P.mock_printer_reply(out[0], mac, state)
    check("mock lowCrc matches host lowCrc", reply[0][2:12].hex().upper() == session.low_crc)
    out = session.on_notification(reply[0])
    check("host sends 0x0B app check after verified handshake", out[0][:2] == bytes([0x5A, 0x0B]))
    check("app check carries highCrc", out[0][2:12].hex().upper() == session.high_crc)

    reply = P.mock_printer_reply(out[0], mac, state)
    session.on_notification(reply[0])
    check("printer accepted the app check", session.authenticated)

    # print a 2-row (96-byte) job plus a partial row
    raster = bytes([0xAA]) * 96 + bytes([0x55]) * 30
    out = session.start_print(raster, copies=1)
    check("print opens with 0x04 flag=0", out[0][:5] == bytes([0x5A, 0x04, 0x00, 0x02, 0x00]),
          out[0][:5].hex())
    check("totalPkg = ceil(len/96)", session.total_pkg == 2, str(session.total_pkg))

    # ping-pong until the printer is satisfied
    replies = P.mock_printer_reply(out[0], mac, state)
    rounds = 0
    last_out: list[bytes] = []
    while replies and rounds < 10:
        rounds += 1
        out = session.on_notification(replies[0])
        if not out:
            break
        last_out = out
        replies = P.mock_printer_reply(out[0], mac, state)

    check("printer received both data packets", sorted(state["received"]) == [0, 96],
          str(sorted(state["received"])))
    check("packet 0 payload preserved", state["received"][0] == bytes([0xAA]) * 96)
    check("packet 1 payload preserved and zero-padded",
          state["received"][96] == bytes([0x55]) * 30 + bytes(66))
    check("host asks for no more than totalPkg packets", session.packets_sent == 2,
          str(session.packets_sent))
    check("last host frame finalises the job (0x04 flag=1)",
          bool(last_out) and last_out[0][:2] == bytes([0x5A, 0x04]) and last_out[0][4] == 1,
          last_out[0][:5].hex() if last_out else "-")
    check("session marks the job done", session.job_done)


def test_handshake_retry_on_mismatch() -> None:
    session = P.PrinterSession(rng=random.Random(11))
    session.mac = "010203040506"
    session.challenge = bytes(range(1, 11))
    session.low_crc, session.high_crc = P.derive_crcs(session.challenge, session.mac)
    bad = bytes([0x5A, 0x0A]) + bytes.fromhex("FF" * 10)
    out = session.on_notification(bad)
    check("mismatched handshake reply triggers a fresh handshake",
          out[0][:2] == bytes([0x5A, 0x0A]) and session.challenge != bytes(range(1, 11)))
    check("retry recomputes the CRCs", session.low_crc != "" and session.high_crc != "")


def test_out_of_range_packet_request() -> None:
    session = P.PrinterSession()
    session.authenticated = True
    session.start_print(b"\x00" * 96)
    out = session.on_notification(bytes([0x5A, 0x05, 0x00, 0x09]))
    check("printer asking for a packet beyond totalPkg sends nothing", out == [])


def test_base64_write_encoding() -> None:
    """The app writes base64 of the frame; confirm the shape of what goes on the wire."""
    frame = P.print_status_frame(2, 0, 1)
    payload = base64.b64encode(frame).decode()
    check("base64 payload decodes back to the frame", base64.b64decode(payload) == frame)
    check("base64 payload is 16 chars for a 12-byte frame", len(payload) == 16, str(len(payload)))


def main() -> int:
    for fn in [
        test_crc_matches_app_variant,
        test_auth_derivation,
        test_frame_layouts,
        test_rejects_bad_frames,
        test_notification_parsing,
        test_raster_matches_java_semantics,
        test_raster_size_and_padding,
        test_full_session_against_mock_printer,
        test_handshake_retry_on_mismatch,
        test_out_of_range_packet_request,
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
