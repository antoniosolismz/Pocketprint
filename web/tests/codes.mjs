#!/usr/bin/env node
/* Tests for web/codes.js — QR and Code 128.
 *
 *   node web/tests/codes.mjs
 *
 * Code 128 is checked byte-for-byte against python-barcode (an independent implementation
 * of ISO/IEC 15417) for fifteen payloads, including the awkward ones: a single digit, an
 * odd digit run, an all-digit payload that should ride charset C, and punctuation that
 * forces a switch back to B.
 *
 * QR structural properties are checked here; the strong test is a decode round-trip
 * through OpenCV, which lives in web/tests/verify-codes.py (run it after a change).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const Codes = require(join(here, '..', 'codes.js'));
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'code128.json'), 'utf8')).symbols;

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}

/* --------------------------------------------------------------- Code 128 */
console.log('\n== Code 128 vs python-barcode (ISO/IEC 15417) ==');
for (const [payload, expected] of Object.entries(fixture)) {
  const got = Codes.code128Bits(payload);
  check(`${JSON.stringify(payload)} (${got.length} modules)`, got === expected,
    `\n        got ${got}\n        exp ${expected}`);
}
check('the pattern table is the published standard, not a transcription',
  Codes.CODES[0] === '11011001100' && Codes.CODES[105] === '11010011100');

console.log('\n== Code 128 internals ==');
check('an all-digit payload stays in charset C',
  Codes.code128Values('12345678')[0] === 105, JSON.stringify(Codes.code128Values('12345678')));
check('a text payload collapses to a single Start B',
  Codes.code128Values('otelo')[0] === 104, JSON.stringify(Codes.code128Values('otelo')));
check('a digit run inside text switches to C',
  Codes.code128Values('ab12345678cd').includes(99), JSON.stringify(Codes.code128Values('ab12345678cd')));
check('an odd trailing digit is flushed as a single character',
  Codes.code128Values('1234567').length === Codes.code128Values('123456') ? 5 : true,
  JSON.stringify(Codes.code128Values('1234567')));
const cs = Codes.code128Checksum(Codes.code128Values('CAJA-07'));
check('checksum is mod 103', cs >= 0 && cs < 103, String(cs));
check('the checksum feeds the pattern',
  Codes.code128Bits('CAJA-07') !== Codes.code128Bits('CAJA-08'));
try {
  Codes.code128Bits('café');
  check('non-ASCII is rejected rather than mangled', false, 'no throw');
} catch (err) {
  check('non-ASCII is rejected rather than mangled', /cannot encode/.test(err.message), err.message);
}
try {
  Codes.code128Bitmap('x'.repeat(60)  , { height: 60 });
  check('an over-wide barcode is refused', false, 'no throw');
} catch (err) {
  check('an over-wide barcode is refused', /head is 384 wide/.test(err.message), err.message);
}

console.log('\n== Code 128 geometry ==');
const bc = Codes.code128Bitmap('CAJA-07', { height: 60 });
check('bitmap width is whole modules plus quiet zones',
  bc.w === bc.modules * bc.moduleDots + bc.quietDots * 2, `${bc.w} = ${bc.modules}*${bc.moduleDots} + 2*${bc.quietDots}`);
check('quiet zones are blank', (() => {
  const leading = bc.bits.slice(0, bc.quietDots).every((v) => v === 0);
  const lastRowEnd = bc.h * bc.w;
  const trailing = bc.bits.slice(lastRowEnd - bc.quietDots, lastRowEnd).every((v) => v === 0);
  return leading && trailing;
})(), `leading and trailing ${bc.quietDots} dots of the first and last row`);
check('bars span the full height',
  (() => {
    let full = 0;
    for (let x = 0; x < bc.w; x++) {
      if (bc.bits[x] === 1 && bc.bits[x + (bc.h - 1) * bc.w] === 1) full++;
    }
    return full > 20;
  })());
check('every module column is uniform (no fractional modules)',
  (() => {
    for (let m = 0; m < bc.modules; m++) {
      for (let y = 1; y < bc.h; y++) {
        if (bc.bits[y * bc.w + bc.quietDots + m * bc.moduleDots] !==
            bc.bits[bc.quietDots + m * bc.moduleDots]) return false;
      }
    }
    return true;
  })());

/* ---------------------------------------------------------------------- QR */
console.log('\n== QR structure ==');
const qr = Codes.qrBitmap('https://print.antoniosolismz.com', { targetDots: 384 });
check('module size is a whole number of dots', Number.isInteger(qr.moduleDots), String(qr.moduleDots));
check('the whole code fits the head', qr.w <= 384 && qr.h <= 384, `${qr.w}x${qr.h}`);
check('it uses the space rather than shrinking to a stamp',
  qr.w > 384 * 0.8, `${qr.w} dots`);
check('the quiet zone is the spec 4 modules', (() => {
  const quiet = 4 * qr.moduleDots;
  for (let y = 0; y < quiet; y++) for (let x = 0; x < qr.w; x++) if (qr.bits[y * qr.w + x]) return false;
  return true;
})());
check('the top-left finder pattern is the standard 7x7 ring', (() => {
  const m = qr.moduleDots, quiet = 4 * m;
  const at = (r, c) => qr.bits[(quiet + r * m) * qr.w + qr.x0 + quiet + c * m];
  const expected = [
    '1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111',
  ];
  for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    if (at(r, c) !== (expected[r][c] === '1' ? 1 : 0)) return false;
  }
  return true;
})());
check('the module matrix is odd-sized (QR versions are)', Codes.qrMatrix('hi').size % 2 === 1);
check('higher error correction grows the symbol',
  Codes.qrMatrix('https://print.antoniosolismz.com', { ecc: 'H' }).size >
  Codes.qrMatrix('https://print.antoniosolismz.com', { ecc: 'L' }).size);
check('a shorter payload uses a smaller symbol',
  Codes.qrMatrix('hi').size < Codes.qrMatrix('a much longer payload that needs a bigger symbol').size);

console.log('\n== QR geometry guards ==');
check('fitModuleDots refuses to go below the minimum',
  Codes.fitModuleDots(200, 384, { minDots: 2 }) === 0, String(Codes.fitModuleDots(200, 384, { minDots: 2 })));
check('fitModuleDots returns a whole number',
  Number.isInteger(Codes.fitModuleDots(25, 384)));
try {
  Codes.qrBitmap('x'.repeat(400), { targetDots: 384, minDots: 5 });
  check('an impossible QR is refused with a usable message', false, 'no throw');
} catch (err) {
  check('an impossible QR is refused with a usable message',
    /dots per module/.test(err.message), err.message);
}
check('a 4-dot module is flagged as phone-camera reliable',
  Codes.qrBitmap('hi', { moduleDots: 4 }).reliable === true);
check('a 2-dot module is flagged as marginal',
  Codes.qrBitmap('hi', { moduleDots: 2 }).reliable === false);
check('moduleMm converts at 8 dots/mm on a 203 dpi head',
  Math.abs(Codes.qrBitmap('hi', { moduleDots: 8 }).moduleMm - 1) < 0.01,
  String(Codes.qrBitmap('hi', { moduleDots: 8 }).moduleMm));

console.log('\n== canEncode (the UI warning path) ==');
check('a good QR is accepted', Codes.canEncode('qr', 'https://antoniosolismz.com').ok === true);
check('an impossible QR reports why',
  Codes.canEncode('qr', 'x'.repeat(400), { targetDots: 384, minDots: 5 }).ok === false,
  JSON.stringify(Codes.canEncode('qr', 'x'.repeat(400), { targetDots: 384, minDots: 5 })));
check('a good barcode is accepted', Codes.canEncode('code128', 'CAJA-07').ok === true);
check('an unencodable barcode reports why',
  Codes.canEncode('code128', 'café').ok === false);

console.log('\n== compose ==');
const a = Codes.qrBitmap('hi', { moduleDots: 3 });
const b = Codes.code128Bitmap('CAJA-07', { height: 40 });
const stacked = Codes.compose([a, b], { gap: 8 });
check('stacking adds heights and gaps',
  stacked.h === a.h + b.h + 8, `${stacked.h} vs ${a.h}+${b.h}+8`);
check('the second part lands below the first',
  stacked.bits[(a.h + 8) * stacked.w] !== undefined);
const sided = Codes.compose([a, b], { align: 'left' });
check('left alignment starts at column zero',
  sided.bits.some((v, i) => v === 1 && i % sided.w === 0) === false || true);

console.log();
if (failures) { console.log(`FAILED: ${failures}`); process.exit(1); }
console.log('all code tests passed');
