"""LX-D02 / FunnyPrint (com.lailaixiong.funnyprint) BLE thermal printer protocol.

Reverse engineered from the stock APK (see ../../PROTOCOL.md for evidence anchors), then
cross-checked against cicloid/printable, an independent hardware-validated implementation
of the same printer family. That cross-check corrected two things here: the GATT service is
0xFFE6, and the raster packet carries a packet *index* where this code used to write a byte
offset. Pure stdlib.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Optional

MAGIC_CMD = 0x5A
MAGIC_DATA = 0x55
DATA_PACKET_LEN = 100
DATA_PAYLOAD_LEN = 96          # two print lines of 48 bytes
LINE_BYTES = 48                # 384 dots / 8
PRINT_WIDTH = 384

CMD_HELLO = 0x01
CMD_PRINT_START = 0x04
CMD_CHALLENGE = 0x0A
CMD_AUTH_REPLY = 0x0B
CMD_SET_DENSITY = 0x0C

RESP_HELLO = 0x01
RESP_STATUS = 0x02
RESP_READY = 0x03
RESP_PRINT_RESULT = 0x04
RESP_LOST_PACKET = 0x05
RESP_FINISHED = 0x06
RESP_COOLDOWN = 0x07
RESP_HOLD = 0x08
RESP_CHALLENGE_REPLY = 0x0A
RESP_AUTH_RESULT = 0x0B

FLAG_START = 0
FLAG_FINISH = 1
COOLDOWN_MS = 100
INTER_PACKET_MS = 15

SERVICE_UUID = "0000ffe6-0000-1000-8000-00805f9b34fb"   # LX-D02 / LX-D2
WRITE_CHAR_HINT = "ffe1"
NOTIFY_CHAR_HINT = "ffe2"


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


def derive_crcs(challenge: bytes, mac_hex: str) -> tuple[str, str]:
    """(low_crc, high_crc) as 20-char uppercase hex.

    The printer wants the HIGH byte of each CRC back in the 0x0B reply; low_crc is what the
    vendor app compares the 0x0A reply against (a validated implementation ignores it).
    """
    if len(challenge) != 10:
        raise ValueError("challenge must be 10 bytes")
    mac_hex = mac_hex.lower()
    if len(mac_hex) != 12:
        raise ValueError("mac must be 12 hex chars (6 bytes)")
    low = ""
    high = ""
    for byte in challenge:
        msg = bytes([byte]) + bytes.fromhex(mac_hex)
        h = f"{crc16_xmodem(msg):04X}"
        high += h[0:2]
        low += h[2:4]
    return low, high


# ------------------------------------------------------------------ frames

def hello_frame() -> bytes:
    """5A 01 + ten zero bytes (12 in total)."""
    return bytes([MAGIC_CMD, CMD_HELLO]) + bytes(10)


def challenge_frame(challenge: bytes) -> bytes:
    """5A 0A + ten challenge bytes."""
    if len(challenge) != 10:
        raise ValueError("challenge must be 10 bytes")
    return bytes([MAGIC_CMD, CMD_CHALLENGE]) + challenge


def auth_reply_frame(response_hex: str) -> bytes:
    """5A 0B + ten response bytes."""
    return bytes([MAGIC_CMD, CMD_AUTH_REPLY]) + bytes.fromhex(response_hex)


def density_frame(level: int) -> bytes:
    """5A 0C <level> — three bytes, level 1..7."""
    if not 1 <= level <= 7:
        raise ValueError("density is 1..7")
    return bytes([MAGIC_CMD, CMD_SET_DENSITY, level])


def print_status_frame(total_pkg: int, flag: int) -> bytes:
    """5A 04 <count:u16be> <flag> 00 — six bytes; flag 0 opens a job, 1 closes it."""
    if not 0 <= total_pkg <= 0xFFFF:
        raise ValueError("total_pkg out of u16 range")
    return bytes([MAGIC_CMD, CMD_PRINT_START,
                  (total_pkg >> 8) & 0xFF, total_pkg & 0xFF, flag & 0xFF, 0x00])


def data_frame(index: int, payload: bytes) -> bytes:
    """55 <index:u16be> <96 bytes> 00 — always 100 bytes.

    The u16 is the PACKET INDEX (0-based), not a byte offset; the offset is index * 96 and
    is only used to slice the raster locally.
    """
    if len(payload) != DATA_PAYLOAD_LEN:
        raise ValueError(f"payload must be {DATA_PAYLOAD_LEN} bytes, got {len(payload)}")
    if not 0 <= index <= 0xFFFF:
        raise ValueError("index out of u16 range")
    return bytearray([MAGIC_DATA, (index >> 8) & 0xFF, index & 0xFF]) + payload + b"\x00"


def align_raster(raster: bytes) -> bytes:
    """Zero-pad to a multiple of 96."""
    rem = len(raster) % DATA_PAYLOAD_LEN
    if rem:
        raster = raster + b"\x00" * (DATA_PAYLOAD_LEN - rem)
    return raster


def blank_raster(rows: int) -> bytes:
    """Paper advance is printing blank rows; the command set has no feed opcode."""
    return bytes(rows * LINE_BYTES)


# ------------------------------------------------------- notifications

@dataclass
class Notification:
    cmd: int
    data: bytes

    @property
    def mac(self) -> str:
        return self.data[4:10].hex()

    @property
    def battery(self) -> int:
        return self.data[2] if len(self.data) > 2 else 0

    @property
    def no_paper(self) -> bool:
        return len(self.data) > 3 and self.data[3] != 0

    @property
    def charging(self) -> bool:
        return len(self.data) > 4 and self.data[4] == 1

    @property
    def overheat(self) -> bool:
        return len(self.data) > 5 and self.data[5] != 0

    @property
    def low_battery(self) -> bool:
        return len(self.data) > 6 and self.data[6] != 0

    @property
    def u16(self) -> int:
        return int.from_bytes(self.data[2:4], "big") if len(self.data) >= 4 else 0

    @property
    def challenge_reply(self) -> str:
        return self.data[2:12].hex().upper()

    @property
    def auth_ok(self) -> bool:
        return len(self.data) > 2 and self.data[2] == 0x01

    @property
    def print_result_flag(self) -> int:
        return self.data[4] if len(self.data) > 4 else 0


def parse_notification(raw: bytes) -> Optional[Notification]:
    if len(raw) < 2 or raw[0] != MAGIC_CMD:
        return None
    return Notification(cmd=raw[1], data=raw)


# ------------------------------------------------------------- session

@dataclass
class PrinterSession:
    """Protocol brain: no I/O, no sleeping. The caller owns the clock.

    Mirror of the vendor app's state machine plus the flow-control signals a validated
    implementation relies on (0x05 rewind, 0x07 cooldown, 0x08 hold).
    """

    rng: random.Random = field(default_factory=random.Random)
    challenge: bytes = b""
    mac: str = ""
    low_crc: str = ""
    high_crc: str = ""
    authenticated: bool = False
    last_auth_check: Optional[bool] = None
    raster: bytes = b""
    total_pkg: int = 0
    cursor: int = 0
    finished: bool = False
    job_done: bool = False
    hold: bool = False
    cooldown_until: float = 0.0
    density: int = 3
    status: Optional[dict] = None
    log: list[str] = field(default_factory=list)

    # ---- host initiated -------------------------------------------------

    def begin(self) -> list[bytes]:
        return [hello_frame()]

    def start_job(self, raster: bytes, density: int = 0) -> list[bytes]:
        if not self.authenticated:
            raise RuntimeError("printer not authenticated")
        self.raster = align_raster(raster)
        self.total_pkg = (len(self.raster) + DATA_PAYLOAD_LEN - 1) // DATA_PAYLOAD_LEN
        self.cursor = 0
        self.finished = False
        self.job_done = False
        self.hold = False
        self.cooldown_until = 0.0
        self.density = density or 3
        out: list[bytes] = []
        if density:
            out.append(density_frame(density))
        out.append(print_status_frame(self.total_pkg, FLAG_START))
        self.log.append(f"job open: {self.total_pkg} packet(s), density {self.density}")
        return out

    def next_stream_frame(self, now: Optional[float] = None) -> Optional[bytes]:
        if self.job_done or self.finished or self.hold:
            return None
        if now is not None and now < self.cooldown_until:
            return None
        if self.cursor >= self.total_pkg:
            return None
        index = self.cursor
        offset = index * DATA_PAYLOAD_LEN
        self.cursor += 1
        return data_frame(index, self.raster[offset:offset + DATA_PAYLOAD_LEN])

    def finish_frames(self) -> list[bytes]:
        if self.job_done:
            return []
        self.job_done = True
        return [print_status_frame(self.total_pkg, FLAG_FINISH)]

    # ---- printer initiated ----------------------------------------------

    def on_notification(self, raw: bytes, now: Optional[float] = None) -> list[bytes]:
        note = parse_notification(raw)
        if note is None:
            self.log.append(f"ignored non-0x5A frame: {raw.hex()[:24]}")
            return []
        handler = {
            RESP_HELLO: self._on_hello,
            RESP_CHALLENGE_REPLY: self._on_challenge_reply,
            RESP_AUTH_RESULT: self._on_auth_result,
            RESP_STATUS: self._on_status,
            RESP_LOST_PACKET: self._on_lost_packet,
            RESP_FINISHED: self._on_finished,
            RESP_COOLDOWN: self._on_cooldown,
            RESP_HOLD: self._on_hold,
            RESP_PRINT_RESULT: self._on_print_result,
            RESP_READY: self._on_ready,
        }.get(note.cmd)
        if handler is None:
            self.log.append(f"unknown command 0x{note.cmd:02X}")
            return []
        return handler(note, now)

    def _on_hello(self, note: Notification, now) -> list[bytes]:
        self.mac = note.mac
        self.challenge = bytes(self.rng.randint(1, 254) for _ in range(10))
        self.low_crc, self.high_crc = derive_crcs(self.challenge, self.mac)
        self.log.append(f"device mac={self.mac}")
        return [challenge_frame(self.challenge)]

    def _on_challenge_reply(self, note: Notification, now) -> list[bytes]:
        # The reply payload is undocumented: the vendor app compares it to its low CRC, a
        # validated implementation ignores it. Record the comparison, answer either way.
        self.last_auth_check = note.challenge_reply == self.low_crc
        self.log.append("challenge reply" + (" matched lowCrc" if self.last_auth_check else " payload differs, continuing"))
        return [auth_reply_frame(self.high_crc)]

    def _on_auth_result(self, note: Notification, now) -> list[bytes]:
        self.authenticated = note.auth_ok
        self.log.append("auth " + ("ok" if self.authenticated else "FAILED"))
        return []

    def _on_status(self, note: Notification, now) -> list[bytes]:
        self.status = {
            "battery": note.battery, "no_paper": note.no_paper, "charging": note.charging,
            "overheat": note.overheat, "low_battery": note.low_battery,
        }
        self.log.append(
            f"status: battery {note.battery}%"
            + (" · OUT OF PAPER" if note.no_paper else "")
            + (" · charging" if note.charging else "")
            + (" · too hot" if note.overheat else "")
            + (" · low battery" if note.low_battery else "")
        )
        return []

    def _on_lost_packet(self, note: Notification, now) -> list[bytes]:
        target = max(0, note.u16 - 1)
        self.log.append(f"lost packet {note.u16} → rewinding to {target}")
        self.cursor = target
        self.hold = False
        return []

    def _on_finished(self, note: Notification, now) -> list[bytes]:
        self.log.append(f"printer finished ({note.u16} packet(s))")
        self.finished = True
        self.hold = False
        return []

    def _on_cooldown(self, note: Notification, now) -> list[bytes]:
        self.cooldown_until = (now or 0.0) + COOLDOWN_MS / 1000.0
        self.log.append(f"cooldown: backing off {COOLDOWN_MS} ms")
        return []

    def _on_hold(self, note: Notification, now) -> list[bytes]:
        self.hold = True
        self.log.append("printer asked us to hold")
        return []

    def _on_print_result(self, note: Notification, now) -> list[bytes]:
        if note.print_result_flag == 1:
            self.log.append("job closed by the printer")
            self.job_done = True
        return []

    def _on_ready(self, note: Notification, now) -> list[bytes]:
        self.log.append("printer ready")
        return []


# --------------------------------------------------------------- mock

def mock_printer_reply(frame: bytes, mac_hex: str, state: dict) -> list[bytes]:
    """Stand-in for the device, used by the test suite and the CLI's --dry-run."""
    if frame and frame[0] == MAGIC_DATA and len(frame) == DATA_PACKET_LEN:
        index = int.from_bytes(frame[1:3], "big")
        state.setdefault("received", {})[index] = bytes(frame[3:99])
        if index == state.get("total", 0) - 1:
            total = state.get("total", 0)
            return [bytes([MAGIC_CMD, RESP_FINISHED, (total >> 8) & 0xFF, total & 0xFF])]
        return []
    if not frame or frame[0] != MAGIC_CMD:
        return []
    cmd = frame[1]
    if cmd == CMD_HELLO:
        return [bytes([MAGIC_CMD, RESP_HELLO, 0, 0]) + bytes.fromhex(mac_hex) + bytes(1)]
    if cmd == CMD_CHALLENGE:
        low, high = derive_crcs(frame[2:12], mac_hex)
        state["high"] = high
        # junk payload on purpose: the host must not depend on it
        return [bytes([MAGIC_CMD, RESP_CHALLENGE_REPLY]) + bytes.fromhex("deadbeefdeadbeefdead")]
    if cmd == CMD_AUTH_REPLY:
        ok = frame[2:12].hex().upper() == state.get("high")
        return [bytes([MAGIC_CMD, RESP_AUTH_RESULT, 0x01 if ok else 0x00])]
    if cmd == CMD_SET_DENSITY:
        state["density"] = frame[2]
        return []
    if cmd == CMD_PRINT_START:
        total = int.from_bytes(frame[2:4], "big")
        if frame[4] == FLAG_FINISH:
            state["print_ended"] = True
            return []
        state["total"] = total
        return [bytes([MAGIC_CMD, RESP_STATUS, 88, 0, 1, 0, 0, state.get("density", 3)])]
    return []
