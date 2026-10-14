"""BLE transport for desktop use, built on bleak. Optional: only live printing needs it."""
from __future__ import annotations

import asyncio
from typing import Callable, Optional

try:  # pragma: no cover - import guard
    from bleak import BleakClient, BleakScanner
except ImportError:  # pragma: no cover
    BleakClient = None
    BleakScanner = None

from .protocol import NOTIFY_CHAR_HINT, WRITE_CHAR_HINT

SERVICE_HINTS = ("ffe6", "ffe0", "ae30", "ff00", "fff0")
NAME_PREFIXES = ("LX-D", "LX", "DL-P", "DL-T", "ZH-P", "TD-1", "T02", "ITW", "SWS-", "AH-M")


def require_bleak() -> None:
    if BleakClient is None:
        raise RuntimeError(
            "bleak is not installed. Install it with:  pip install --user bleak\n"
            "(the protocol library, the tests and --dry-run work without it)"
        )


async def scan(timeout: float = 8.0) -> list[dict]:
    require_bleak()
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    out = []
    for device, adv in found.values():
        name = device.name or adv.local_name or ""
        out.append({
            "address": device.address,
            "name": name,
            "rssi": adv.rssi,
            "known": any(name.upper().startswith(p) for p in NAME_PREFIXES),
        })
    return sorted(out, key=lambda d: (not d["known"], -d["rssi"]))


class BleakTransport:
    """Interface the session driver expects: connect(), write(bytes), onData callback."""

    def __init__(self, address: Optional[str] = None, name_prefix: Optional[str] = None,
                 log: Optional[Callable[[str], None]] = None):
        require_bleak()
        self.address = address
        self.name_prefix = name_prefix
        self.log = log or (lambda msg: None)
        self.client: Optional[BleakClient] = None
        self.write_char = None
        self.notify_char = None
        self.service_uuid = None
        self.device_name = ""
        self.onData = None

    async def _resolve(self) -> str:
        if self.address:
            return self.address
        self.log("scanning for a printer…")
        for dev in await scan():
            if self.name_prefix and not dev["name"].upper().startswith(self.name_prefix.upper()):
                continue
            if not self.name_prefix and not dev["known"]:
                continue
            self.log(f"using {dev['name'] or 'unnamed'} ({dev['address']}) rssi={dev['rssi']}")
            return dev["address"]
        raise RuntimeError("no printer found; pass --device ADDRESS or --name PREFIX")

    async def connect(self) -> None:
        address = await self._resolve()

        self.client = BleakClient(address, disconnected_callback=lambda _c: self.log("device disconnected"))
        await self.client.connect()
        self.device_name = address

        # Prefer the vendor service/characteristic naming (ffe6 / ffe1 / ffe2).
        candidate_services = []
        for service in self.client.services:
            chars = service.characteristics
            if any(WRITE_CHAR_HINT in c.uuid.lower() for c in chars):
                candidate_services.insert(0, service)
            elif any(NOTIFY_CHAR_HINT in c.uuid.lower() for c in chars):
                candidate_services.append(service)
            elif any(h in service.uuid.lower() for h in SERVICE_HINTS):
                candidate_services.append(service)
        for service in candidate_services:
            for c in service.characteristics:
                u = c.uuid.lower()
                if self.write_char is None and WRITE_CHAR_HINT in u:
                    self.write_char, self.service_uuid = c, service.uuid
                if self.notify_char is None and NOTIFY_CHAR_HINT in u:
                    self.notify_char = c
            if self.write_char is not None:
                break
        if self.write_char is None:
            for service in self.client.services:
                for c in service.characteristics:
                    props = c.properties
                    if self.write_char is None and ("write-without-response" in props or "write" in props):
                        self.write_char, self.service_uuid = c, service.uuid
                    if self.notify_char is None and ("notify" in props or "indicate" in props):
                        self.notify_char = c
        if self.write_char is None:
            raise RuntimeError("no writable characteristic found")
        self.log(f"write {self.write_char.uuid} · notify "
                 f"{self.notify_char.uuid if self.notify_char else 'none'}")

        if self.notify_char is not None:
            await self.client.start_notify(self.notify_char.uuid, self._on_notify)

    def _on_notify(self, _sender, data: bytearray) -> None:
        if self.onData:
            self.onData(bytes(data))

    async def write(self, frame: bytes) -> None:
        await self.client.write_gatt_char(self.write_char, frame, response=False)

    async def disconnect(self) -> None:
        if self.client is not None:
            try:
                if self.notify_char is not None:
                    await self.client.stop_notify(self.notify_char.uuid)
            except Exception:
                pass
            await self.client.disconnect()

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.disconnect()


async def run_job(transport: BleakTransport, session, raster: bytes, density: int = 0,
                  timeout_s: float = 30.0) -> bool:
    """Drive one print job: stream packets, honour flow control, close the job.

    Returns True if the printer reported the job finished.
    """
    from .protocol import INTER_PACKET_MS

    pending = asyncio.Queue()

    async def handle(frame: bytes) -> None:
        for out in session.on_notification(frame):
            await transport.write(out)

    transport.onData = lambda data: asyncio.create_task(handle(data))
    try:
        for frame in session.begin():
            await transport.write(frame)
        for _ in range(80):
            if session.authenticated:
                break
            await asyncio.sleep(0.1)
        if not session.authenticated:
            print("printer refused the handshake; nothing was sent")
            return False

        for frame in session.start_job(raster, density=density):
            await transport.write(frame)

        deadline = asyncio.get_event_loop().time() + timeout_s
        while not session.finished and not session.job_done:
            if asyncio.get_event_loop().time() > deadline:
                print(f"timed out at packet {session.cursor}/{session.total_pkg}")
                break
            frame = session.next_stream_frame(asyncio.get_event_loop().time())
            if frame is None:
                await asyncio.sleep(0.05 if session.hold else session.inter_packet_ms / 1000)
                continue
            await transport.write(frame)
            await asyncio.sleep(session.inter_packet_ms / 1000)

        if session.finished:
            for frame in session.finish_frames():
                await transport.write(frame)
        return session.finished
    finally:
        del pending
        for line in session.log:
            print("  " + line)
        session.log.clear()
