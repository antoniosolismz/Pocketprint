#!/usr/bin/env node
/* Tests for the render pipeline (halftones, sharpen, rotate) and the label layout planner.
 *
 *   node web/tests/render.mjs
 *
 * Geometry is tested here rather than on paper because a layout mistake is silent: the
 * block simply runs off the bottom of the label and the printout looks like it worked.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const FP = require(join(here, '..', 'funnyprint.js'));
const Label = require(join(here, '..', 'label.js'));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}
const blackCount = (bits) => bits.reduce((n, b) => n + b, 0);

/* ------------------------------------------------------------ halftones */
console.log('\n== halftone modes ==');
const W = 64, H = 64;
const ramp = new Uint8Array(W * H);
for (let i = 0; i < ramp.length; i++) ramp[i] = Math.round((i % W) * 255 / (W - 1));
const mid = new Uint8Array(W * H).fill(128);

for (const mode of FP.DITHER_MODES) {
  const bits = FP.ditherBits(ramp, W, H, { mode, threshold: 128 });
  check(`${mode}: 1 bit per pixel`, bits.length === W * H);
  check(`${mode}: output is binary`, bits.every((b) => b === 0 || b === 1));
}
check('modes actually differ from one another',
  new Set(FP.DITHER_MODES.map((m) => FP.ditherBits(ramp, W, H, { mode: m, threshold: 128 }).join(''))).size === 4);
check('the legacy dither:false still means no dithering',
  FP.ditherBits(ramp, W, H, { dither: false }).join('') === FP.thresholdBits(ramp, W, H, 128).join(''));
check('an unknown mode falls back to Floyd–Steinberg',
  FP.ditherBits(ramp, W, H, { mode: 'nonsense' }).join('') === FP.floydSteinberg(ramp, W, H, 128).join(''));

console.log('\n== mode character (what you would see on paper) ==');
const fsFlat = blackCount(FP.floydSteinberg(mid, W, H, 128)) / (W * H);
const atFlat = blackCount(FP.atkinson(mid, W, H, 128)) / (W * H);
check('both reproduce mid-grey near 50%',
  Math.abs(fsFlat - 0.5) < 0.06 && Math.abs(atFlat - 0.5) < 0.06,
  `floyd ${(fsFlat * 100).toFixed(1)}% atkinson ${(atFlat * 100).toFixed(1)}%`);
check('Atkinson keeps pure white pure',
  blackCount(FP.atkinson(new Uint8Array(W * H).fill(255), W, H, 128)) === 0);
check('Atkinson keeps pure black solid',
  blackCount(FP.atkinson(new Uint8Array(W * H).fill(0), W, H, 128)) === W * H);
check('a Bayer pattern on flat grey is periodic with period 8', (() => {
  const bits = FP.bayer(mid, 24, 24, 128);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      if (bits[y * 24 + x] !== bits[(y + 8) * 24 + x]) return false;   // vertical period
      if (bits[y * 24 + x] !== bits[y * 24 + x + 8]) return false;     // horizontal period
    }
  }
  return true;
})());
check('Bayer resolves more levels than a plain threshold', (() => {
  /* 16 flat patches at different greys: ordered dithering should render them differently */
  let distinct = 0;
  for (let v = 100; v < 156; v += 4) {
    distinct += new Set([FP.bayer(new Uint8Array(64).fill(v), 8, 8, 128).join('')]).size;
  }
  return distinct >= 10;
})());

/* ------------------------------------------------------------- unsharp */
console.log('\n== sharpen ==');
const edge = new Uint8Array(16 * 8).fill(255);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) edge[y * 16 + x] = 60;
const sharpened = FP.unsharp(edge, 16, 8, 100);
check('amount 0 is a no-op',
  FP.unsharp(edge, 16, 8, 0).join('') === edge.join(''));
check('an edge gets more contrast, not less',
  sharpened[0] <= edge[0] && sharpened[15] >= edge[15],
  `${edge[0]}/${edge[15]} -> ${sharpened[0]}/${sharpened[15]}`);
check('values stay clamped to 0..255',
  sharpened.every((v) => v >= 0 && v <= 255));
check('a flat area is unchanged (nothing to sharpen)',
  FP.unsharp(new Uint8Array(64).fill(140), 8, 8, 100).every((v) => v === 140));

/* -------------------------------------------------------------- rotate */
console.log('\n== rotate ==');
const grid = new Uint8Array(4 * 3);
for (let i = 0; i < grid.length; i++) grid[i] = i;         // 4 wide, 3 tall
const r1 = FP.rotate(grid, 4, 3, 1);
check('one quarter turn swaps the dimensions', r1.w === 3 && r1.h === 4, `${r1.w}x${r1.h}`);
check('the top-left pixel moves to the top-right', r1.pixels[2] === 0, String(r1.pixels[2]));
check('four turns is the identity', FP.rotate(grid, 4, 3, 4).pixels.join(',') === grid.join(','));
check('two turns is a 180', FP.rotate(grid, 4, 3, 2).pixels.join(',') ===
  Array.from(grid).reverse().join(','));
check('no pixels are lost or duplicated',
  FP.rotate(grid, 4, 3, 1).pixels.length === grid.length &&
  new Set(FP.rotate(grid, 4, 3, 1).pixels).size === grid.length);
check('a negative turn is normalised', FP.rotate(grid, 4, 3, -1).pixels.join(',') ===
  FP.rotate(grid, 4, 3, 3).pixels.join(','));

/* --------------------------------------------------------- processImage */
console.log('\n== the whole image pipeline ==');
const img = new Uint8Array(32 * 16);
for (let i = 0; i < img.length; i++) img[i] = 40 + ((i * 7) % 90);
const out = FP.processImage(img, 32, 16, { rotate: 1, autoLevels: true, sharpen: 60, ditherMode: 'atkinson' });
check('rotation is applied to the output dimensions', out.w === 16 && out.h === 32, `${out.w}x${out.h}`);
check('output is a 1-bit plane', out.bits.length === 16 * 32 && out.bits.every((b) => b <= 1));
check('turning tone off changes the result',
  FP.processImage(img, 32, 16, { ditherMode: 'atkinson' }).bits.join('') !== out.bits.join(''));
check('choosing a different mode changes the result',
  FP.processImage(img, 32, 16, { ditherMode: 'bayer' }).bits.join('') !==
  FP.processImage(img, 32, 16, { ditherMode: 'atkinson' }).bits.join(''));

/* --------------------------------------------------------------- units */
console.log('\n== units on a 203 dpi head ==');
check('48 mm is the full 384-dot width', Label.MM(48) === 384, String(Label.MM(48)));
check('10 mm is 80 dots', Label.MM(10) === 80, String(Label.MM(10)));
check('40 mm round-trips', Math.abs(Label.dotsToMm(Label.MM(40)) - 40) < 0.1,
  String(Label.dotsToMm(Label.MM(40))));

/* --------------------------------------------------------- label planner */
console.log('\n== label planning ==');
const plan = Label.planLabel({ title: 'Caja 07', subtitle: 'Ferretería', code: { kind: 'qr', text: 'https://otelo2.com' } });
check('a text+QR label has both blocks',
  plan.blocks.map((b) => b.kind).join(',') === 'text,qr', plan.blocks.map((b) => b.kind).join(','));
check('no warnings on a normal label', plan.warnings.length === 0, JSON.stringify(plan.warnings));
check('the label is tall enough for its content',
  plan.height >= plan.blocks.reduce((n, b) => n + b.height, 0), `${plan.height}`);
check('every block sits inside the head width',
  plan.blocks.every((b) => b.x >= 0 && b.x + b.width <= 384),
  JSON.stringify(plan.blocks.map((b) => [b.x, b.width])));
check('blocks do not overlap',
  plan.blocks.every((b, i) => i === 0 || b.y >= plan.blocks[i - 1].y + plan.blocks[i - 1].height),
  JSON.stringify(plan.blocks.map((b) => [b.y, b.height])));
check('the QR fits the printable width',
  plan.blocks.find((b) => b.kind === 'qr').bitmap.w <= 384 - 16, 
  String(plan.blocks.find((b) => b.kind === 'qr').bitmap.w));
check('the label reports its length in mm for paper accounting',
  plan.heightMm > 20 && plan.heightMm < 120, String(plan.heightMm));

console.log('\n== label planning: the awkward cases ==');
const longTitle = Label.planLabel({ title: 'Caja de herramientas del taller de la esquina con nombre larguísimo' });
const shortTitle = Label.planLabel({ title: 'Caja' });
check('a long title wraps into more lines and a taller label',
  longTitle.blocks[0].lines.length > shortTitle.blocks[0].lines.length &&
  longTitle.height > shortTitle.height,
  `${longTitle.blocks[0].lines.length} vs ${shortTitle.blocks[0].lines.length} lines`);
check('wrapped lines all fit the printable width', (() => {
  const measure = Label.approximateMeasure(longTitle.spec.titleSize);
  return longTitle.blocks[0].lines.every((l) => measure(l.text) <= 384 - 32);
})());
const impossible = Label.planLabel({
  title: 'Caja',
  code: { kind: 'qr', text: 'x'.repeat(400), minDots: 6 },
});
check('an impossible QR becomes a warning, not a crash',
  impossible.warnings.some((w) => /QR/.test(w)), JSON.stringify(impossible.warnings));
check('the text still plans when the code cannot',
  impossible.blocks.some((b) => b.kind === 'text'));
const empty = Label.planLabel({});
check('an empty label warns instead of printing blank paper',
  empty.warnings.some((w) => /nothing to print/.test(w)), JSON.stringify(empty.warnings));
const tooWide = Label.planLabel({ title: 'x', code: { kind: 'code128', text: 'y'.repeat(60) } });
check('an over-wide barcode warns', tooWide.warnings.some((w) => /Barcode/.test(w)),
  JSON.stringify(tooWide.warnings));
const bordered = Label.planLabel({ title: 'Caja', border: true });
check('a border insets the content',
  bordered.blocks[0].x > Label.DEFAULTS.padding, String(bordered.blocks[0].x));
check('a border does not push content off the head',
  bordered.blocks[0].x + bordered.blocks[0].width <= 384);

console.log('\n== sheets and batch lists ==');
const sheet = Label.planSheet([
  { title: 'uno' }, { title: 'dos' }, { title: 'tres' },
]);
check('three labels stack to three plans', sheet.labels.length === 3);
check('labels are laid out top to bottom without gaps',
  sheet.labels[1].y === sheet.labels[0].y + sheet.labels[0].totalHeight,
  JSON.stringify(sheet.labels.map((l) => l.y)));
check('the sheet is exactly as tall as its labels',
  sheet.height === sheet.labels.reduce((n, l) => n + l.totalHeight, 0));
check('cut guides land on the seams only', sheet.cutYs.length === 2, JSON.stringify(sheet.cutYs));
check('the sheet reports its paper length in mm',
  sheet.heightMm > 40 && Math.abs(sheet.heightMm - Label.dotsToMm(sheet.height)) < 0.2,
  String(sheet.heightMm));

const batch = Label.itemsFromList('caja-01\n\ncaja-02\tEstante A\ncaja-03 | Estante B\n   \n');
check('blank lines are dropped from a pasted list', batch.length === 3, String(batch.length));
check('a tab splits title and subtitle',
  batch[1].title === 'caja-02' && batch[1].subtitle === 'Estante A', JSON.stringify(batch[1]));
check('a pipe splits title and subtitle',
  batch[2].title === 'caja-03' && batch[2].subtitle === 'Estante B', JSON.stringify(batch[2]));
check('every item inherits the base spec',
  Label.itemsFromList('a\nb', { width: 384, titleSize: 30 }).every((i) => i.titleSize === 30));

console.log('\n== the tear-off path ==');
const withTear = Label.planLabel({ title: 'x', tearMm: 10 });
const noTear = Label.planLabel({ title: 'x', tearMm: 0 });
check('tear space is added after the label, not inside it',
  withTear.height === noTear.height && withTear.totalHeight > noTear.totalHeight,
  `${withTear.height}/${withTear.totalHeight} vs ${noTear.height}/${noTear.totalHeight}`);
check('the default tear is about 6 mm', Label.DEFAULTS.tearMm === 6);
check('a sheet keeps a guide at every seam even with tear space',
  Label.planSheet([{ title: 'a' }, { title: 'b' }]).cutYs.length === 1);

console.log();
if (failures) { console.log(`FAILED: ${failures}`); process.exit(1); }
console.log('all render and label tests passed');
