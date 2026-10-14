/* Pocket Print — codes: QR (via the vendored MIT encoder) and Code 128 (ISO/IEC 15417).
 *
 * Everything here is pure: text in, a 1-bit bitmap out. No DOM, no network, so it can be
 * tested in Node and reused by the CLI.
 *
 * The one rule that matters for print: a QR or barcode module must be a WHOLE number of
 * printer dots. Scale a 25-module QR to "380 dots" with a fractional module size and the
 * modules come out uneven, which is how you get a code that looks perfect and refuses to
 * scan. So every helper here snaps to an integer module size and centres the result.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const qrcode = isNode ? require('./vendor/qrcode.js') : root.qrcode;
  const table = isNode ? require('./vendor/code128-table.js') : root.CODE128_TABLE;
  /* Fail loudly: a missing vendor script used to leave this module silently half-alive,
   * which showed up as "cannot read qrBitmap of undefined" three layers away. */
  if (!qrcode || !table) {
    throw new Error('codes.js requires vendor/qrcode.js and vendor/code128-table.js to be loaded first');
  }
  const api = factory(qrcode, table);
  if (isNode) module.exports = api;
  else { root.PocketCodes = api; if (root.FunnyPrint) root.FunnyPrint.codes = api; }
}(typeof self !== 'undefined' ? self : this, function (qrcode, table) {
  'use strict';

  const { CODE128_CODES: CODES, CODE128_STOP: STOP, CODE128_START: START } = table;

  /* --------------------------------------------------------------------- QR */

  const ECC_LEVELS = ['L', 'M', 'Q', 'H'];

  /* Returns { size, rows: ['0101…', …] } — the raw module matrix, no scaling. */
  function qrMatrix(text, opts) {
    const o = opts || {};
    const ecc = ECC_LEVELS.includes(o.ecc) ? o.ecc : 'M';
    const qr = qrcode(o.typeNumber || 0, ecc);   // 0 = smallest version that fits
    qr.addData(String(text));
    qr.make();
    const n = qr.getModuleCount();
    const rows = [];
    for (let r = 0; r < n; r++) {
      let line = '';
      for (let c = 0; c < n; c++) line += qr.isDark(r, c) ? '1' : '0';
      rows.push(line);
    }
    return { size: n, rows, ecc };
  }

  /* The largest whole number of dots per module that still fits `targetDots`,
   * or 0 if even `minDots` does not. `quiet` is in modules (spec says 4). */
  function fitModuleDots(modules, targetDots, opts) {
    const o = opts || {};
    const quiet = o.quiet === undefined ? 4 : o.quiet;
    const minDots = o.minDots === undefined ? 2 : o.minDots;
    const total = modules + quiet * 2;
    const m = Math.floor(targetDots / total);
    return m >= minDots ? m : 0;
  }

  /* A print-ready QR: integer module size, spec quiet zone, centred in `targetDots`. */
  function qrBitmap(text, opts) {
    const o = opts || {};
    const target = o.targetDots || 384;
    const matrix = qrMatrix(text, o);
    const quiet = o.quiet === undefined ? 4 : o.quiet;
    const m = o.moduleDots || fitModuleDots(matrix.size, target, { quiet: quiet, minDots: o.minDots });
    if (!m) {
      throw new Error(
        `a ${matrix.size}-module QR needs more than ${target} dots at ${o.minDots || 2} ` +
        'dots per module; shorten the text or use a lower error-correction level');
    }
    const total = (matrix.size + quiet * 2) * m;
    const w = Math.max(total, target);
    const h = total;
    const bits = new Uint8Array(w * h);
    const x0 = Math.floor((w - total) / 2);
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (matrix.rows[r][c] !== '1') continue;
        const py = (r + quiet) * m;
        const px = x0 + (c + quiet) * m;
        for (let dy = 0; dy < m; dy++) {
          const rowStart = (py + dy) * w + px;
          bits.fill(1, rowStart, rowStart + m);
        }
      }
    }
    return {
      w, h, bits, modules: matrix.size, moduleDots: m, ecc: matrix.ecc, x0, y0: 0,
      /* 0.25 mm per dot on a 203 dpi head; below ~0.35 mm phone cameras get flaky. */
      moduleMm: +(m / 7.992).toFixed(3),
      reliable: m >= 3,
    };
  }

  /* ---------------------------------------------------------------- Code 128 */

  const COMMON = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_';
  const CONTROL = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i));

  /* Entries, not characters: 'TO_B'/'SHIFT' are single symbols occupying one value. */
  const CHARS_A = [...COMMON.split(''), ...CONTROL,
    '\u00f3', '\u00f2', 'SHIFT', 'TO_C', 'TO_B', '\u00f4', '\u00f1'];
  const CHARS_B = [...COMMON.split(''), ...'`abcdefghijklmnopqrstuvwxyz{|}~'.split(''), '\x7f',
    '\u00f3', '\u00f2', 'SHIFT', 'TO_C', '\u00f4', 'TO_A', '\u00f1'];

  const MAP_A = new Map(CHARS_A.map((c, i) => [c, i]));
  const MAP_B = new Map(CHARS_B.map((c, i) => [c, i]));
  const TO_C = 99, TO_B = 100, TO_A = 101;
  const TO = { 101: START.A, 100: START.B, 99: START.C };
  const C_MAP = { TO_B, TO_A };

  /* Faithful port of python-barcode's encoder (which follows ISO/IEC 15417): start in
   * charset C, switch when a run of digits makes C worth it or when a character forces A/B,
   * and collapse a leading start+switch pair. Verified byte-for-byte against it in tests. */
  function code128Values(text) {
    const s = String(text);
    let charset = 'C';
    let buffer = '';
    const out = [START.C];

    const map = () => (charset === 'A' ? MAP_A : charset === 'B' ? MAP_B : C_MAP);
    /* charset C's map is a plain object (its values are digit pairs), the others are Maps */
    const lookup = (key) => (charset === 'C' ? C_MAP[key] : map().get(key));
    const convert = (ch) => {
      if (charset === 'C') {
        if (C_MAP[ch] !== undefined) return C_MAP[ch];
        if (ch >= '0' && ch <= '9') {
          buffer += ch;
          if (buffer.length === 2) { const v = parseInt(buffer, 10); buffer = ''; return v; }
          return undefined;
        }
        return undefined;
      }
      const v = map().get(ch);
      if (v === undefined) throw new Error(`Code 128 cannot encode ${JSON.stringify(ch)}`);
      return v;
    };
    const newCharset = (which) => {
      const code = lookup('TO_' + which);
      charset = which;
      return [code];
    };

    const digitsAhead = (pos) => {
      let n = 0;
      for (const c of s.slice(pos, pos + 10)) { if (c >= '0' && c <= '9') n++; else break; }
      return n > 3;
    };

    for (let pos = 0; pos < s.length; pos++) {
      const ch = s[pos];
      if (charset === 'C' && !(ch >= '0' && ch <= '9')) {
        if (MAP_B.has(ch)) out.push(...newCharset('B'));
        else if (MAP_A.has(ch)) out.push(...newCharset('A'));
        if (buffer.length === 1) { out.push(convert(buffer[0])); buffer = ''; }
      } else if (charset === 'B') {
        if (digitsAhead(pos)) out.push(...newCharset('C'));
        else if (!MAP_B.has(ch) && MAP_A.has(ch)) out.push(...newCharset('A'));
      } else if (charset === 'A') {
        if (digitsAhead(pos)) out.push(...newCharset('C'));
        else if (!MAP_A.has(ch) && MAP_B.has(ch)) out.push(...newCharset('B'));
      }
      const v = convert(ch);
      if (v !== undefined) out.push(v);
    }
    if (buffer.length === 1) { out.push(...newCharset('B')); out.push(convert(buffer[0])); buffer = ''; }

    /* A payload that starts with a non-digit collapses to a single start code. */
    if (TO[out[1]] !== undefined) out.splice(0, 2, TO[out[1]]);
    return out;
  }

  function code128Checksum(values) {
    let sum = values[0];
    for (let i = 1; i < values.length; i++) sum += i * values[i];
    return sum % 103;
  }

  /* The module pattern as a '101100…' string, quiet zone NOT included. */
  function code128Bits(text) {
    const values = code128Values(text);
    values.push(code128Checksum(values));      // the checksum is a symbol like any other
    return values.map((v) => CODES[v]).join('') + STOP + '11';
  }

  /* A print-ready Code 128: integer module width, height in dots, quiet zones in dots. */
  function code128Bitmap(text, opts) {
    const o = opts || {};
    const bits = code128Bits(text);
    const mw = o.moduleDots || 2;                    // 2 dots ≈ 0.25 mm, the spec minimum
    const quietDots = o.quietDots === undefined ? 10 * mw : o.quietDots;
    const height = o.height || 60;
    const w = bits.length * mw + quietDots * 2;
    if (w > 384) {
      throw new Error(`Code 128 for ${bits.length} modules needs ${w} dots; the head is 384 wide`);
    }
    const out = new Uint8Array(w * height);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i] !== '1') continue;
      const x0 = quietDots + i * mw;
      for (let y = 0; y < height; y++) {
        const rowStart = y * w + x0;
        out.fill(1, rowStart, rowStart + mw);
      }
    }
    return { w, h: height, bits: out, modules: bits.length, moduleDots: mw, quietDots };
  }

  /* ------------------------------------------------------------------ helpers */

  /* Compose several bitmaps side by side (or stacked) into one, for label layouts. */
  function compose(parts, opts) {
    const o = opts || {};
    const width = o.width || Math.max(...parts.map((p) => p.w));
    const gap = o.gap === undefined ? 0 : o.gap;
    const height = parts.reduce((n, p) => n + p.h, 0) + gap * (parts.length - 1);
    const bits = new Uint8Array(width * height);
    let y = 0;
    for (const part of parts) {
      const x0 = o.align === 'left' ? 0 : o.align === 'right' ? width - part.w : Math.floor((width - part.w) / 2);
      for (let row = 0; row < part.h; row++) {
        for (let col = 0; col < part.w; col++) {
          if (part.bits[row * part.w + col]) bits[(y + row) * width + x0 + col] = 1;
        }
      }
      y += part.h + gap;
    }
    return { w: width, h: height, bits };
  }

  /* Does this text encode without throwing? Used by the UI to warn before printing. */
  function canEncode(kind, text, opts) {
    try {
      if (kind === 'qr') qrBitmap(text, opts);
      else code128Bitmap(text, opts);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  }

  return {
    qrMatrix, qrBitmap, fitModuleDots, code128Values, code128Bits, code128Bitmap,
    code128Checksum, compose, canEncode, ECC_LEVELS, CODES,
  };
}));
