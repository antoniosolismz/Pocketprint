/* Funny Print companion — protocol + raster core.
 *
 * Reverse engineered from com.lailaixiong.funnyprint 2.8.1 (see ../PROTOCOL.md).
 * Plain script (no ES module syntax) so it loads from file://, http:// and Node alike.
 *
 * Nothing in here talks to any server. There is no analytics, no account, no storage.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FunnyPrint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAGIC_CMD = 0x5a;
  const MAGIC_DATA = 0x55;
  const CMD_LEN = 12;
  const DATA_PACKET_LEN = 100;
  const PAYLOAD_LEN = 96;

  const CMD = { HW_INFO: 0x01, MOVE_PAPER: 0x03, PRINT_STATUS: 0x04, HANDSHAKE: 0x0a, APP_CHECK: 0x0b };
  const RESP = {
    HW_INFO: 0x01, READY: 0x03, PRINT_RESULT: 0x04, REQ_PACKET: 0x05,
    PRINT_END: 0x06, PAUSE: 0x08, HANDSHAKE: 0x0a, APP_CHECK: 0x0b
  };

  /* ---------------------------------------------------------------- crc */

  function crc16Xmodem(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 8;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* Derive the two 10-byte CRCs the printer challenge/response needs.
   * Matches the app's checkCrc(): per challenge byte, CRC16-XMODEM over
   * (byte || mac), first two nibbles -> highCrc, last two -> lowCrc. */
  function deriveCrcs(challenge, macHex) {
    const mac = hexToBytes(macHex);
    let low = '', high = '';
    for (let i = 0; i < challenge.length; i++) {
      const msg = new Uint8Array(1 + mac.length);
      msg[0] = challenge[i];
      msg.set(mac, 1);
      const h = crc16Xmodem(msg).toString(16).toUpperCase().padStart(4, '0');
      high += h.substring(0, 2);
      low += h.substring(2, 4);
    }
    return { low, high };
  }

  /* ------------------------------------------------------------- frames */

  function cmdFrame(cmd, payload) {
    const body = new Uint8Array(CMD_LEN);
    body[0] = MAGIC_CMD;
    body[1] = cmd;
    if (payload) body.set(payload, 2);
    return body;
  }

  const frames = {
    hardwareInfo: () => cmdFrame(CMD.HW_INFO),
    handshake: (challenge) => cmdFrame(CMD.HANDSHAKE, challenge),
    appCheck: (highCrcHex) => cmdFrame(CMD.APP_CHECK, hexToBytes(highCrcHex)),
    movePaper: (distance = 3) => cmdFrame(CMD.MOVE_PAPER, Uint8Array.from([0x82, 0x00, distance & 0xff, 0x00, 0x00])),
    printStatus: (totalPkg, flag, printNum) =>
      cmdFrame(CMD.PRINT_STATUS, Uint8Array.from([(totalPkg >> 8) & 0xff, totalPkg & 0xff, flag & 0xff, printNum & 0xff])),
    data: (offset, payload) => {
      const out = new Uint8Array(DATA_PACKET_LEN);
      out[0] = MAGIC_DATA;
      out[1] = (offset >> 8) & 0xff;
      out[2] = offset & 0xff;
      out.set(payload, 3);
      return out;
    }
  };

  function alignRaster(raster) {
    const rem = raster.length % PAYLOAD_LEN;
    if (!rem) return raster;
    const out = new Uint8Array(raster.length + (PAYLOAD_LEN - rem));
    out.set(raster);
    return out;
  }

  function parseNotification(raw) {
    if (!raw || raw.length < 2 || raw[0] !== MAGIC_CMD) return null;
    const d = raw;
    return {
      cmd: d[1],
      raw: d,
      mac: bytesToHex(d.slice(4, 10)),
      deviceType: d.length > 10 ? d[10] : 0,
      packetIndex: d.length >= 4 ? (d[2] << 8) | d[3] : 0,
      handshakeReply: bytesToHex(d.slice(2, 12)).toUpperCase(),
      appCheckOk: d.length > 2 && d[2] === 0x01,
      printEnd: { total: d.length >= 4 ? (d[2] << 8) | d[3] : 0, count: d.length > 4 ? d[4] : 0 },
      printResultFlag: d.length > 4 ? d[4] : 0,
      ready: d[1] === RESP.READY
    };
  }

  /* ------------------------------------------------------------ session */

  class PrinterSession {
    constructor(rng) {
      this.rng = rng || Math.random;
      this.reset();
    }

    reset() {
      this.challenge = null;
      this.mac = '';
      this.deviceType = 0;
      this.lowCrc = '';
      this.highCrc = '';
      this.authenticated = false;
      this.raster = null;
      this.totalPkg = 0;
      this.printNum = 1;
      this.jobOpen = false;
      this.jobDone = false;
      this.packetsSent = 0;
      this.log = [];
    }

    _challenge() {
      const c = new Uint8Array(10);
      for (let i = 0; i < 10; i++) c[i] = 1 + Math.floor(this.rng() * 254);
      return c;
    }

    begin() {
      return [frames.hardwareInfo()];
    }

    startPrint(raster, copies = 1) {
      if (!this.authenticated) throw new Error('printer not authenticated');
      this.raster = alignRaster(raster);
      this.totalPkg = Math.ceil(this.raster.length / PAYLOAD_LEN);
      this.printNum = Math.max(1, copies | 0);
      this.jobOpen = true;
      this.jobDone = false;
      this.packetsSent = 0;
      return [frames.printStatus(this.totalPkg, 0, this.printNum)];
    }

    packetFor(index) {
      const offset = index * PAYLOAD_LEN;
      return frames.data(offset, this.raster.subarray(offset, offset + PAYLOAD_LEN));
    }

    handle(raw) {
      const note = parseNotification(raw);
      if (!note) {
        this.log.push('ignored frame ' + bytesToHex(raw || new Uint8Array()).slice(0, 20));
        return [];
      }
      switch (note.cmd) {
        case RESP.HW_INFO: {
          this.mac = note.mac;
          this.deviceType = note.deviceType;
          this.challenge = this._challenge();
          const { low, high } = deriveCrcs(this.challenge, this.mac);
          this.lowCrc = low;
          this.highCrc = high;
          this.log.push(`device mac=${this.mac} type=${this.deviceType}`);
          return [frames.handshake(this.challenge)];
        }
        case RESP.HANDSHAKE: {
          if (note.handshakeReply === this.lowCrc) {
            this.log.push('challenge verified');
            return [frames.appCheck(this.highCrc)];
          }
          this.log.push('challenge mismatch, retrying');
          this.challenge = this._challenge();
          const { low, high } = deriveCrcs(this.challenge, this.mac);
          this.lowCrc = low;
          this.highCrc = high;
          return [frames.handshake(this.challenge)];
        }
        case RESP.APP_CHECK: {
          this.authenticated = note.appCheckOk;
          this.log.push('app check ' + (this.authenticated ? 'ok' : 'FAILED'));
          return [];
        }
        case RESP.REQ_PACKET: {
          const index = note.packetIndex - 1;
          if (index < 0 || index >= this.totalPkg) {
            this.log.push(`device asked for packet ${note.packetIndex}, out of range`);
            return [];
          }
          this.packetsSent++;
          this.log.push(`sending packet ${index + 1}/${this.totalPkg}`);
          return [this.packetFor(index)];
        }
        case RESP.PRINT_END: {
          this.log.push(`print end (device total=${note.printEnd.total}, ours=${this.totalPkg})`);
          this.jobDone = true;
          this.jobOpen = false;
          return [frames.printStatus(this.totalPkg, 1, this.printNum)];
        }
        case RESP.PRINT_RESULT: {
          if (note.printResultFlag === 1) {
            this.log.push('device reports job finished');
            this.jobDone = true;
            this.jobOpen = false;
          }
          return [];
        }
        case RESP.READY: {
          if (this.raster && !this.jobDone) {
            this.jobOpen = true;
            return [frames.printStatus(this.totalPkg, 0, this.printNum)];
          }
          return [];
        }
        case RESP.PAUSE:
          this.log.push('device paused');
          return [];
        default:
          this.log.push('unhandled command 0x' + note.cmd.toString(16));
          return [];
      }
    }
  }

  /* ------------------------------------------------------------- raster */

  const DITHER_KERNEL = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];

  /* pixels: Uint8Array (or array) of luminance, length w*h. 1 = black. */
  function floydSteinberg(pixels, w, h, threshold) {
    const buf = Uint8Array.from(pixels);
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = buf[i];
        const next = old < threshold ? 0 : 255;
        bits[i] = next === 0 ? 1 : 0;
        const err = old - next;
        for (let k = 0; k < DITHER_KERNEL.length; k++) {
          const [dx, dy, factor] = DITHER_KERNEL[k];
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          buf[j] = Math.max(0, Math.min(255, buf[j] + ((err * factor) / 16 | 0)));
        }
      }
    }
    return bits;
  }

  function thresholdBits(pixels, w, h, threshold) {
    const bits = new Uint8Array(w * h);
    for (let i = 0; i < pixels.length; i++) bits[i] = pixels[i] < threshold ? 1 : 0;
    return bits;
  }

  /* MSB-first, packed continuously across the image (no per-row padding),
   * exactly like ImageUtil.booleanArrayToBinaryBuffer. */
  function packBits(bits) {
    const out = new Uint8Array((bits.length + 7) >> 3);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) out[i >> 3] |= 1 << (7 - (i % 8));
    }
    return out;
  }

  function rasterize(pixels, w, h, opts) {
    const o = Object.assign({ width: w, threshold: 128, dither: true }, opts || {});
    const bits = o.dither ? floydSteinberg(pixels, w, h, o.threshold)
                          : thresholdBits(pixels, w, h, o.threshold);
    return packBits(bits);
  }

  /* --------------------------------------------------- BLE transport */

  /* Device name prefixes the stock app whitelists (PROTOCOL.md §2). */
  const NAME_PREFIXES = ['LX-D', 'DL-P', 'DL-T', 'ZH-P', 'TD-1', 'T02', 'ITW', 'SWS-', 'AH-M'];

  /* 16-bit services expanded to full UUIDs. The device is anonymous about its own
   * service (the stock app never hardcodes one either), so offer the plausible set:
   * Web Bluetooth only grants access to services declared here. */
  const SERVICE_CANDIDATES = [
    0xffe0, 0xffe5, 0xffe9, 0xff00, 0xff10, 0xff20, 0xff30, 0xff90, 0xfff0, 0xfff1, 0xfff5,
    0xfee0, 0xfee7, 0xfe00, 0x1800, 0x1801, 0x180a, 0x180f
  ].map((s) => '0000' + s.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb');

  const errText = (e) => (e && (e.message || e.name)) || String(e);

  function bleAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  class BleTransport {
    constructor(log) {
      this.log = log || (() => {});
      this.device = null;
      this.server = null;
      this.writeChar = null;
      this.notifyChar = null;
      this.serviceUuid = null;
      this.onData = null;
      this.disconnected = false;   // set before an intentional disconnect
    }

    async connect(opts) {
      if (!bleAvailable()) throw new Error('Web Bluetooth is not available in this browser');
      const showAll = !!(opts && opts.showAll);
      const request = {
        /* Declared up front: Web Bluetooth only grants access to services named
         * here, so the printer's service has to be in this list to be reachable. */
        optionalServices: SERVICE_CANDIDATES
      };
      if (showAll) {
        request.acceptAllDevices = true;
      } else {
        request.filters = NAME_PREFIXES.map((p) => ({ namePrefix: p }));
      }
      const device = await navigator.bluetooth.requestDevice(request);
      return this._attach(device);
    }

    async _attach(device) {
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => {
        if (!this.disconnected) this.log('device disconnected');
      });
      this.server = await device.gatt.connect();
      let found = null;
      for (const uuid of SERVICE_CANDIDATES) {
        try {
          found = await this.server.getPrimaryService(uuid);
          if (found) break;
        } catch (e) { /* not this one */ }
      }
      if (!found) {
        const all = await this.server.getPrimaryServices();
        this.log(`service not in the known list; granted services: ${all.map((s) => s.uuid).join(', ') || 'none'}`);
        found = all.find((s) => s.uuid.toLowerCase().indexOf('ffe0') !== -1) || all[0];
      }
      if (!found) throw new Error('no accessible service found on this device');
      this.service = found;
      const chars = await found.getCharacteristics();
      this.log('service ' + found.uuid + ' with ' + chars.length + ' characteristic(s)');
      for (const c of chars) {
        const u = c.uuid.toLowerCase();
        if (!this.writeChar && u.indexOf('ffe1') !== -1) this.writeChar = c;
        if (!this.notifyChar && u.indexOf('ffe2') !== -1) this.notifyChar = c;
      }
      if (!this.writeChar) this.writeChar = chars.find((c) => c.properties.writeWithoutResponse) || chars[0];
      if (!this.notifyChar) this.notifyChar = chars.find((c) => c.properties.notify || c.properties.indicate)
        || chars.find((c) => c !== this.writeChar);
      if (!this.writeChar) throw new Error('no write characteristic found');
      this.serviceUuid = found.uuid;
      this.log(`write char ${this.writeChar.uuid}, notify char ${this.notifyChar ? this.notifyChar.uuid : 'none'}`);
      if (this.notifyChar) {
        this.notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
          const view = ev.target.value;
          const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          if (this.onData) this.onData(bytes);
        });
        await this.notifyChar.startNotifications();
      }
      return device;
    }

    async write(bytes) {
      if (!this.writeChar) throw new Error('not connected');
      /* Web Bluetooth has no writeWithoutResponse-only path when the char lacks
       * that property, so prefer the faster one when present. */
      if (this.writeChar.properties.writeWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(bytes);
      } else {
        await this.writeChar.writeValue(bytes);
      }
    }

    async disconnect() {
      this.disconnected = true;
      try {
        if (this.notifyChar) await this.notifyChar.stopNotifications();
      } catch (e) { /* ignore */ }
      try {
        if (this.server && this.server.connected) this.server.disconnect();
      } catch (e) { /* ignore */ }
    }
  }

  /* Web Bluetooth takes raw bytes; the printer accepts them raw, so unlike the
   * stock app (which base64-encodes every write) no encoding is needed here. */

  /* ---------------------------------------------------------- link */

  class PrinterLink {
    constructor(transport, opts) {
      this.transport = transport;
      this.session = new PrinterSession((opts && opts.rng) || Math.random);
      this.log = (opts && opts.log) || (() => {});
      this.ready = false;
      this.printDone = false;
      this.transport.onData = (bytes) => this._onData(bytes);
    }

    async connect() {
      await this.transport.connect();
      this.log(this.transport.device ? 'connected to ' + (this.transport.device.name || 'device') : 'connected');
      for (const frame of this.session.begin()) await this._write(frame);
      return this.session;
    }

    _onData(bytes) {
      let out = [];
      try {
        out = this.session.handle(bytes);
      } catch (e) {
        this.log('error handling frame: ' + errText(e));
        return;
      }
      for (const line of this.session.log.splice(0)) this.log(line);
      this.authenticated = this.session.authenticated;
      (async () => {
        for (const frame of out) {
          await this._write(frame);
          if (frame[0] === 0x5a && frame[1] === CMD.PRINT_STATUS && frame[4] === 1) {
            this.printDone = true;
            this.log('job finalised');
          }
        }
      })().catch((e) => this.log('write failed: ' + errText(e)));
    }

    async _write(frame) {
      await this.transport.write(frame);
    }

    async print(raster, copies = 1) {
      this.printDone = false;
      const out = this.session.startPrint(raster, copies);
      for (const frame of out) await this._write(frame);
      this.log(`print job opened: ${this.session.totalPkg} packet(s), ${this.session.raster.length} bytes`);
      return this.session;
    }

    /* Every write is logged here when a debug sink is present: useful to diff
     * against an HCI snoop capture of the stock app. */
  }

  return {
    MAGIC_CMD, MAGIC_DATA, CMD, RESP, PAYLOAD_LEN, DATA_PACKET_LEN,
    crc16Xmodem, deriveCrcs, hexToBytes, bytesToHex,
    frames, alignRaster, parseNotification,
    PrinterSession, PrinterLink, BleTransport, bleAvailable,
    floydSteinberg, thresholdBits, packBits, rasterize
  };
});
