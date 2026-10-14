#!/usr/bin/env node
/* Wiring tests: the browser load path and the page's own guts.
 *
 *   node web/tests/wiring.mjs
 *
 * Written after three wiring bugs in a row got past every other test suite, because they
 * were all "the browser loads things differently" problems:
 *   1. the vendor scripts were never included in index.html;
 *   2. codes.js read window.CODE128_CODES, but a top-level `const` is not a window property;
 *   3. a stray $('someId') referenced an element that never existed.
 * None of those can be caught by testing the modules in Node — only by reproducing how a
 * browser assembles the page. So this suite does exactly that: it loads the scripts in a
 * sandbox the way a classic <script> tag would, then checks every id the page reaches for.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${detail}`); failures++; }
}

const html = readFileSync(join(web, 'index.html'), 'utf8');
const inline = html.split('<script>').pop().split('</script>')[0];

/* ------------------------------------------------ 1. the browser load path */
console.log('\n== the page loads the way a browser would ==');
const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check('the page declares its scripts', scriptSrcs.length >= 5, JSON.stringify(scriptSrcs));

/* Every local script must carry a ?v= stamp that deploy.sh rewrites. The edge cache rewrites
 * responses to max-age=14400 regardless of the origin's no-cache, so an unstamped URL is
 * cached in the browser for four hours — long enough for a new page to run against an old
 * library, which is how the label and batch previews silently stopped updating. */
for (const src of scriptSrcs) {
  check(`${src.split('?')[0]} carries a build stamp`, /\?v=/.test(src), src);
}

for (const src of scriptSrcs) {
  const clean = src.split('?')[0];
  check(`${clean} exists on disk`, existsSync(join(web, clean)), clean);
}

const order = scriptSrcs.map((s) => s.split('?')[0]);
const before = (a, b) => order.indexOf(a) >= 0 && order.indexOf(a) < order.indexOf(b);
check('the QR vendor script loads before codes.js', before('vendor/qrcode.js', 'codes.js'));
check('the barcode table loads before codes.js', before('vendor/code128-table.js', 'codes.js'));
check('the core loads before codes.js', before('funnyprint.js', 'codes.js'));
check('codes.js loads before label.js (label needs QR geometry)',
  before('codes.js', 'label.js'));

/* Load them in a sandbox with browser-ish globals and no `module`, so the UMD takes the
 * browser branch. This is the path that was broken. */
const sandbox = { console };
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.document = { createElement: () => ({ getContext: () => null }) };
vm.createContext(sandbox);
let loadError = null;
try {
  for (const src of scriptSrcs) {
    const clean = src.split('?')[0];
    vm.runInContext(readFileSync(join(web, clean), 'utf8'), sandbox, { filename: clean });
  }
} catch (err) {
  loadError = err;
}
check('every script loads in browser mode without throwing',
  loadError === null, loadError && `${loadError.message} @ ${loadError.stack.split('\n')[1]}`);
check('the page gets FunnyPrint', typeof sandbox.FunnyPrint === 'object');
check('the page gets PocketCodes', typeof sandbox.PocketCodes === 'object',
  String(typeof sandbox.PocketCodes));
check('the page gets PocketLabel', typeof sandbox.PocketLabel === 'object');
check('the QR encoder reaches the page as a global', typeof sandbox.qrcode === 'function');
check('the barcode table reaches the page as a global',
  typeof sandbox.CODE128_TABLE === 'object', String(typeof sandbox.CODE128_TABLE));

if (typeof sandbox.PocketCodes === 'object') {
  check('QR generation works from the page global', (() => {
    try { return sandbox.PocketCodes.qrBitmap('https://print.antoniosolismz.com', { moduleDots: 4 }).w > 0; }
    catch (e) { return false; }
  })());
  check('barcode generation works from the page global', (() => {
    try { return sandbox.PocketCodes.code128Bits('CAJA-07').length > 0; }
    catch (e) { return false; }
  })());
}
if (typeof sandbox.PocketLabel === 'object') {
  check('label planning works from the page global', (() => {
    try { return sandbox.PocketLabel.planLabel({ title: 'x' }).height > 0; }
    catch (e) { return false; }
  })());
}

/* ------------------------------------------------- 2. the page's own ids */
console.log('\n== every element the page reaches for exists ==');
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Set([...inline.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...referenced].filter((id) => !declared.has(id));
check('no $() call points at a missing element', missing.length === 0, JSON.stringify(missing));

/* the tab buttons are addressed by a computed id, so check those explicitly */
for (const tab of ['tabText', 'tabImage', 'tabLabel', 'tabBatch']) {
  check(`${tab} exists`, declared.has(tab));
}
/* the panes too */
for (const pane of ['paneText', 'paneImage', 'paneLabel', 'paneBatch']) {
  check(`${pane} exists`, declared.has(pane));
}

/* ids in the listener wiring list */
const wiringList = inline.match(/\[([^\]]*?)\]\.forEach\(\(id\) =>/s);
if (wiringList) {
  const ids = [...wiringList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const bad = ids.filter((id) => !declared.has(id));
  check('every id in the input wiring list exists', bad.length === 0, JSON.stringify(bad));
  check('the wiring list is not empty', ids.length > 15, String(ids.length));
}

/* Controls come in two flavours: ones that simply re-render, and the two style scopes, which
 * maintain themselves. Both must be complete or a control silently does nothing. */
const plainControls = ['textInput', 'widthSel', 'threshold', 'invert', 'density', 'autoLevels',
  'brightness', 'contrast', 'rotate', 'ditherMode', 'sharpen', 'copiesInput',
  'labelTitle', 'labelSubtitle', 'codeKind', 'codeText', 'codeEcc',
  'batchInput', 'batchCopies', 'batchStagger'];
const wiredText = wiringList ? wiringList[1] : '';
check('every plain control re-renders when changed',
  plainControls.every((id) => wiredText.includes(`'${id}'`)),
  JSON.stringify(plainControls.filter((id) => !wiredText.includes(`'${id}'`))));

/* -------------------------------------- 2c. two style scopes, one label style */
console.log('\n== style scopes ==');
check('the text scope has its own controls',
  ['textFace', 'textSize', 'textAlign'].every((id) => declared.has(id) && inline.includes(`'${id}'`)));
check('the text scope is separate from the label scope',
  /style\.text\[key\]/.test(inline) && /style\.label\[key\]/.test(inline));
check('text jobs read the text scope',
  /const size = style\.text\.size/.test(inline) && /style\.text\.align/.test(inline));

/* One table drives both label panes, so they cannot drift apart. */
const labelRows = [...inline.matchAll(/\['(\w+)', '(select|check|number)', '(\w+)', '(\w+)'\]/g)]
  .map((m) => ({ field: m[1], kind: m[2], label: m[3], batch: m[4] }));
const EXPECTED_FIELDS = ['Face', 'Align', 'TitleSize', 'SubtitleSize', 'Border', 'Cut', 'Tear'];
check('the label style table exists', labelRows.length === EXPECTED_FIELDS.length,
  `${labelRows.length} rows: ${JSON.stringify(labelRows.map((r) => r.field))}`);
check('every label control in the markup is in the table',
  EXPECTED_FIELDS.every((f) => labelRows.some((r) => r.label === 'label' + f)));
check('every batch control in the markup is in the table',
  EXPECTED_FIELDS.every((f) => labelRows.some((r) => r.batch === 'batch' + f)));
check('both panes offer the same fields',
  labelRows.every((r) => r.label.replace('label', '') === r.batch.replace('batch', '')),
  JSON.stringify(labelRows));
for (const row of labelRows) {
  check(`${row.label} / ${row.batch} both exist in the markup`,
    declared.has(row.label) && declared.has(row.batch));
}
check('the label style is one object shared by both tabs',
  /style\.label\[key\] = readField/.test(inline) && /mirrorLabelStyle\(\)/.test(inline));
check('batch builds its sheet from the same spec builder',
  /const base = labelSpecFromForm\(\)/.test(inline));
check('label jobs no longer read the text tab controls',
  !/fontFace/.test(inline) && !/\$\('textAlign'\)\.value/.test(inline),
  'the page still reaches for the old text-tab controls');

/* ---------------------------------- 2d. collapsed groups keep their state visible */
console.log('\n== collapsed groups show their state ==');
const summaryIds = [...html.matchAll(/class="gvals" id="([^"]+)"/g)].map((m) => m[1]);
check('the groups have summary spans', summaryIds.length >= 6, JSON.stringify(summaryIds));
const unwritten = summaryIds.filter((id) => !inline.includes(`$('${id}').textContent`));
check('every summary span is actually written by the page', unwritten.length === 0,
  JSON.stringify(unwritten));
check('the summaries carry live values, not static labels',
  /\$\('qualityVals'\)\.textContent = `density \$\{density\(\)\}/.test(inline) &&
  /\$\('previewSummary'\)\.textContent = /.test(inline));
check('the preview sticks to the top while you edit',
  /class="sticky-preview"/.test(html) && /\.sticky-preview \{ position: sticky/.test(html));
check('the printer group folds away once connected',
  /\$\('printerDetails'\)\.open = false/.test(inline));
check('diagnostics open themselves when something fails',
  /\$\('logDetails'\)\.open = true/.test(inline));
check('every group is a native details element (no JS needed to open one)',
  (html.match(/details class="group"/g) || []).length >= 6,
  String((html.match(/details class="group"/g) || []).length));

/* ---------------------------------- 2e. the threshold reaches every mode */
console.log('\n== the threshold is no longer dead outside image mode ==');
check('crisp modes use the slider instead of a hardcoded 128',
  /thresholdBits\(pixels, w, h, threshold\(\)\)/.test(inline));
check('the copy says which direction is darker',
  /higher = darker/.test(html) && !/lower = darker/.test(html));

/* ------------------------------------------------- 2b. the page does no layout maths */
console.log('\n== the page does not compute positions itself ==');
/* The batch bug was a coordinate added twice in the page's drawing code, which no module
 * test could see. The rule that prevents a repeat: the page draws what the planner gives it
 * and never touches a plan's own offsets. */
check('the page uses the planner for absolute placement',
  /Label\.absoluteLayout\(/.test(inline));
check('the page never reads plan.y (all offsets come from the planner)',
  !/\bplan\.y\b/.test(inline), 'plan.y appears in the page');
check('the page never adds a label offset to a baseline',
  !/top\s*\+\s*(line|baseline)/.test(inline));
check('the planner exports absoluteLayout', (() => {
  const label = readFileSync(join(web, 'label.js'), 'utf8');
  return /absoluteLayout/.test(label) && /absoluteLayout,/.test(label);
})());
/* the density default the user asked for, matching the vendor app */
check('the density slider defaults to 4', /id="density"[^>]*value="4"/.test(html));
check('the density readout starts at 4', /id="denLabel">4</.test(html));
check('the density fallback in code is 4', /parseInt\(\$\('density'\)\.value, 10\) \|\| 4/.test(inline));

/* ------------------------------------------------- 3. the offline shell */
console.log('\n== the offline copy covers the app ==');
const sw = readFileSync(join(web, 'sw.js'), 'utf8');
const precached = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
for (const need of ['index.html', 'funnyprint.js', 'codes.js', 'label.js',
  'vendor/qrcode.js', 'vendor/code128-table.js']) {
  check(`the worker pre-caches ${need}`, precached.includes(need), JSON.stringify(precached));
}
check('the worker cache name is build-stamped, not fixed', /pocketprint-__BUILD__/.test(sw));
check('the worker never fetches off-origin', /origin === self\.location\.origin/.test(sw));
/* Without cache: 'no-cache' the worker's own fetch goes through the browser's HTTP cache, so
 * an installed app keeps serving stale scripts even on a pull-to-refresh. */
check('the worker revalidates instead of trusting the HTTP cache',
  /fetch\(req, \{ cache: 'no-cache' \}\)/.test(sw));

/* ------------------------------------------------- 3b. version handshake */
console.log('\n== the page notices when its scripts are stale ==');
check('the page lists the APIs it needs', /REQUIRED_API/.test(inline));
check('it checks for the placement function that broke the previews',
  /PocketLabel\.absoluteLayout'/.test(inline));
check('it reports the mismatch instead of freezing silently',
  /missingApi/.test(inline) && /out of step|stale/i.test(inline));
check('deploy.sh stamps every script, not just one',
  (() => {
    const deploy = readFileSync(join(web, '..', 'deploy.sh'), 'utf8');
    const stamped = [...deploy.matchAll(/for asset in ([^;]+);/g)].map((m) => m[1]).join(' ');
    return ['funnyprint.js', 'codes.js', 'label.js'].every((f) => stamped.includes(f));
  })());

/* ------------------------------------------------- 4. the installable bits */
console.log('\n== installable ==');
check('the page links the manifest', /rel="manifest"/.test(html));
const manifest = JSON.parse(readFileSync(join(web, 'manifest.webmanifest'), 'utf8'));
check('the manifest names the app', manifest.name === 'Pocket Print');
check('the manifest runs standalone', manifest.display === 'standalone');
for (const icon of manifest.icons) {
  check(`manifest icon ${icon.src} exists`, existsSync(join(web, icon.src)), icon.src);
}
check('there is a maskable icon for Android launchers',
  manifest.icons.some((i) => i.purpose === 'maskable'));
check('the page registers the worker', /serviceWorker\.register/.test(inline));
check('the worker is only registered over http(s)', /location\.protocol\.startsWith\('http'\)/.test(inline));

/* ------------------------------------------------- 5. the no-network promise */
console.log('\n== the no-network promise ==');
const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
check('the page loads nothing from another origin', externals.length === 0, JSON.stringify(externals));
const externalCalls = [...inline.matchAll(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/g)]
  .map((m) => m[1]);
check('the page code makes no network calls', externalCalls.length === 0, JSON.stringify(externalCalls));
check('the QR encoder is vendored, not pulled from a CDN',
  !/cdn|unpkg|jsdelivr/.test(html) && existsSync(join(web, 'vendor/qrcode.js')));

console.log();
if (failures) { console.log(`FAILED: ${failures}`); process.exit(1); }
console.log('all wiring tests passed');
