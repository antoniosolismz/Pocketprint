/* Pocket Print — label layout planning.
 *
 * Pure geometry: no canvas, no DOM, no Bluetooth. It answers "how tall is this label, where
 * does each block go, where do the cut guides land, and does anything overflow the 384-dot
 * head?" The page and the CLI both draw from this plan.
 *
 * That separation is deliberate. Layout mistakes are invisible until they are printed — a
 * block that runs off the bottom just silently loses half a sentence — so the arithmetic
 * lives somewhere it can be tested without paper.
 *
 * Units: dots. A 203 dpi head is 7.992 dots per millimetre, so 384 dots = 48.0 mm.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const deps = {
    wrapText: isNode ? require('./funnyprint.js').wrapText : root.FunnyPrint.wrapText,
    codes: isNode ? require('./codes.js') : root.PocketCodes,
  };
  const api = factory(deps);
  if (isNode) module.exports = api;
  else { root.PocketLabel = api; if (root.FunnyPrint) root.FunnyPrint.label = api; }
}(typeof self !== 'undefined' ? self : this, function (deps) {
  'use strict';

  const DOTS_PER_MM = 203 / 25.4;        // 7.9921… on a 203 dpi head
  const WIDTH = 384;                     // the print head, unchangeable
  const MM = (mm) => Math.round(mm * DOTS_PER_MM);
  const dotsToMm = (dots) => +(dots / DOTS_PER_MM).toFixed(1);

  const DEFAULTS = {
    width: WIDTH,
    padding: 16,          // dots of margin left and right
    gap: 14,              // dots between stacked blocks
    titleSize: 30,        // dots, roughly 11 pt on this head
    subtitleSize: 22,
    lineSpacing: 1.3,     // multiple of the font size
    align: 'left',        // left | center | right
    cutGuide: true,       // dashed tear line above each label
    tearMm: 6,            // blank feed after a label so it can be torn off cleanly
    border: false,        // box around the label
    borderInset: 4,
  };

  /* A monotone measure for when the caller has no canvas: 0.6 em per character is close
   * enough to a monospace face to plan with. Tests use the same function. */
  function approximateMeasure(size) {
    return (text) => String(text).length * size * 0.602;
  }

  function resolveText(spec, ctx) {
    const lines = [];
    const measure = ctx.measure || approximateMeasure(spec.titleSize);
    const size = spec.titleSize;
    const maxWidth = spec.width - spec.padding * 2 - (spec.border ? spec.borderInset * 2 : 0);
    const title = (spec.title || '').trim();
    if (title) {
      for (const line of deps.wrapText(measure, title, maxWidth)) {
        lines.push({ text: line, size, emphasis: true });
      }
    }
    const subtitle = (spec.subtitle || '').trim();
    if (subtitle) {
      const subMeasure = ctx.measureSub || approximateMeasure(spec.subtitleSize);
      for (const line of deps.wrapText(subMeasure, subtitle, maxWidth)) {
        lines.push({ text: line, size: spec.subtitleSize, emphasis: false });
      }
    }
    return lines;
  }

  /* Lay one label out. Returns where every block goes and how tall the label is. */
  function planLabel(spec, ctx) {
    const s = Object.assign({}, DEFAULTS, spec || {});
    const c = ctx || {};
    const warnings = [];
    const blocks = [];

    const innerWidth = s.width - s.padding * 2;

    const textLines = resolveText(s, c);
    if (textLines.length) {
      let h = 0;
      const lines = textLines.map((line) => {
        const height = Math.round(line.size * s.lineSpacing);
        h += height;
        return { ...line, height };
      });
      blocks.push({ kind: 'text', lines, height: h });
    }

    if (s.code && s.code.text) {
      const kind = s.code.kind === 'code128' ? 'code128' : 'qr';
      const target = s.width - s.padding * 2 - (s.border ? s.borderInset * 2 : 0);
      try {
        const bitmap = kind === 'qr'
          ? deps.codes.qrBitmap(s.code.text, {
              targetDots: target,
              ecc: s.code.ecc || 'M',
              moduleDots: s.code.moduleDots,
              minDots: s.code.minDots,
            })
          : deps.codes.code128Bitmap(s.code.text, {
              height: s.code.height || MM(s.code.heightMm || 9),
              moduleDots: s.code.moduleDots,
            });
        blocks.push({ kind, bitmap, height: bitmap.h });
        if (kind === 'qr' && !bitmap.reliable) {
          warnings.push(`QR modules are ${bitmap.moduleMm} mm — under 0.35 mm phones hesitate; ` +
            'shorten the text or raise the error-correction level to L');
        }
      } catch (err) {
        warnings.push(`${kind === 'qr' ? 'QR' : 'Barcode'}: ${err.message}`);
      }
    }

    if (!blocks.length) warnings.push('nothing to print: add text or a code');

    /* stack them */
    const contentHeight = blocks.reduce((n, b) => n + b.height, 0) -
      (blocks.length ? 0 : 0) + Math.max(0, blocks.length - 1) * s.gap;
    const frame = s.border ? s.borderInset * 2 + 2 : 0;
    const labelHeight = s.padding * 2 + contentHeight + frame;

    let y = s.padding + frame / 2;
    for (const block of blocks) {
      block.y = Math.round(y);
      block.x = s.border ? s.padding + s.borderInset : s.padding;
      block.width = s.border ? s.width - (s.padding + s.borderInset) * 2 : innerWidth;
      y = block.y + block.height + s.gap;
    }

    const tear = s.tearMm ? MM(s.tearMm) : 0;
    return {
      width: s.width,
      height: labelHeight,
      blocks,
      border: s.border ? {
        x: s.padding - s.borderInset,
        y: s.padding - s.borderInset,
        w: s.width - (s.padding - s.borderInset) * 2,
        h: labelHeight - (s.padding - s.borderInset) * 2,
      } : null,
      cutGuide: s.cutGuide ? { dash: 6, gap: 4 } : null,
      tear,
      totalHeight: labelHeight + tear,
      heightMm: dotsToMm(labelHeight + tear),
      warnings,
      spec: s,
    };
  }

  /* Absolute positions for everything in a label, ready to draw.
   *
   * This exists because of a bug worth remembering: the page used to place text itself, at
   * `plan.y + baseline`, where `baseline` already included `plan.y`. The first label on a
   * sheet sits at y = 0 and looked perfect; every label after it landed one full label-height
   * too low, so half of a four-label batch printed off the bottom of the paper while the cut
   * guides (computed here, absolutely) stayed in the right places.
   *
   * So all placement arithmetic lives here, where it is tested, and the page just draws what
   * it is given — it never adds an offset of its own.
   */
  function absoluteLayout(plan) {
    const top = plan.y || 0;
    const pad = plan.spec.padding;
    const align = plan.spec.align || 'left';
    const texts = [];
    const codes = [];

    for (const block of plan.blocks) {
      if (block.kind === 'text') {
        let y = top + block.y;
        for (const line of block.lines) {
          texts.push({
            text: line.text,
            x: align === 'center' ? plan.width / 2 : align === 'right' ? plan.width - pad : pad,
            y: y + line.height - Math.round(line.height * 0.28),   // alphabetic baseline
            height: line.height,
            size: line.size,
            emphasis: line.emphasis,
            align,
          });
          y += line.height;
        }
      } else if (block.bitmap) {
        const bm = block.bitmap;
        codes.push({ bitmap: bm, x: Math.floor((plan.width - bm.w) / 2), y: top + block.y });
      }
    }

    return {
      y: top,
      height: plan.height,
      bottom: top + plan.height,
      border: plan.border ? {
        x: plan.border.x, y: top + plan.border.y, w: plan.border.w, h: plan.border.h,
      } : null,
      texts,
      codes,
    };
  }

  /* Stack N labels into one continuous sheet, with a cut guide between them.
   * `items` are specs; a bare string becomes a title-only label. */
  function planSheet(items, ctx) {
    const list = (items || []).map((item) =>
      (typeof item === 'string' ? { title: item } : item));
    if (!list.length) return { labels: [], height: 0, cutYs: [], width: WIDTH, warnings: ['nothing to print'] };

    const labels = [];
    const cutYs = [];
    const warnings = [];
    let y = 0;
    list.forEach((spec, i) => {
      const plan = planLabel(spec, ctx);
      plan.y = y;
      labels.push(plan);
      if (plan.cutGuide && i > 0) cutYs.push(y);   // a guide sits on every seam
      warnings.push(...plan.warnings.map((w) => `label ${i + 1}: ${w}`));
      y += plan.totalHeight;
    });
    return {
      labels, height: y, cutYs, width: labels[0].width, warnings,
      heightMm: dotsToMm(y),
      /* how much paper this job eats, which matters because it is continuous stock */
      paperMm: dotsToMm(y),
    };
  }

  /* One label per line of a pasted list — the "label forty cables" path. Blank lines are
   * dropped rather than printing empty labels. */
  function itemsFromList(text, base) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length)
      .map((line) => {
        const spec = Object.assign({}, base || {});
        /* "Title<TAB>subtitle" or "Title | subtitle" splits into two lines */
        const parts = line.split(/\t|\s\|\s/);
        spec.title = parts[0].trim();
        if (parts.length > 1) spec.subtitle = parts.slice(1).join(' ').trim();
        return spec;
      });
  }

  return {
    DOTS_PER_MM, WIDTH, MM, dotsToMm, planLabel, planSheet, itemsFromList,
    absoluteLayout, approximateMeasure, DEFAULTS,
  };
}));
