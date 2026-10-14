"""Funny Print / Dolewa (com.lailaixiong.funnyprint) BLE thermal printer protocol.

Reverse engineered from the stock APK; see ../../PROTOCOL.md for evidence anchors.
Pure stdlib. Frames are exactly what the stock app emits, byte for byte.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Optional

MAGIC_CMD = 0x5A
MAGIC_DATA = 0x55
CMD_FRAME_LEN = 12
DATA_PACKET_LEN = 100
DATA_PAYLOAD_LEN = 96

CMD_HW_INFO = 0x01
CMD_MOVE_PAPER = 0x03
CMD_PRINT_STATUS = 0x04
CMD_HANDSHAKE = 0x0A
CMD_APP_CHECK = 0x0B

RESP_HW_INFO = 0x01
RESP_READY = 0x03
RESP_PRINT_RESULT = 0x04
RESP_REQ_PACKET = 0x05
RESP_PRINT_END = 0x06
RESP_PAUSE = 0x08
RESP_HANDSHAKE = 0x0A
RESP_APP_CHECK = 0x0B

FLAG_START = 0
FLAG_FINISH = 1


def crc16_xmodem(data: bytes) -> int:
    """CRC-16/XMODEM: poly 0x1021, init 0x0000, no reflection, no final xor.

    The stock app accumulates in an unmasked int32 instead of masking each step; that
    variant is numerically identical to this for the 7-byte inputs used here
    (20 000 random vectors, 0 mismatches) because the accumulator stays under 2^31.
    """
    crc = 0
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


def derive_crcs(random_bytes: bytes, mac_hex: str) -> tuple[str, str]:
    """Reproduce the app's checkCrc(): (lowCrc, highCrc) as 20-char uppercase hex."""
    if len(random_bytes) != 10:
        raise ValueError("challenge must be 10 bytes")
    mac_hex = mac_hex.lower()
    if len(mac_hex) != 12:
        raise ValueError("mac must be 12 hex chars (6 bytes)")
    low = ""
    high = ""
    for byte in random_bytes:
        msg = bytes.fromhex(f"{byte:02x}") + bytes.fromhex(mac_hex)
        h = f"{crc16_xmodem(msg):04X}"
        low += h[2:4]
        high += h[0:2]
    return low, high


def _cmd_frame(cmd: int, payload: bytes = b"") -> bytes:
    body = bytes([MAGIC_CMD, cmd]) + payload
    if len(body) > CMD_FRAME_LEN:
        raise ValueError(f"command frame too long: {len(body)}")
    return body.ljust(CMD_FRAME_LEN, b"\x00")


def hardware_info_frame() -> bytes:
    return _cmd_frame(RESP_HW_INFO)


def handshake_frame(random_bytes: bytes) -> bytes:
    return _cmd_frame(CMD_HANDSHAKE, random_bytes)


def app_check_frame(high_crc_hex: str) -> bytes:
    return _cmd_frame(CMD_APP_CHECK, bytes.fromhex(high_crc_hex))


def move_paper_frame(distance: int = 3) -> bytes:
    """0x03 / 0x82 — the stock app's sendMovePaper(); only used for 'TB' models."""
    return _cmd_frame(CMD_MOVE_PAPER, bytes([0x82, 0x00, distance & 0xFF, 0x00, 0x00]))


def print_status_frame(total_pkg: int, flag: int, print_num: int) -> bytes:
    """0x04 — opens (flag=0) or finalises (flag=1) a print job."""
    if not 0 <= total_pkg <= 0xFFFF:
        raise ValueError("total_pkg out of u16 range")
    return _cmd_frame(
        CMD_PRINT_STATUS,
        bytes([(total_pkg >> 8) & 0xFF, total_pkg & 0xFF, flag & 0xFF, print_num & 0xFF]),
    )


def data_frame(offset: int, payload: bytes) -> bytes:
    """0x55 — one 96-byte slice of 1-bit raster, offset is a u16 big-endian byte offset."""
    if len(payload) != DATA_PAYLOAD_LEN:
        raise ValueError(f"payload must be {DATA_PAYLOAD_LEN} bytes, got {len(payload)}")
    if not 0 <= offset <= 0xFFFF:
        raise ValueError("offset out of u16 range")
    return bytearray([MAGIC_DATA, (offset >> 8) & 0xFF, offset & 0xFF]) + payload + b"\x00"


def align_raster(raster: bytes) -> bytes:
    """Zero-pad to a multiple of 96, as the app's alignMainBuffer() does."""
    rem = len(raster) % DATA_PAYLOAD_LEN
    if rem:
        raster = raster + b"\x00" * (DATA_PAYLOAD_LEN - rem)
    return raster


@dataclass
class Notification:
    cmd: int
    data: bytes

    @property
    def mac(self) -> str:
        return self.data[4:10].hex()

    @property
    def device_type(self) -> int:
        return self.data[10]

    @property
    def packet_index(self) -> int:
        """1-based packet index the printer is asking for (0x05)."""
        return int.from_bytes(self.data[2:4], "big")

    @property
    def handshake_reply(self) -> str:
        return self.data[2:12].hex().upper()

    @property
    def app_check_ok(self) -> bool:
        return len(self.data) > 2 and self.data[2] == 0x01

    @property
    def print_end(self) -> tuple[int, int]:
        return int.from_bytes(self.data[2:4], "big"), (self.data[4] if len(self.data) > 4 else 0)

    @property
    def print_result_flag(self) -> int:
        return self.data[4] if len(self.data) > 4 else 0


def parse_notification(raw: bytes) -> Optional[Notification]:
    """0x5A-magic framed notification, or None if the frame is not ours."""
    if len(raw) < 2 or raw[0] != MAGIC_CMD:
        return None
    return Notification(cmd=raw[1], data=raw)


@dataclass
class PrinterSession:
    """Host side of the protocol: feed it notifications, get frames to write back.

    Mirrors the stock app's state machine (XiqiPrinter) so behaviour matches:
    hardware info -> handshake -> app check -> idle -> print job -> packet ping-pong.
    """

    rng: random.Random = field(default_factory=random.Random)
    challenge: bytes = b""
    mac: str = ""
    device_type: int = 0
    low_crc: str = ""
    high_crc: str = ""
    authenticated: bool = False
    raster: bytes = b""
    total_pkg: int = 0
    print_num: int = 1
    job_open: bool = False
    job_done: bool = False
    packets_sent: int = 0
    log: list[str] = field(default_factory=list)

    # ---- host initiated -------------------------------------------------

    def begin(self) -> list[bytes]:
        """First step after services/MTU are up."""
        return [hardware_info_frame()]

    def start_print(self, raster: bytes, copies: int = 1) -> list[bytes]:
        """Open a print job. Raster is the 1-bit packed bitmap."""
        if not self.authenticated:
            raise RuntimeError("printer not authenticated yet")
        self.raster = align_raster(raster)
        self.total_pkg = (len(self.raster) + DATA_PAYLOAD_LEN - 1) // DATA_PAYLOAD_LEN
        self.print_num = max(1, copies)
        self.job_open = True
        self.job_done = False
        self.packets_sent = 0
        return [print_status_frame(self.total_pkg, FLAG_START, self.print_num)]

    def packet_for(self, index: int) -> bytes:
        """Data frame for 0-based packet index; the printer asks 1-based."""
        offset = index * DATA_PAYLOAD_LEN
        return data_frame(offset, self.raster[offset:offset + DATA_PAYLOAD_LEN])

    # ---- printer initiated ----------------------------------------------

    def on_notification(self, raw: bytes) -> list[bytes]:
        note = parse_notification(raw)
        if note is None:
            self.log.append(f"ignored non-0x5A frame: {raw.hex()}")
            return []
        handler = {
            RESP_HW_INFO: self._on_hw_info,
            RESP_HANDSHAKE: self._on_handshake,
            RESP_APP_CHECK: self._on_app_check,
            RESP_REQ_PACKET: self._on_req_packet,
            RESP_PRINT_END: self._on_print_end,
            RESP_PRINT_RESULT: self._on_print_result,
            RESP_READY: self._on_ready,
            RESP_PAUSE: self._on_pause,
        }.get(note.cmd)
        if handler is None:
            self.log.append(f"unhandled command 0x{note.cmd:02X}")
            return []
        return handler(note)

    def _on_hw_info(self, note: Notification) -> list[bytes]:
        self.mac = note.mac
        self.device_type = note.device_type
        self.challenge = bytes(self.rng.randint(1, 254) for _ in range(10))
        self.low_crc, self.high_crc = derive_crcs(self.challenge, self.mac)
        self.log.append(f"device mac={self.mac} type={self.device_type}")
        return [handshake_frame(self.challenge)]

    def _on_handshake(self, note: Notification) -> list[bytes]:
        if note.handshake_reply == self.low_crc:
            self.log.append("handshake verified")
            return [app_check_frame(self.high_crc)]
        self.log.append(f"handshake mismatch {note.handshake_reply} != {self.low_crc}, retrying")
        self.challenge = bytes(self.rng.randint(1, 254) for _ in range(10))
        self.low_crc, self.high_crc = derive_crcs(self.challenge, self.mac)
        return [handshake_frame(self.challenge)]

    def _on_app_check(self, note: Notification) -> list[bytes]:
        self.authenticated = note.app_check_ok
        self.log.append("app check " + ("ok" if self.authenticated else "FAILED"))
        return []

    def _on_req_packet(self, note: Notification) -> list[bytes]:
        index = note.packet_index - 1
        if index < 0 or index >= self.total_pkg:
            self.log.append(f"printer asked for packet {index + 1}, out of range")
            return []
        self.packets_sent += 1
        return [self.packet_for(index)]

    def _on_print_end(self, note: Notification) -> list[bytes]:
        total, _resp_count = note.print_end
        self.log.append(f"print end (printer total={total}, ours={self.total_pkg})")
        self.job_done = True
        self.job_open = False
        return [print_status_frame(self.total_pkg, FLAG_FINISH, self.print_num)]

    def _on_print_result(self, note: Notification) -> list[bytes]:
        if note.print_result_flag == 1:
            self.log.append("printer reports job finished")
            self.job_done = True
            self.job_open = False
        return []

    def _on_ready(self, note: Notification) -> list[bytes]:
        """Printer says it is ready for data — re-open the job if we have one."""
        if self.raster and not self.job_done:
            self.job_open = True
            return [print_status_frame(self.total_pkg, FLAG_START, self.print_num)]
        return []

    def _on_pause(self, note: Notification) -> list[bytes]:
        self.log.append("printer paused")
        return []


def mock_printer_reply(frame: bytes, mac_hex: str, state: dict) -> list[bytes]:
    """A stand-in for the device, used by the test suite to close the loop.

    Implements the printer half of the handshake and the packet request flow as
    documented in PROTOCOL.md §4/§5/§6.
    """
    if frame and frame[0] == MAGIC_DATA and len(frame) == DATA_PACKET_LEN:
        offset = int.from_bytes(frame[1:3], "big")
        state["received"][offset] = bytes(frame[3:99])
        nxt = offset // DATA_PAYLOAD_LEN + 2
        if nxt <= state.get("total", 0):
            return [bytes([MAGIC_CMD, RESP_REQ_PACKET]) + nxt.to_bytes(2, "big")]
        return [bytes([MAGIC_CMD, RESP_PRINT_END])
                + state.get("total", 0).to_bytes(2, "big") + bytes([0x01])]
    if not frame or frame[0] != MAGIC_CMD:
        return []
    cmd = frame[1]
    if cmd == CMD_HW_INFO:
        state["mac"] = mac_hex
        payload = bytearray(8)
        payload[0:6] = bytes.fromhex(mac_hex)
        payload[6] = state.get("device_type", 6)
        return [bytes([MAGIC_CMD, RESP_HW_INFO, 0x00, 0x00]) + bytes(payload)]
    if cmd == CMD_HANDSHAKE:
        challenge = frame[2:12]
        low, high = derive_crcs(challenge, mac_hex)
        state["high"] = high
        return [bytes([MAGIC_CMD, RESP_HANDSHAKE]) + bytes.fromhex(low)]
    if cmd == CMD_APP_CHECK:
        ok = frame[2:12].hex().upper() == state.get("high")
        return [bytes([MAGIC_CMD, RESP_APP_CHECK, 0x01 if ok else 0x00])]
    if cmd == CMD_PRINT_STATUS:
        total = int.from_bytes(frame[2:4], "big")
        flag = frame[4]
        if flag == FLAG_FINISH:
            return [bytes([MAGIC_CMD, RESP_PRINT_RESULT, 0x00, 0x00, 0x00, 0x01])]
        state["total"] = total
        state["received"] = {}
        state["want"] = 1
        return [bytes([MAGIC_CMD, RESP_REQ_PACKET, 0x00, 0x01])]
    return []
