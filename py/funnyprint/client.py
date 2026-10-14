"""BLE transport for desktop use, built on bleak. Optional: only the CLI needs it."""
from __future__ import annotations

import asyncio
from typing import Callable, Optional

try:  # pragma: no cover - import guard
    from bleak import BleakClient, BleakScanner
except ImportError:  # pragma: no cover
    BleakClient = None
    BleakScanner = None

SERVICE_HINTS = ("ffe0", "ffe5", "ff00", "fff0", "ff90", "fee7")
NAME_PREFIXES = ("LX-D", "DL-P", "DL-T", "ZH-P", "TD-1", "T02", "ITW", "SWS-", "AH-M")


def require_bleak() -> None:
    if BleakClient is None:
        raise RuntimeError(
            "bleak is not installed. Install it with:  pip install --user bleak\n"
            "(the protocol library and --dry-run work without it)"
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
    """Matches the interface the session expects: connect(), write(bytes), onData."""

    def __init__(self, address: Optional[str] = None, name_prefix: Optional[str] = None,
                 log: Optional[Callable[[str], None]] = None):
        require_bleak()
        self.address = address
        self.name_prefix = name_prefix
        self.log = log or (lambda msg: None)
        self.client: Optional[BleakClient] = None
        self.write_char = None
        self.notify_char = None
        self.onData = None
        self.device_name = ""

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

        def _disconnected(_client):
            self.log("device disconnected")

        self.client = BleakClient(address, disconnected_callback=_disconnected)
        await self.client.connect()
        self.device_name = address
        # pick service + characteristics exactly like the vendor app does
        for service in self.client.services:
            su = service.uuid.lower()
            chars = service.characteristics
            w = next((c for c in chars if "ffe1" in c.uuid.lower()), None)
            n = next((c for c in chars if "ffe2" in c.uuid.lower()), None)
            if w or (n and any("ffe0" in su for _ in [0])):
                self.write_char, self.notify_char = w, n
                break
        if self.write_char is None:
            for service in self.client.services:
                for c in service.characteristics:
                    props = c.properties
                    if "write-without-response" in props or "write" in props:
                        if self.write_char is None:
                            self.write_char = c
                    if "notify" in props or "indicate" in props:
                        if self.notify_char is None:
                            self.notify_char = c
                if self.write_char is not None:
                    break
        if self.write_char is None:
            raise RuntimeError("no writable characteristic found")
        self.log(f"write char {self.write_char.uuid} · notify char "
                 f"{self.notify_char.uuid if self.notify_char else 'none'}")

        if self.notify_char is not None:
            await self.client.start_notify(self.notify_char.uuid, self._on_notify)

    def _on_notify(self, _sender, data: bytearray) -> None:
        if self.onData:
            self.onData(bytes(data))

    async def write(self, frame: bytes) -> None:
        await self.client.write_gatt_char(self.write_char, frame, response=False)

    async def feed(self, distance: int = 3) -> None:
        from .protocol import move_paper_frame
        await self.write(move_paper_frame(distance))

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
