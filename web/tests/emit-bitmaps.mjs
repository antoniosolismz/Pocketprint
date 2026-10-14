#!/usr/bin/env node
/* Emits the bitmaps that web/tests/verify-codes.py decodes and cross-checks.
 * Run through that script rather than directly:
 *
 *   python3 web/tests/verify-codes.py
 *
 * Writes PGM files (trivially simple, no image library needed here) plus the Code 128
 * module patterns as JSON so the Python side can compare against python-barcode.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const Codes = require(join(here, '..', 'codes.js'));

const outDir = process.argv[2];
if (!outDir) { console.error('usage: emit-bitmaps.mjs OUTDIR'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const QR_PAYLOADS = [
  'https://print.antoniosolismz.com',
  'WIFI:T:WPA;S:Taller;P:correct-horse-battery;;',
  'BEGIN:VCARD\nVERSION:3.0\nFN:Otelo Solis\nTEL:+52 222 000 0000\nEND:VCARD',
  'caja-07 · ferretería · 2026-10-14',
  'https://es.wikipedia.org/wiki/Cholula',
];

/* 1-bit bitmap -> binary PGM (1 = black = 0). 8-bit PGM so any decoder reads it. */
function writePgm(path, bitmap) {
  const header = Buffer.from(`P5\n${bitmap.w} ${bitmap.h}\n255\n`, 'ascii');
  const pixels = Buffer.alloc(bitmap.w * bitmap.h);
  for (let i = 0; i < bitmap.w * bitmap.h; i++) pixels[i] = bitmap.bits[i] ? 0 : 255;
  writeFileSync(path, Buffer.concat([header, pixels]));
}

const manifest = [];
QR_PAYLOADS.forEach((payload, i) => {
  /* the real print path: integer modules, spec quiet zone, fitted to a 384-dot head */
  const bitmap = Codes.qrBitmap(payload, { targetDots: 384 });
  const file = `qr-${i}.pgm`;
  writePgm(join(outDir, file), bitmap);
  manifest.push({ file, payload, modules: bitmap.modules, moduleDots: bitmap.moduleDots, w: bitmap.w, h: bitmap.h });

  /* and the same code as it comes out of a composed label, to prove the composer keeps it
   * scannable (a label is QR + barcode stacked, which is the real layout) */
  const composed = Codes.compose(
    [bitmap, Codes.code128Bitmap('CAJA-07', { height: 60 })],
    { gap: 10, align: 'center' });
  const cfile = `qr-composed-${i}.pgm`;
  writePgm(join(outDir, cfile), composed);
  manifest.push({ file: cfile, payload, composed: true, w: composed.w, h: composed.h });
});

writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
writeFileSync(join(outDir, 'code128.json'), JSON.stringify({
  'CAJA-07': Codes.code128Bits('CAJA-07'),
  '12345678': Codes.code128Bits('12345678'),
  'otelo-2026-10-14': Codes.code128Bits('otelo-2026-10-14'),
  'SKU 99881': Codes.code128Bits('SKU 99881'),
}, null, 1));
console.log(`emitted ${manifest.length} bitmaps to ${outDir}`);
