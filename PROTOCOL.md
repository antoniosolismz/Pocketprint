# Funny Print / Dolewa BLE thermal printer protocol (LX-D02 family)

Reverse engineered from `Funny Print_com.lailaixiong.funnyprint_20260907_40Ubz.apk`
(package `com.lailaixiong.funnyprint`, versionName 2.8.1, versionCode 20260907).

Evidence anchors are `decomp.js:<line>` (Hermes bytecode decompilation of
`assets/index.android.bundle`) or `jadx:<path>` (Java layer). Sections marked
**cross-checked** were additionally verified against `cicloid/printable`, an independent
hardware-validated reimplementation of this same printer family — see §10, which also
records the two bugs that cross-check found in the first version of this document.

---

## 1. Transport

- **BLE.** The vendor service is **`0xFFE6`** — **cross-checked**, and it is *not* the
  `0xFFE0` of the classic JDY/HM-10 module family:
  - service: `0000ffe6-0000-1000-8000-00805f9b34fb`
  - write (host → printer): `0000ffe1-…` — **write without response**
  - notify (printer → host): `0000ffe2-…`
- The APK hardcodes no UUID; it discovers characteristics by **substring match**
  (`uuid.includes('ffe1')` / `('ffe2')`, `decomp.js:563680`, `f24043`, `f24044`) and
  throws `ffe1 characteristic not found` when they are absent. Matching on those
  substrings is the portable rule.
- These printers advertise **no distinctive service UUID**, so they cannot be filtered by
  service during a scan. Discovery is: advertised local name prefix, then confirm `0xFFE1`
  and `0xFFE2` after connecting. (A browser additionally has to *declare* the service in
  `optionalServices` before it may look at it — that is a Web Bluetooth rule, not a device
  one, and forgetting it is what produced our first connection failure.)
- **MTU:** a raster packet is 100 bytes, so a single ATT write needs MTU ≥ 103.
  **cross-checked** — neither the vendor app (`requestMTU(128)`, `decomp.js:560145`) nor
  the independent implementation requests one explicitly; CoreBluetooth and Chrome
  negotiate a large MTU automatically and the printer accepts the writes. No MTU handling
  is needed on those stacks.
- The stock app base64-encodes every write (`decomp.js:564738`); raw bytes are accepted
  (our transports send raw, the independent one does too).

## 2. Device name whitelist

`allowedNames` (`decomp.js:559198`, from `setDeviceType`): `TD-11308`, `T02`, `LX-D01`,
`LX-D02`, `LX-D2`, `LX-D03`…`LX-D09`, `DL-P01`, `LX-D02-TEST`, `ITW14302`, `SWS-PT1`,
`AH-M2`, `ZH-P06`, `LX-D002`…`LX-D009`. A **`LX`** name prefix is the practical filter for
this family (`LX-D02` is a 58 mm, 203 dpi, 384-dot unit).

## 3. Frames, host → printer — **cross-checked**

Control frames begin `0x5A`; raster frames begin `0x55`, so the receiver distinguishes them
on the first byte. Lengths are exact:

| Command | Opcode | Length | Bytes |
|---|---|---|---|
| Hello | `5A 01` | 12 | `5A 01` + ten zero bytes |
| Auth challenge | `5A 0A` | 12 | `5A 0A` + 10 random bytes |
| Auth reply | `5A 0B` | 12 | `5A 0B` + 10 response bytes |
| Set density | `5A 0C` | 3 | `5A 0C <level 1..7>` |
| Print start | `5A 04` | 6 | `5A 04 <count:u16be> 00 00` |
| Raster | `55` | 100 | `55 <index:u16be> <96 bytes> 00` |
| Print end | `5A 04` | 6 | `5A 04 <count:u16be> 01 00` |

- **The raster frame carries the PACKET INDEX (0-based), not a byte offset.** The byte
  offset is `index * 96` and is used only to slice the bitmap locally. `[99]` is a constant
  `0x00` terminator — not a checksum.
- `count` is the number of raster packets, `ceil(rows / 2)`: each packet holds **two print
  lines of 48 bytes** (384 dots / 8).
- Density defaults to 3 and is sent before the job opens; it drives print energy.
- **There is no feed opcode for this model.** Paper advance is printing blank rows. (The
  stock app's `5A 03 82 …` "move paper" is only sent for "TB"-type printers,
  `decomp.js:562525`, and is not part of this protocol.)

## 4. Frames, printer → host (notifications on `0xFFE2`)

All begin `0x5A`; unknown opcodes are ignored, not fatal. **cross-checked**

| Opcode | Meaning | Fields |
|---|---|---|
| `5A 01` | hello | MAC at bytes `[4..10]` |
| `5A 02` | status | `[2]` battery %, `[3]` out of paper (inverted sense), `[4]` charging/charged, `[5]` overheat, `[6]` low battery, `[7]` density |
| `5A 03` | ready | (the stock app re-sends the print header on this) |
| `5A 04` | print result | `[4] == 1` → job closed |
| `5A 05` | **lost packet** | `[2..4]` u16be index, **1-based** — rewind and resend from `index − 1`, and clear any hold |
| `5A 06` | **finished** | `[2..4]` packet count |
| `5A 07` | cooldown | back off ~100 ms, do **not** rewind |
| `5A 08` | hold | send nothing until a `5A 05` or `5A 06` arrives |
| `5A 0A` | challenge reply | payload is junk — do not depend on it |
| `5A 0B` | auth result | `[2] == 01` ok |

### What a real LX-D02 does (observed, 2026-10-14)

From a full session on the user's own unit — test page, text, and a 341-packet photo:

- The MAC it reports is `a2ff00000098` — note the `ff00` filler. These units stamp out the
  same board; do not read anything into it.
- **`5A 02` is a heartbeat, not a reply.** It arrives unprompted every ~2 seconds for as
  long as the link is up, including while a job is streaming and while the printer is
  holding. Nothing needs to be sent in response, and it is a free battery gauge.
- Battery reads 100% while charging and only dipped to 94% after a 341-packet photo.
- **`5A 0C`, 12 bytes, is undocumented.** The printer sent it once, mid-session. It is
  handled by neither the vendor app's dispatcher (§ evidence: `process0x01/02/03/04/05/06/
  08/0a/0bResp` — there is no `0x0C`) nor the reference implementation. Ours records the
  bytes and carries on. If it ever starts arriving in bursts, that would be worth a snoop;
  once, next to a job that printed fine, it is noise.
- **A long job does hit flow control.** 160 packets: clean. 67 packets: clean. 341 packets
  (a photo): two holds and two rewinds (`lost packet 115 → 114`, `lost packet 244 → 243`)
  before finishing normally. This is the buffer filling, and it is why `0x08`/`0x05` are
  implemented rather than assumed away. See §6 for the pacing response.
- The whole photo job took ~15 s wall clock, most of it the hold/rewind pauses.

## 5. Authentication

Not a security boundary: the host issues the challenge **and** computes the answer, keyed
on the MAC the printer itself just disclosed. It is an app lock, not a secret.

```
random[10]  = 10 bytes, each randint(1,254)          # sent in the 5A 0A frame
mac_hex     = 12 lowercase hex chars from [4..10] of the 5A 01 reply

for i in 0..9:
    crc = CRC16_XMODEM(challenge[i] || mac)          # 7 bytes
    high += crc[0:2]      # first two hex nibbles  → this is what the printer wants back
    low  += crc[2:4]      # last two nibbles       → the vendor app compares the 5A 0A reply to this

send 5A 0B with high as 10 raw bytes
expect 5A 0B 01
```

- The vendor app compares the `5A 0A` payload against `low` and only then sends the reply
  (`decomp.js:563984`). **The independent implementation ignores that payload entirely and
  sends the reply regardless**, which is more robust: a format difference cannot deadlock
  the handshake. We do the same and merely log the comparison.
- A useful property (**cross-checked**): with an all-zero challenge, all ten CRC high bytes
  are identical (`crc16_xmodem(00 || mac) >> 8`), because each byte is an independent
  one-byte challenge over the same MAC. The printer accepts it — further proof the
  exchange authenticates nothing.
- The stock app's `crc16xmodem` accumulates in an unmasked 32-bit int instead of masking
  each step. Simulating it exactly (int32, sign-propagating `>>`) reproduces textbook
  CRC-16/XMODEM for every 7-byte input tested (20 000 random vectors, 0 mismatches), so a
  plain CRC-16/XMODEM is correct here.

## 6. Print sequence — **cross-checked**

```
connect → discover services (MTU negotiates itself)
  → 5A 01 hello                       ← 5A 01 with the MAC        [we know the MAC]
  → 5A 0A challenge                   ← 5A 0A (payload ignored)
  → 5A 0B auth reply                  ← 5A 0B 01                  [authenticated]
  → 5A 0C density
  → 5A 04 <count> 00 00  print start
  → 55 <index> <96B> 00  … one per packet, ~15 ms apart
      ← 5A 05 <n>   rewind to n−1 and resume   (also the resume signal after a hold)
      ← 5A 07       back off 100 ms, keep the index
      ← 5A 08       hold: send nothing
      ← 5A 06 <count>   finished
  → 5A 04 <count> 01 00  print end
```

`0x05` doubles as the resume signal after a hold. A hold is exited only by `0x05` or by
`0x06`; there is no timer-based exit — sending into a hold is what causes the overrun the
hold exists to prevent. Inter-packet delay recommendations: 15 ms.

One rule we added after watching a real 341-packet job stall twice: **a hold means the
buffer was full, so resume that job more slowly rather than at the same rate.** We grow the
inter-packet delay by 1.5× on each hold, capped at 60 ms, and reset it when the next job
opens. Without it, a long photo holds, rewinds, catches up, and holds again every couple of
hundred packets — which is what the log above shows happening twice before we changed it.

## 7. Raster format

From the Java module `cn.lailaixiong.funnyprint.util.ImageUtil` (and **cross-checked**):

- **384 dots/row → 48 bytes/row**, **MSB first** (bit 7 = leftmost pixel), **1 = black**,
  zero-padded when the height is odd. Two rows per raster packet.
- `bitmapToBinaryBuffer(bitmap, threshold)` (`ImageUtil.java:273`) takes the **red channel**
  as luminance and packs continuously across the image with **no per-row padding** — keep
  the width a multiple of 8 (384) and the two agree trivially.
- `ditherImageToBinaryBuffer(bitmap, threshold=128)` (`ImageUtil.java:174`) is
  grayscale → Floyd–Steinberg (7/3/5/1 kernel, error clamped 0..255) → same packing.
- `scaleAndCropImage` uses `filterBitmap=false` (nearest neighbour), centre-cropped.

## 8. What printing actually needs

The whole local path is BLE only. No server call is required to print. (The stock app also
talks to `api.dolewa.com`, `img.dolewa.com`, `img.lailaixiong.com.cn` and
`laixueimg.huyosy.com` for accounts, templates and cloud image processing — none of it
involved in driving the printer.)

## 9. Why the first version of this document was wrong

Two mistakes, both caught by cross-checking against `cicloid/printable`:

1. **Service UUID.** The first version guessed the write characteristic (`0xFFE1`) but
   never established the service, and shipped a candidate list that omitted `0xFFE6`. Web
   Bluetooth may only touch a service the page has declared, so every lookup failed and the
   connection died with `GATT Error: Not supported`. **Symptom to remember:** that error at
   connect time on this printer family means "the service you asked for is not there", not
   "Bluetooth is broken".
2. **Raster packet field.** The first version wrote the byte offset (`index * 96`) into the
   raster frame. The device expects the packet **index**. Packet 0 looked identical either
   way, so the handshake and the first packet would have succeeded and everything after it
   would have been garbage — the worst kind of bug to find on hardware.

Everything else in the earlier reading (frame magics, the handshake, the auth derivation,
the raster packing) was confirmed byte for byte by the independent implementation.
