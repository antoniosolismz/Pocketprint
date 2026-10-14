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

`web/index.html` — open it in **Chrome or Edge** (Android, or any Chromium desktop;
Firefox has no Web Bluetooth). Pick text, an image, or the built-in calibration sheet,
adjust darkness and dithering, watch the 1:1 preview, press Print.

It needs an HTTPS origin to use Web Bluetooth from a phone: either serve it
(`python3 -m http.server` on localhost, which counts as secure) or publish the folder to
any static host you control. There is no backend and no build step — three files.

## Desktop CLI

```bash
python3 py/funnyprint/cli.py scan                 # list nearby BLE devices
python3 py/funnyprint/cli.py info   --name LX-D   # connect, report MAC/type/auth
python3 py/funnyprint/cli.py test   --name LX-D   # print the calibration sheet
python3 py/funnyprint/cli.py text   "hello" --name LX-D
python3 py/funnyprint/cli.py image  photo.png --width 384 --threshold 120 --no-dither
python3 py/funnyprint/cli.py text   "hello" --dry-run   # no Bluetooth: dump every frame
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

- `python3 py/tests/test_all.py` — 57 checks: CRC/auth derivation, frame layouts,
  notification parsing, raster semantics, and a **complete authenticated print session
  driven against a mock printer** (challenge → app check → packet ping-pong → finalise).
- `node web/tests/conformance.mjs` — 35 checks: the JavaScript core is asserted
  **byte-identical to the Python reference** (CRC, auth, frames, raster vectors), then
  runs a full print job through the real `PrinterLink` over a fake transport and checks
  the exact wire bytes, including the 96-byte packet offsets.
- `web/index.html` was loaded in a real browser: no JS errors, the preview pipeline runs
  (384×134 dots → 6432 bytes → 67 packets), and the in-page core reproduced the Python
  vectors exactly.

**Not yet verified against the physical printer.** Everything above proves the two
implementations agree with each other and with the vendor app's compiled code; only your
printer can confirm the device agrees too. The strongest check is to capture the vendor
app's own traffic and diff it:

```bash
# on the phone: Developer options -> Enable Bluetooth HCI snoop log, print something
# with the vendor app, pull /sdcard/btsnoop_hci.log, then open it in Wireshark and
# compare against:  python3 py/funnyprint/cli.py test --dry-run
```

If the handshake fails against the real device, the first thing to look at is the
challenge/response derivation in `PROTOCOL.md` §5 — that is the only place where a wrong
guess produces a locked door rather than a garbled print.

## Safety notes

- The printer is one-way for our purposes: the host writes when asked, and only 96-byte
  raster slices leave the machine. Nothing about you is transmitted.
- The vendor app's own analysis (permissions, SDKs, endpoints, and the cloud image
  uploads) is in the project notes; printing never needed any of it.
