/* Pocket Print — protocol + raster core for the LX-D02 / FunnyPrint family.
 *
 * Reverse engineered from com.lailaixiong.funnyprint 2.8.1 (see ../PROTOCOL.md), then
 * cross-checked against cicloid/printable, a hardware-validated reimplementation of the
 * same printer family. That cross-check caught two bugs in this file: the GATT service
 * is 0xFFE6 (not 0xFFE0), and the raster packet carries a *packet index* where this file
 * was writing a byte offset. It also confirmed the MTU is not a problem — Chrome
 * negotiates a large one automatically.
 *
 * Plain script (no ES module syntax) so it loads from file://, http:// and Node alike.
 * Nothing here talks to any server. No analytics, no account, no storage.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FunnyPrint = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAGIC_CMD = 0x5a;
  const MAGIC_DATA = 0x55;
  const DATA_PACKET_LEN = 100;
  const PAYLOAD_LEN = 96;        // two print lines of 48 bytes
  const LINE_BYTES = 48;         // 384 dots / 8
  const WIDTH = 384;             // fixed by the print head

  const CMD = { HELLO: 0x01, PRINT_START: 0x04, CHALLENGE: 0x0a, AUTH_REPLY: 0x0b, SET_DENSITY: 0x0c };
  const RESP = {
    HELLO: 0x01, STATUS: 0x02, READY: 0x03, PRINT_RESULT: 0x04, LOST_PACKET: 0x05,
    FINISHED: 0x06, COOLDOWN: 0x07, HOLD: 0x08, CHALLENGE_REPLY: 0x0a, AUTH_RESULT: 0x0b
  };
  const COOLDOWN_MS = 100;       // back off after 0x07
  const INTER_PACKET_MS = 15;    // recommended pause between raster sends
  const JOB_TIMEOUT_MS = 30000;  // our watchdog

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

  /* The printer tells us its MAC, then we prove we saw it: per challenge byte,
   * CRC16-XMODEM over (byte || mac). high = the byte the printer wants back. */
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

  const frames = {
    /* 5A 01 + ten zero bytes */
    hello: () => Uint8Array.from([MAGIC_CMD, CMD.HELLO, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    /* 5A 0A + 10 challenge bytes */
    challenge: (bytes) => {
      const f = new Uint8Array(12);
      f[0] = MAGIC_CMD; f[1] = CMD.CHALLENGE; f.set(Uint8Array.from(bytes).subarray(0, 10), 2);
      return f;
    },
    /* 5A 0B + 10 response bytes */
    authReply: (bytes) => {
      const f = new Uint8Array(12);
      f[0] = MAGIC_CMD; f[1] = CMD.AUTH_REPLY; f.set(Uint8Array.from(bytes).subarray(0, 10), 2);
      return f;
    },
    /* 5A 0C <level>, three bytes */
    density: (level) => Uint8Array.from([MAGIC_CMD, CMD.SET_DENSITY, (level & 0xff)]),
    /* 5A 04 <count:u16be> <flag> 00, six bytes. flag 0 opens a job, 1 closes it. */
    printStatus: (total, flag) => Uint8Array.from([
      MAGIC_CMD, CMD.PRINT_START, (total >> 8) & 0xff, total & 0xff, flag & 0xff, 0x00
    ]),
    /* 55 <index:u16be> <96 bytes> 00, always 100 bytes.
     * The u16 is the PACKET INDEX (0-based), not a byte offset — the byte offset is
     * index * 96 and is only used to slice the raster locally. */
    data: (index, payload) => {
      const out = new Uint8Array(DATA_PACKET_LEN);
      out[0] = MAGIC_DATA;
      out[1] = (index >> 8) & 0xff;
      out[2] = index & 0xff;
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
    const u16 = (d.length >= 4) ? (d[2] << 8) | d[3] : 0;
    return {
      cmd: d[1],
      length: d.length,
      raw: d,
      mac: bytesToHex(d.slice(4, 10)),
      battery: d.length > 2 ? d[2] : 0,
      noPaper: d.length > 3 && d[3] !== 0,
      charging: d.length > 4 && d[4] === 1,
      charged: d.length > 4 && d[4] === 2,
      overheat: d.length > 5 && d[5] !== 0,
      lowBattery: d.length > 6 && d[6] !== 0,
      density: d.length > 7 ? d[7] : 0,
      packetIndex: u16,
      finishedCount: u16,
      handshakeReply: bytesToHex(d.slice(2, 12)).toUpperCase(),
      authOk: d.length > 2 && d[2] === 0x01,
      printResultFlag: d.length > 4 ? d[4] : 0
    };
  }

  /* ------------------------------------------------------------ session */

  /* Protocol brain: pure, no I/O and no timers, so it is testable in Node and the
   * clock lives in one place (PrinterLink). */
  class PrinterSession {
    constructor(rng) {
      this.rng = rng || Math.random;
      this.reset();
    }

    reset() {
      this.challenge = null;
      this.mac = '';
      this.lowCrc = '';
      this.highCrc = '';
      this.authenticated = false;
      this.raster = null;
      this.totalPkg = 0;
      this.cursor = 0;           // next packet index to send
      this.finished = false;     // printer reported 0x06
      this.jobDone = false;      // job closed
      this.hold = false;         // 0x08: send nothing until 0x05 or 0x06
      this.cooldownUntil = 0;    // 0x07: back off
      this.density = 3;
      this.interPacketMs = INTER_PACKET_MS;  // raised when the printer tells us to hold
      this.status = null;
      this.lastAuthCheck = null; // whether the 0x0A payload matched our lowCrc
      this.log = [];
    }

    _newChallenge() {
      const c = new Uint8Array(10);
      for (let i = 0; i < 10; i++) c[i] = 1 + Math.floor(this.rng() * 254);
      return c;
    }

    begin() {
      return [frames.hello()];
    }

    /* Open a job: optional density, then print start. */
    startJob(raster, opts) {
      if (!this.authenticated) throw new Error('printer not authenticated');
      const o = opts || {};
      this.raster = alignRaster(raster);
      this.totalPkg = Math.ceil(this.raster.length / PAYLOAD_LEN);
      this.cursor = 0;
      this.finished = false;
      this.jobDone = false;
      this.hold = false;
      this.cooldownUntil = 0;
      this.density = o.density || 3;
      const out = [];
      if (o.density) out.push(frames.density(this.density));
      out.push(frames.printStatus(this.totalPkg, 0));
      this.log.push(`job open: ${this.totalPkg} packet(s), density ${this.density}`);
      return out;
    }

    /* Next raster frame, or null while holding / cooling down / finished. */
    nextStreamFrame(now) {
      if (this.jobDone || this.finished || this.hold) return null;
      if (now !== undefined && now < this.cooldownUntil) return null;
      if (this.cursor >= this.totalPkg) return null;
      const index = this.cursor;
      const offset = index * PAYLOAD_LEN;
      this.cursor++;
      return frames.data(index, this.raster.subarray(offset, offset + PAYLOAD_LEN));
    }

    finishFrames() {
      if (this.jobDone) return [];
      this.jobDone = true;
      return [frames.printStatus(this.totalPkg, 1)];
    }

    /* Blank rows are how this printer advances paper: there is no feed opcode. */
    blankRaster(rows) {
      return new Uint8Array(rows * LINE_BYTES);
    }

    handle(raw, now) {
      const note = parseNotification(raw);
      if (!note) {
        this.log.push('ignored frame ' + bytesToHex(raw || new Uint8Array()).slice(0, 24));
        return [];
      }
      switch (note.cmd) {
        case RESP.HELLO: {
          this.mac = note.mac;
          this.challenge = this._newChallenge();
          const { low, high } = deriveCrcs(this.challenge, this.mac);
          this.lowCrc = low;
          this.highCrc = high;
          this.log.push(`device mac=${this.mac}`);
          return [frames.challenge(this.challenge)];
        }
        case RESP.CHALLENGE_REPLY: {
          /* The reply payload is undocumented; the vendor app compares it against its
           * low CRC, a validated implementation ignores it. We record the comparison
           * but send the answer either way, so a format difference cannot deadlock. */
          const got = bytesToHex(new Uint8Array(raw).slice(2, 12)).toUpperCase();
          this.lastAuthCheck = (got === this.lowCrc);
          this.log.push('challenge reply' + (this.lastAuthCheck ? ' matched lowCrc' : ' payload differs, continuing'));
          return [frames.authReply(hexToBytes(this.highCrc))];
        }
        case RESP.AUTH_RESULT: {
          this.authenticated = note.authOk;
          this.log.push('auth ' + (this.authenticated ? 'ok' : 'FAILED'));
          return [];
        }
        case RESP.STATUS: {
          this.status = {
            battery: note.battery, noPaper: note.noPaper, charging: note.charging,
            charged: note.charged, overheat: note.overheat, lowBattery: note.lowBattery,
            density: note.density
          };
          this.log.push(`status: battery ${note.battery}%` +
            (note.noPaper ? ' · OUT OF PAPER' : '') +
            (note.charging ? ' · charging' : '') +
            (note.overheat ? ' · too hot' : '') +
            (note.lowBattery ? ' · low battery' : ''));
          return [];
        }
        case RESP.LOST_PACKET: {
          const target = Math.max(0, note.packetIndex - 1);
          this.log.push(`lost packet ${note.packetIndex} → rewinding to ${target}`);
          this.cursor = target;
          this.hold = false;
          return [];
        }
        case RESP.FINISHED: {
          this.log.push(`printer finished (${note.finishedCount} packet(s))`);
          this.finished = true;
          this.hold = false;
          return [];
        }
        case RESP.COOLDOWN: {
          this.cooldownUntil = (now === undefined ? Date.now() : now) + COOLDOWN_MS;
          this.log.push('cooldown: backing off 100 ms');
          return [];
        }
        case RESP.HOLD: {
          this.hold = true;
          /* A hold means the printer's buffer is full. Resuming at the same rate just
           * fills it again, which is how a long photo job ends up stalling every few
           * hundred packets. Back off for the rest of this job, capped so it cannot
           * crawl: this is deliberately per-job, not permanent. */
          if (this.interPacketMs < 60) {
            this.interPacketMs = Math.min(Math.round(this.interPacketMs * 1.5), 60);
            this.log.push(`printer asked us to hold → pacing ${this.interPacketMs} ms`);
          } else {
            this.log.push('printer asked us to hold');
          }
          return [];
        }
        case RESP.PRINT_RESULT: {
          if (note.printResultFlag === 1) {
            this.log.push('job closed by the printer');
            this.jobDone = true;
          }
          return [];
        }
        case RESP.READY:
          this.log.push('printer ready');
          return [];
        default:
          /* The printer sends frames neither the vendor app's dispatcher nor the
           * reference implementation recognises (an 12-byte 0x0C shows up in the wild).
           * Record the bytes so it is diagnosable, and carry on: every one seen so far
           * was informational and arrived next to a job that printed fine. */
          this.log.push(`unhandled printer frame 0x${note.cmd.toString(16).padStart(2, '0')} ` +
            `(${note.length} bytes) ${bytesToHex(raw || new Uint8Array()).slice(0, 24)} — recorded`);
          return [];
      }
    }
  }

  /* --------------------------------------------------- BLE transport */

  /* Advertised name prefixes (PROTOCOL.md §2; LX covers the LX-D02/D2 line). */
  const NAME_PREFIXES = ['LX-D', 'LX', 'DL-P', 'DL-T', 'ZH-P', 'TD-1', 'T02', 'ITW', 'SWS-', 'AH-M'];

  /* The LX family exposes its vendor service as 0xFFE6, with the write characteristic
   * at 0xFFE1 and notify at 0xFFE2. Web Bluetooth only grants access to services named
   * here, and these printers advertise no distinctive service UUID, so the list has to
   * be declared up front. Order matters only in that we prefer the known-good one. */
  const SERVICE_CANDIDATES = [
    0xffe6,   // LX-D02 / LX-D2 / FunnyPrint family
    0xffe0,   // same module family with the classic JDY/HM-10 service
    0xae30,   // cat-printer (X6) family, in case a different unit shows up
    0xff00, 0xfff0, 0xfee7
  ].map((s) => '0000' + s.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb');

  const errText = (e) => (e && (e.message || e.name)) || String(e);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function bleAvailable() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  class BleTransport {
    constructor(log) {
      this.log = log || (() => {});
      this.device = null;
      this.server = null;
      this.service = null;
      this.writeChar = null;
      this.notifyChar = null;
      this.serviceUuid = null;
      this.services = [];
      this.onData = null;
      this.disconnected = false;
    }

    async connect(opts) {
      if (!bleAvailable()) throw new Error('Web Bluetooth is not available in this browser');
      const o = opts || {};
      const optionalServices = SERVICE_CANDIDATES.slice();
      if (o.serviceUuid) {
        const uuid = String(o.serviceUuid).trim().toLowerCase();
        const full = uuid.length === 4 ? '0000' + uuid + '-0000-1000-8000-00805f9b34fb' : uuid;
        if (optionalServices.indexOf(full) === -1) optionalServices.unshift(full);
      }
      const request = { optionalServices };
      if (o.showAll) request.acceptAllDevices = true;
      else request.filters = NAME_PREFIXES.map((p) => ({ namePrefix: p }));

      const device = await navigator.bluetooth.requestDevice(request);
      this.log(`selected "${device.name || 'unnamed'}" (id ${device.id})`);
      await this._attach(device);
      this.log(`wired up: write ${this.writeChar.uuid}${this.notifyChar ? ' · notify ' + this.notifyChar.uuid : ' · NO notify char'}`);
      return device;
    }

    async _attach(device) {
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => {
        if (!this.disconnected) this.log('device disconnected');
      });

      /* Cheap peripherals refuse the first connect often enough to be worth retrying. */
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          this.server = await device.gatt.connect();
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          this.log(`step gatt.connect failed (attempt ${attempt}/3): ${e.name}: ${errText(e)}`);
          await sleep(400 * attempt);
        }
      }
      if (lastErr) {
        throw new Error(`step gatt.connect: ${lastErr.name}: ${errText(lastErr)}`);
      }
      this.log('connected (GATT)');

      /* Log everything the browser is allowed to see, so a failure here is diagnosable
       * from the log rather than guessed at. */
      try {
        this.services = await this.server.getPrimaryServices();
        this.log(`services visible: ${this.services.map((s) => s.uuid).join(', ') || '(none)'}`);
        for (const service of this.services) {
          try {
            const chars = await service.getCharacteristics();
            for (const c of chars) {
              const props = Object.keys(c.properties).filter((k) => c.properties[k]);
              this.log(`  ${c.uuid} [${props.join(',')}]`);
            }
          } catch (e) {
            this.log(`  ${service.uuid}: characteristics failed: ${e.name}: ${errText(e)}`);
          }
        }
      } catch (e) {
        this.log(`step getPrimaryServices failed: ${e.name}: ${errText(e)}`);
      }

      /* Prefer the vendor naming (ffe1 write / ffe2 notify); fall back to properties. */
      for (const service of this.services) {
        let chars = [];
        try { chars = await service.getCharacteristics(); } catch (e) { continue; }
        for (const c of chars) {
          const u = c.uuid.toLowerCase();
          if (!this.writeChar && u.indexOf('ffe1') !== -1) { this.writeChar = c; this.service = service; }
          if (!this.notifyChar && u.indexOf('ffe2') !== -1) { this.notifyChar = c; }
        }
      }
      if (!this.writeChar) {
        for (const service of this.services) {
          let chars = [];
          try { chars = await service.getCharacteristics(); } catch (e) { continue; }
          for (const c of chars) {
            const p = c.properties;
            if (!this.writeChar && (p.writeWithoutResponse || p.write)) { this.writeChar = c; this.service = service; }
            if (!this.notifyChar && (p.notify || p.indicate)) this.notifyChar = c;
          }
        }
      }
      if (!this.writeChar) {
        throw new Error('no writable characteristic found. Visible services: ' +
          (this.services.map((s) => s.uuid).join(', ') || '(none)'));
      }
      this.serviceUuid = this.service ? this.service.uuid : null;

      if (this.notifyChar) {
        this.notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
          const view = ev.target.value;
          const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          if (this.onData) this.onData(bytes);
        });
        try {
          await this.notifyChar.startNotifications();
          this.log('subscribed to notifications');
        } catch (e) {
          throw new Error(`step startNotifications on ${this.notifyChar.uuid}: ${e.name}: ${errText(e)}`);
        }
      } else {
        this.log('WARNING: no notify characteristic; status and flow control will be missing');
      }
    }

    async write(bytes) {
      if (!this.writeChar) throw new Error('not connected');
      if (this.writeChar.properties.writeWithoutResponse) {
        await this.writeChar.writeValueWithoutResponse(bytes);
      } else {
        await this.writeChar.writeValue(bytes);
      }
    }

    async disconnect() {
      this.disconnected = true;
      try { if (this.notifyChar) await this.notifyChar.stopNotifications(); } catch (e) { /* ignore */ }
      try { if (this.server && this.server.connected) this.server.disconnect(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------------------------------------------------- link */

  class PrinterLink {
    constructor(transport, opts) {
      this.transport = transport;
      this.session = new PrinterSession((opts && opts.rng) || Math.random);
      this.log = (opts && opts.log) || (() => {});
      this.printDone = false;
      this.streaming = false;
      this.transport.onData = (bytes) => this._onData(bytes);
    }

    async connect(opts) {
      await this.transport.connect(opts);
      for (const frame of this.session.begin()) await this._write(frame);
      return this.session;
    }

    _onData(bytes) {
      let out = [];
      try {
        out = this.session.handle(bytes, Date.now());
      } catch (e) {
        this.log('error handling frame: ' + errText(e));
        return;
      }
      for (const line of this.session.log.splice(0)) this.log(line);
      for (const frame of out) {
        this._write(frame).catch((e) => this.log('write failed: ' + errText(e)));
      }
    }

    async _write(frame) {
      await this.transport.write(frame);
    }

    /* Open the job, stream the packets, close it. The printer owns flow control
     * (0x05 rewind, 0x07 cooldown, 0x08 hold) and tells us when it is finished. */
    async print(raster, opts) {
      const o = opts || {};
      this.printDone = false;
      this.streaming = true;
      try {
        for (const frame of this.session.startJob(raster, o)) await this._write(frame);
        for (const line of this.session.log.splice(0)) this.log(line);

        const deadline = Date.now() + (o.timeoutMs || JOB_TIMEOUT_MS);
        while (!this.session.finished && !this.session.jobDone) {
          if (Date.now() > deadline) {
            this.log(`job timed out at packet ${this.session.cursor}/${this.session.totalPkg}`);
            break;
          }
          const frame = this.session.nextStreamFrame(Date.now());
          if (!frame) {
            await sleep(this.session.hold ? 50 : this.session.interPacketMs);
            continue;
          }
          await this._write(frame);
          if (this.session.cursor < this.session.totalPkg) await sleep(this.session.interPacketMs);
        }
        if (this.session.finished) {
          for (const frame of this.session.finishFrames()) await this._write(frame);
          this.printDone = true;
          this.log('job closed');
        }
      } finally {
        this.streaming = false;
        for (const line of this.session.log.splice(0)) this.log(line);
      }
      return this.session;
    }

    /* Paper advance is printing blank rows; there is no feed opcode. */
    async feed(rows) {
      const n = Math.max(2, rows || 6);
      this.log(`feeding ${n} blank rows`);
      await this.print(this.session.blankRaster(n), { density: 0 });
    }
  }

  /* ------------------------------------------------------------- raster */

  const DITHER_KERNEL = [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]];

  /* Word-wrap to a measured width. Words too long for the line are broken, never
   * clipped: silently losing the end of a line is the worst way for a printer to fail,
   * because the output still looks like it worked. */
  function wrapText(measure, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text).replace(/\r\n?/g, '\n').split('\n')) {
      if (paragraph.trim() === '') { lines.push(''); continue; }
      let line = '';
      for (const original of paragraph.split(/\s+/)) {
        let word = original;
        for (;;) {
          const candidate = line ? line + ' ' + word : word;
          if (measure(candidate) <= maxWidth) { line = candidate; break; }
          if (!line) {
            // A single glyph wider than the page: emit it and move on. Looping here
            // instead would hang the tab, which is a worse failure than an ugly line.
            if (word.length === 1) { lines.push(word); word = ''; break; }
            let cut = word.length - 1;
            while (cut > 1 && measure(word.slice(0, cut)) > maxWidth) cut--;
            lines.push(word.slice(0, cut));
            word = word.slice(cut);
            continue;
          }
          lines.push(line);
          line = '';
        }
      }
      lines.push(line);
    }
    return lines;
  }

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
          const dx = DITHER_KERNEL[k][0], dy = DITHER_KERNEL[k][1], factor = DITHER_KERNEL[k][2];
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

  /* MSB-first, packed continuously across the image (no per-row padding), matching
   * the vendor's ImageUtil.booleanArrayToBinaryBuffer; 1 = black. */
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

  return {
    MAGIC_CMD, MAGIC_DATA, CMD, RESP, PAYLOAD_LEN, DATA_PACKET_LEN, LINE_BYTES, WIDTH,
    COOLDOWN_MS, INTER_PACKET_MS, SERVICE_CANDIDATES, NAME_PREFIXES,
    crc16Xmodem, deriveCrcs, hexToBytes, bytesToHex,
    frames, alignRaster, parseNotification,
    PrinterSession, PrinterLink, BleTransport, bleAvailable,
    floydSteinberg, thresholdBits, packBits, rasterize, wrapText
  };
});
