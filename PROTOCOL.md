# Funny Print / Dolewa BLE thermal printer protocol

Reverse engineered from `Funny Print_com.lailaixiong.funnyprint_20260907_40Ubz.apk`
(package `com.lailaixiong.funnyprint`, versionName 2.8.1, versionCode 20260907).

Every claim below is derived from the app's own code, not from guesswork. Evidence
anchors are given as `decomp.js:<line>` (Hermes bytecode decompilation of
`assets/index.android.bundle`) or `jadx:<path>` (Java layer).

---

## 1. Transport

- **BLE**, discovered by the app at connect time (no hardcoded UUIDs anywhere in the APK —
  verified: the only UUID-shaped strings in the bundle are iOS simulator container paths).
- Characteristic selection is **substring matching on the UUID**
  (`decomp.js:563680` / `f24043`, `f24044`):
  - write target: first characteristic whose lowercase UUID **contains `ffe1`**
  - notify source: first characteristic whose lowercase UUID **contains `ffe2`**
  - If either is missing the app throws `ffe1 characteristic not found` /
    `ffe2 characteristic not found` (`decomp.js:560444`).
- MTU is requested as **128** after services are discovered (`decomp.js:560120`).
- **All writes are `writeCharacteristicWithoutResponseForDevice`, with the payload
  base64-encoded** (`decomp.js:564738`, method `sendData`).
- Notifications arrive base64-encoded; the app decodes with `Buffer.from(value,'base64')`
  (`decomp.js:559019`).

## 2. Device name whitelist

`allowedNames` (`decomp.js:559198`, from `setDeviceType`):

```
TD-11308, T02, LX-D01, LX-D02, LX-D2, LX-D03, LX-D3, LX-D04, LX-D4, LX-D05, LX-D5,
LX-D06, LX-D6, LX-D07, LX-D7, LX-D08, LX-D8, LX-D09, LX-D9, DL-P01, LX-D02-TEST,
ITW14302, SWS-PT1, AH-M2, ZH-P06, LX-D002, LX-D003, LX-D004, LX-D005, LX-D006,
LX-D007, LX-D008, LX-D009
```

A secondary list (`checkWhiteList`) is the subset up to `AH-M2`. Device *type* is taken
from the hardware-info response, not the name (`decomp.js:563687`).

## 3. Frame format, host → printer

Command frames are **fixed 12 bytes**, magic **`0x5A`** at `[0]`, command at `[1]`
(`decomp.js:563455` = `sendHandshake`, `563380` = `sendAPPCheck`, etc.).

| cmd | name | bytes |
|-----|------|-------|
| `0x0A` | handshake | `5A 0A [10 random bytes 1..254]` |
| `0x0B` | app check | `5A 0B [highCrc 10 bytes]` |
| `0x01` | hardware info request | `5A 01` + 10 zero bytes |
| `0x03` | move paper / start | `5A 03 82 00 03 00 00` + 5 zero bytes |
| `0x04` | print status header | `5A 04 [totalPkg u16 BE] [flag] [printNum] ` + 6 zero bytes |

- `totalPkg` = `ceil(len(mainBuffer) / 96)` (`decomp.js:562929`).
- `flag` = `0` to open a print job (`decomp.js:562993`), `1` to finalise/abort it
  (`endPrint` `decomp.js:562736`, `cancelPrint` `decomp.js:562680`).
- `printNum` = copies; the app sends 1 for the normal single-print path.
- `0x03` is only sent for "TB" printer types (`decomp.js:562525`), otherwise the app
  goes straight to `innerPrint` (the `0x04` frame).

### Data frames — 100 bytes, magic `0x55`

```
55 [offset u16 BE] [96 bytes of raster data] 00
```

`offset = packetIndex * 96`, taken from the printer's own request index
(`decomp.js:563415`–`563459`). The 96-byte payload is **uncompressed 1-bit raster**,
straight out of `mainBuffer`. `mainBuffer` is zero-padded to a multiple of 96 before
sending (`alignMainBuffer`, `decomp.js:562826`).

## 4. Frame format, printer → host

`[0] == 0x5A` required, then command at `[1]` (`decomp.js:559026`), dispatched via a
jump table over 1..11 (`decomp.js:559031`).

| cmd | meaning | parsed fields |
|-----|---------|---------------|
| `0x01` | hardware info | `[4..9]` = MAC (6 bytes, `decomp.js:563662`), `[10]` = deviceType (`decomp.js:563683`) |
| `0x03` | printer ready for data | → app calls `innerPrint` / re-sends `0x04` (`decomp.js:564141`) |
| `0x04` | print job result | `[4] == 1` → job done, state → Idle (`decomp.js:564270`–`564294`) |
| `0x05` | **request packet N** | `[2..3]` = u16 BE, **1-based**; app sets `sentPkg = N - 1` (`decomp.js:564315`) |
| `0x06` | print end | `[2..3]` = totalPkg echo, `[4]` = respCount (`decomp.js:564363`) |
| `0x08` | pause | → state Paused (`decomp.js:564413`) |
| `0x0A` | handshake reply | `[2..11]` must equal the app's `lowCrc` (`decomp.js:563977`) |
| `0x0B` | app check result | `[2]` = `01` success / `00` fail (`decomp.js:564029`) |

## 5. Authentication (challenge / response)

Not real security — a fixed algorithm both sides run, keyed on the MAC the printer
itself discloses in the `0x01` reply. Implemented in `checkCrc` (`decomp.js:565137`).

```
random[10]              = 10 bytes, each randint(1,254)          # sent in the 0x0A frame
mac_hex                 = 12 lowercase hex chars from [4..9] of 0x01 reply

for i in 0..9:
    msg  = hex2(random[i]) + mac_hex          # 7 bytes
    crc  = CRC16_XMODEM(msg)
    h    = crc.to_hex().padStart(4,'0').upper()
    lowCrc  += h[2:4]      # last two nibbles
    highCrc += h[0:2]      # first two nibbles

expect 0x0A reply [2..11].hex().upper() == lowCrc   # printer proves it knows the MAC
then send 0x0B with highCrc as 10 raw bytes         # app proves it knows the MAC
expect 0x0B reply [2] == 0x01
```

> Note on the CRC: the app's `crc16xmodem` accumulates in an unmasked 32-bit int rather
> than masking to 16 bits per step. Simulating it exactly (int32, `>>` sign-propagating)
> reproduces textbook CRC-16/XMODEM results for every 7-byte input tested (20 000 random
> vectors, 0 mismatches), so a plain CRC-16/XMODEM implementation is correct here.
> The accumulator stays below 2^31 for this input length.

## 6. Print sequence

```
connect → discover services (MTU 128)
  → 0x01 hardware info request           ← MAC + deviceType
  → 0x0A handshake (10 random bytes)     ← 0x0A lowCrc  (verify)  → 0x0B app check
                                         ← 0x0B result 0x01
                                             [state = Idle, ready]

print(config):
  raster  = 1-bit bitmap, base64         (see §7)
  totalPkg = ceil(len(raster)/96)
  → 0x04 {totalPkg, flag=0, printNum}
  ← 0x05 request N     (repeat)          → 0x55 data frame for packet N-1
  ← 0x06 print end {totalPkg, respCount}
  → 0x04 {totalPkg, flag=1, printNum}    ← 0x04 [4]==1  → Idle
```

Flow control is strict ping-pong: the printer asks for packet N, the host sends exactly
that packet and nothing more. `PRINT_TIMEOUT` in the app is 15000 ms.

## 7. Raster format

Produced by the Java module `cn.lailaixiong.funnyprint.util.ImageUtil`
(`jadx:.../util/ImageUtil.java`):

- `bitmapToBinaryBuffer(bitmap, threshold)` — `ImageUtil.java:273`
  - takes the **red channel** as luminance,
  - **1 = black** (`red < threshold`),
  - **MSB-first bit packing, continuous across the whole image** (no per-row byte
    padding — so the width should be a multiple of 8),
  - no header, no per-row length prefix.
- `ditherImageToBinaryBuffer(bitmap, threshold=128)` — `ImageUtil.java:174`
  - grayscale extract → Floyd–Steinberg dithering → same packing → base64.
  - Diffusion is the classic 7/3/5/1 / 16 kernel with error clamped to 0..255
    (`ImageUtil.java:230`–`262`).
- `scaleAndCropImage` uses `filterBitmap=false` (nearest-neighbour) for crisp text,
  centre-cropped to the target height (`ImageUtil.java:57`).

Print width is supplied by JS at call time, not fixed in the constants; the stock app's
templates use 50 mm paper, which at 203 dpi is 400 dots — but this family ships 384-dot
and 576-dot models too. Treat width as a per-device setting (see README calibration).

## 8. Through this stick, nothing else is needed

The whole local printing path is BLE-only. No server call is required to print — the
protocol above is complete. (The stock app additionally talks to `api.dolewa.com`,
`img.dolewa.com`, `img.lailaixiong.com.cn` and `laixueimg.huyosy.com`; that traffic is
about accounts, templates and cloud image processing, not about driving the printer.)
