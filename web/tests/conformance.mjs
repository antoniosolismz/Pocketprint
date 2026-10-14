#!/usr/bin/env node
/* Conformance + end-to-end tests for the web core.
 *
 *   node web/tests/conformance.mjs
 *
 * Part 1: the JS core reproduces the Python reference byte for byte (vectors come from
 *         py/tests/make_vectors.py).
 * Part 2: the wire frames are pinned against the *documented* bytes of cicloid/printable,
 *         an independent hardware-validated implementation of this printer family. That
 *         cross-check is what caught two of our bugs: the raster packet field is a packet
 *         INDEX (not a byte offset), and print start/end are six bytes, not twelve.
 * Part 3: a whole print job through the real PrinterLink over a fake printer, including
 *         the printer's flow control (hold + lost packet).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const FP = require(join(here, '..', 'funnyprint.js'));
const vectors = JSON.parse(readFileSync(join(here, '..', '..', 'py', 'tests', 'vectors.json'), 'utf8'));

let failures = 0;
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const eq = (a, b) => hex(a) === hex(b);

function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}

console.log('\n== crc vectors (vs python) ==');
for (const v of vectors.crc) {
  const got = FP.crc16Xmodem(FP.hexToBytes(v.data));
  check(`crc16(${v.data})`, got === v.crc, `${got.toString(16)} vs ${v.crc.toString(16)}`);
}

console.log('\n== auth derivation (vs python) ==');
for (const v of vectors.auth) {
  const { low, high } = FP.deriveCrcs(FP.hexToBytes(v.challenge), v.mac);
  check(`low/high for mac ${v.mac}`, low === v.low && high === v.high, `${low}/${high}`);
}

console.log('\n== frames vs python reference ==');
const frameByName = {
  hello: () => FP.frames.hello(),
  challenge: () => FP.frames.challenge(FP.hexToBytes('02030405060708090a0b')),
  auth_reply: () => FP.frames.authReply(FP.hexToBytes('AB'.repeat(10))),
  density: () => FP.frames.density(3),
  print_start: () => FP.frames.printStatus(0x1234, 0),
  print_end: () => FP.frames.printStatus(3, 1),
  raster: () => FP.frames.data(1, new Uint8Array(96).fill(0xff))
};
for (const v of vectors.frames) {
  const fn = frameByName[v.name];
  check(`frame ${v.name} byte-identical to python`, !!fn && eq(fn(), FP.hexToBytes(v.hex)),
    fn ? hex(fn()) : 'no mapper');
}

console.log('\n== frames pinned against the independent implementation ==');
check('hello is 5A 01 + ten zero bytes',
  eq(FP.frames.hello(), FP.hexToBytes('5a0100000000000000000000')));
check('density is three bytes: 5A 0C level',
  eq(FP.frames.density(3), FP.hexToBytes('5a0c03')) && FP.frames.density(3).length === 3);
check('print start is six bytes: 5A 04 <count:u16be> 00 00',
  eq(FP.frames.printStatus(0x0142, 0), FP.hexToBytes('5a0401420000')) &&
  FP.frames.printStatus(0x0142, 0).length === 6);
check('print end is six bytes: 5A 04 <count:u16be> 01 00',
  eq(FP.frames.printStatus(0x0142, 1), FP.hexToBytes('5a0401420100')));
check('challenge is 5A 0A + ten bytes',
  eq(FP.frames.challenge(FP.hexToBytes('09090909090909090909')), FP.hexToBytes('5a0a09090909090909090909')));
check('auth reply is 5A 0B + ten bytes',
  eq(FP.frames.authReply(FP.hexToBytes('07070707070707070707')), FP.hexToBytes('5a0b07070707070707070707')));

console.log('\n== raster packet carries a PACKET INDEX (regression) ==');
const r0 = FP.frames.data(0, new Uint8Array(96).fill(0xaa));
const r1 = FP.frames.data(1, new Uint8Array(96).fill(0xaa));
const r2 = FP.frames.data(2, new Uint8Array(96).fill(0xaa));
check('packet 0 => index 0x0000', r0[0] === 0x55 && r0[1] === 0 && r0[2] === 0, hex(r0.slice(0, 3)));
check('packet 1 => index 0x0001 (NOT the byte offset 0x0060)', r1[1] === 0x00 && r1[2] === 0x01, hex(r1.slice(0, 3)));
check('packet 2 => index 0x0002 (NOT the byte offset 0x00c0)', r2[1] === 0x00 && r2[2] === 0x02, hex(r2.slice(0, 3)));
check('raster frame is 100 bytes with a zero trailer',
  r0.length === 100 && r0[99] === 0x00 && eq(r0.slice(3, 99), new Uint8Array(96).fill(0xaa)));
const big = FP.frames.data(300, new Uint8Array(96));
check('index is big-endian beyond one byte', big[1] === 0x01 && big[2] === 0x2c, hex(big.slice(0, 3)));

console.log('\n== raster vectors (vs python) ==');
for (const v of vectors.raster) {
  const packed = FP.rasterize(Uint8Array.from(v.pixels), v.width, v.height,
    { threshold: v.threshold, dither: v.dither });
  check(`raster ${v.name}`, eq(packed, FP.hexToBytes(v.packed)), hex(packed));
}

console.log('\n== end-to-end print over a fake printer ==');

/* Device half, as documented: the hello reply carries the MAC, the challenge reply
 * payload is junk (we must not depend on it), 0x0B 01 means authenticated, then it
 * consumes raster packets and reports finished. */
class FakePrinter {
  constructor(opts = {}) {
    this.mac = 'a1b2c3d4e5f6';
    this.wire = [];
    this.received = new Map();
    this.total = 0;
    this.expectedCrc = '';
    this.density = null;
    this.finished = false;
    this.printEnded = false;
    this.outbox = [];
    this.holdOnce = !!opts.holdOnce;
    this.heldYet = false;
  }

  _reply(bytes) { this.outbox.push(Uint8Array.from(bytes)); }

  accept(frame) {
    this.wire.push(hex(frame));
    if (frame[0] === FP.MAGIC_DATA) {
      const index = (frame[1] << 8) | frame[2];
      this.received.set(index, hex(frame.slice(3, 99)));
      if (index === 0 && this.holdOnce && !this.heldYet) {
        this.heldYet = true;
        this._reply([FP.MAGIC_CMD, FP.RESP.HOLD]);                // 5A 08
        this._reply([FP.MAGIC_CMD, FP.RESP.LOST_PACKET, 0, 1]);    // 5A 05 0001 -> rewind to 0
        return;
      }
      if (index === this.total - 1) {
        this.finished = true;
        this._reply([FP.MAGIC_CMD, FP.RESP.FINISHED, (this.total >> 8) & 0xff, this.total & 0xff]);
      }
      return;
    }
    switch (frame[1]) {
      case FP.CMD.HELLO: {
        const r = new Uint8Array(12);
        r[0] = FP.MAGIC_CMD; r[1] = FP.RESP.HELLO;
        r.set(FP.hexToBytes(this.mac), 4);
        this._reply(r);
        break;
      }
      case FP.CMD.CHALLENGE: {
        const { high } = FP.deriveCrcs(frame.slice(2, 12), this.mac);
        this.expectedCrc = high;
        const r = new Uint8Array(12);
        r[0] = FP.MAGIC_CMD; r[1] = FP.RESP.CHALLENGE_REPLY;
        r.set(FP.hexToBytes('deadbeefdeadbeefdead'), 2);   // junk payload on purpose
        this._reply(r);
        break;
      }
      case FP.CMD.AUTH_REPLY: {
        const ok = hex(frame.slice(2, 12)).toUpperCase() === this.expectedCrc;
        this._reply([FP.MAGIC_CMD, FP.RESP.AUTH_RESULT, ok ? 1 : 0]);
        break;
      }
      case FP.CMD.SET_DENSITY:
        this.density = frame[2];
        break;
      case FP.CMD.PRINT_START: {
        const total = (frame[2] << 8) | frame[3];
        if (frame[4] === 1) { this.printEnded = true; break; }
        this.total = total;
        this._reply([FP.MAGIC_CMD, FP.RESP.STATUS, 88, 0, 1, 0, 0, this.density || 3]);
        break;
      }
      default: break;
    }
  }
}

class FakeTransport {
  constructor(opts) {
    this.printer = new FakePrinter(opts);
    this.sent = [];
    this.onData = null;
  }
  async connect() { this.device = { name: 'LX-D02 (fake)' }; }
  async write(frame) {
    this.sent.push(hex(frame));
    this.printer.accept(frame);
    /* Notifications arrive asynchronously, not one per write: drain everything the
     * printer queued, which is what a real BLE stack would deliver. */
    while (this.printer.outbox.length) {
      const next = this.printer.outbox.shift();
      setTimeout(() => this.onData && this.onData(next), 0);
    }
  }
  async disconnect() {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];
const transport = new FakeTransport();
const link = new FP.PrinterLink(transport, {
  log: (l) => logs.push(l),
  rng: (() => { let i = 0; const seq = [0.11, 0.22, 0.33, 0.44, 0.55, 0.66, 0.77, 0.88, 0.99, 0.05]; return () => seq[i++ % seq.length]; })()
});

await link.connect();
await sleep(40);
check('hello went out first', transport.sent[0].startsWith('5a01'), transport.sent[0]);
check('link authenticated', link.session.authenticated === true, logs.join(' | '));
check('a junk challenge reply does not deadlock the handshake',
  link.session.lastAuthCheck === false && link.session.authenticated === true);

const raster = new Uint8Array(96 * 2 + 30).fill(0x5a);
await link.print(raster, { density: 5 });
await sleep(300);

check('density frame sent before the job', transport.sent.some((f) => f === '5a0c05'), transport.sent.slice(0, 6).join(' '));
check('print start uses the six-byte form', transport.sent.some((f) => f === '5a0400030000'), transport.sent.join(' '));
check('printer received all three packets', transport.printer.received.size === 3,
  [...transport.printer.received.keys()].join(','));
check('packet indexes on the wire are 0,1,2 (not 0,96,192)',
  transport.sent.filter((f) => f.startsWith('55')).map((f) => f.slice(0, 6)).join(' ') === '550000 550001 550002',
  transport.sent.filter((f) => f.startsWith('55')).map((f) => f.slice(0, 6)).join(' '));
check('the requested density reached the printer', transport.printer.density === 5);
check('last packet zero-padded to 96 bytes',
  transport.printer.received.get(2) === hex(Uint8Array.from([...new Uint8Array(30).fill(0x5a), ...new Uint8Array(66)])));
check('job closed with the six-byte print end', transport.printer.printEnded);
check('link reports the print done', link.printDone === true);
check('status notification parsed', !!link.session.status && link.session.status.battery === 88,
  JSON.stringify(link.session.status));

console.log('\n== flow control: hold + lost packet ==');
const t2 = new FakeTransport({ holdOnce: true });
const link2 = new FP.PrinterLink(t2, { log: () => {} });
await link2.connect();
await sleep(40);
await link2.print(new Uint8Array(96 * 3).fill(0x11), { density: 3 });
await sleep(400);
const data2 = t2.sent.filter((f) => f.startsWith('55'));
check('hold stalled us and the rewind resent packet 0',
  data2.filter((f) => f.slice(0, 6) === '550000').length === 2,
  data2.map((f) => f.slice(0, 6)).join(' '));
check('the job still completed after the hold', t2.printer.finished === true);

console.log('\n== wire trace (what goes over BLE) ==');
transport.sent.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}: ${String(f.length / 2).padStart(3)}B  ${f.slice(0, 54)}${f.length > 54 ? '…' : ''}`));

console.log('\n== link log ==');
logs.slice(0, 12).forEach((l) => console.log('  ' + l));

console.log();
if (failures) { console.log(`FAILED: ${failures}`); process.exit(1); }
console.log('all web-core tests passed');
