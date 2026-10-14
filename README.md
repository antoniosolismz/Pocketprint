# Pocket Print — companion for the "Funny Print" / Dolewa mini thermal printer

A replacement for the vendor app `com.lailaixiong.funnyprint` (2.8.1). It speaks the
printer's Bluetooth protocol directly, prints from text / images / PDF pages, and talks
to nothing else: no account, no cloud, no analytics, no permissions beyond Bluetooth.

```
PROTOCOL.md          byte-level spec, with the evidence anchor for every claim
py/funnyprint/       reference library (protocol, raster, BLE client, CLI)
py/tests/            self-contained test suite + vector generator
web/index.html       the app: single page, Web Bluetooth, works offline
web/funnyprint.js    the same protocol core in JavaScript (shared with the page)
web/tests/           cross-implementation conformance + end-to-end print test
```

## The app (recommended)

**Live at https://print.otelo2.com** — open it in **Chrome or Edge** (Android, or any
Chromium desktop; Firefox has no Web Bluetooth). Pick text, an image, or the built-in
calibration sheet, adjust darkness and dithering, watch the 1:1 preview, press Print.

`web/index.html` + `web/funnyprint.js` are the whole app: two static files, no build step,
no backend. Web Bluetooth needs a secure origin from a phone, which is why it is served
over HTTPS rather than opened as a local file.

## Where it runs

| | |
|---|---|
| LXC | `136` `pocketprint` on `virtual`, **192.168.0.221** (services block, `onboot 1`) |
| Web server | nginx, static root `/var/www/pocketprint`, site `pocketprint` |
| Public name | `print.otelo2.com` → Cloudflare tunnel `virtual` → `http://192.168.0.221:80` |
| Monitoring | Wazuh agent `024 pocketprint`; `homelab_health.sh` checks both the public name and the LAN origin; Glance "Services" tile |
| Deploy | `./deploy.sh` — packages `web/`, pushes, then verifies sha256 on the LAN origin **and** through the tunnel |

Updating the app is `./deploy.sh` (add `--dry-run` to see the digests without pushing).
There is deliberately **no LAN friendly name** for this one: the internal proxy publishes
`*.home.arpa` over plain HTTP, and Web Bluetooth does not run outside a secure context —
a `http://pocketprint.home.arpa` route would load a page that cannot print. The public
HTTPS name works from inside the house too.

## Desktop CLI

```bash
python3 py/funnyprint/cli.py scan                  # list nearby BLE devices
python3 py/funnyprint/cli.py info   --name LX-D02  # connect, report MAC/auth/battery
python3 py/funnyprint/cli.py test   --name LX-D02  # print the calibration sheet
python3 py/funnyprint/cli.py text   "hello" --name LX-D02
python3 py/funnyprint/cli.py image  photo.png --density 4 --threshold 120 --no-dither
python3 py/funnyprint/cli.py feed   --rows 6       # advance paper (prints blank rows)
python3 py/funnyprint/cli.py dry-run --text "hello" # no Bluetooth: dump every frame
```

Live printing needs `pip install --user bleak`. `--dry-run` and the whole test suite work
on the standard library plus Pillow.

## Calibration

The printer does not advertise its dot width, and the vendor app doesn't hardcode one
either (it passes a width down from JavaScript per template). So:

1. Print the calibration sheet at 384 (default).
2. If the right-hand frame edge is missing or the image is squeezed, try 400 (50 mm
   label models) or 576 (80 mm models); narrow label models take 240 or 200.

Ticks on the sheet are 8 dots apart, labelled every 64 dots. If the frame lands exactly
on both edges at 384, you are set.

## What was verified, and how

- `python3 py/tests/test_all.py` — 83 checks: CRC/auth derivation, frame layouts, the
  service UUID, notification parsing, raster semantics, flow control (hold, cooldown, lost
  packet) and a **complete print job driven against a mock printer**.
- `node web/tests/conformance.mjs` — 49 checks: the JavaScript core is asserted
  **byte-identical to the Python reference** (CRC, auth, frames, raster vectors), the wire
  frames are pinned against the documented bytes of an independent implementation, and a
  full job runs through the real `PrinterLink` over a fake printer — including a hold and a
  packet rewind.
- The page was loaded in a real browser: no JS errors, preview pipeline runs, and the
  in-page core reproduces the reference vectors.

**The protocol has been cross-checked against hardware.** The frame layouts, handshake,
auth derivation and raster packing were verified against
[cicloid/printable](https://github.com/cicloid/printable) — an independent,
hardware-validated reimplementation of this same printer family. That cross-check found two
bugs in this project's first version (the GATT service is `0xFFE6`, and the raster packet
carries a packet *index* where we were writing a byte offset). `PROTOCOL.md` §9 records
both, because the second one would have printed one good packet and then garbage.

**Still not verified against *this* printer.** Everything above proves the two
implementations agree with each other, with the vendor app's compiled code, and with an
independent implementation on real hardware — but your unit is the final word. Two things
may still need adjusting on first contact, and neither is a protocol problem: the print
width (384 is fixed for this head) and the default density/threshold.

If it does misbehave, the ground truth is an HCI snoop log: Developer options → "Enable
Bluetooth HCI snoop log", print once with the vendor app, pull `/sdcard/btsnoop_hci.log`,
open it in Wireshark, and diff it against `cli.py dry-run`.

## Safety notes

- The printer is one-way for our purposes: the host writes when asked, and only 96-byte
  raster slices leave the machine. Nothing about you is transmitted.
- The vendor app's own analysis (permissions, SDKs, endpoints, and the cloud image
  uploads) is in the project notes; printing never needed any of it.
