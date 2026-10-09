/**
 * Music Video — the in-page half of the overlay text check (overlayTextService.js).
 *
 * Installed before a composition document's own scripts (openComposition
 * `initScripts`). Between `begin()` and `end()` it records every piece of text
 * the page draws: canvas `fillText` / `strokeText` (its glyph box through the
 * current transform, the font, colours, outline width, shadow and alpha) and
 * visible DOM / SVG text. While a capture is open the text is also HIDDEN —
 * canvas text calls are skipped and DOM text turns transparent — so the
 * screenshot taken after `end()` shows exactly what sits behind the words
 * (picture, plates, scrims), which is what contrast is measured against.
 *
 * Text drawn on a canvas that is not in the document (an offscreen canvas, a
 * WebGL texture) cannot be placed on the frame and is not recorded.
 *
 * The function is serialized into the page, so it must stay self-contained.
 */
function overlayTextProbe() {
  const C2D = globalThis.CanvasRenderingContext2D?.prototype;
  if (!C2D || globalThis.__portosTextProbe) return;
  const MAX_RECORDS = 400;
  // `on` records; `hidden` (from the first begin() on) keeps every later text
  // call off the canvas, so a redraw between end() and the screenshot (an
  // animation-frame loop) cannot paint the words back over the backdrop.
  const state = { on: false, hidden: false, records: [], seq: 0, style: null };
  const canvases = [];
  const fillText = C2D.fillText;
  const strokeText = C2D.strokeText;
  const layerOf = (canvas) => {
    let index = canvases.indexOf(canvas);
    if (index < 0) { canvases.push(canvas); index = canvases.length - 1; }
    return `canvas-${index}`;
  };
  const colorOf = (style) => (typeof style === 'string' ? style : null);
  const emOf = (font) => {
    const match = /(\d+(?:\.\d+)?)px/.exec(String(font || ''));
    return match ? Number(match[1]) : null;
  };
  function recordCanvas(ctx, kind, text, x, y, maxWidth) {
    if (state.records.length >= MAX_RECORDS) return;
    const canvas = ctx.canvas;
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected || !canvas.width || !canvas.height) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const str = String(text);
    if (!str.trim()) return;
    const sx = rect.width / canvas.width;
    const sy = rect.height / canvas.height;
    const m = ctx.measureText(str);
    let left = -m.actualBoundingBoxLeft;
    let right = m.actualBoundingBoxRight;
    if (maxWidth != null && Number.isFinite(maxWidth) && m.width > maxWidth && m.width > 0) {
      left *= maxWidth / m.width;
      right *= maxWidth / m.width;
    }
    const top = -m.actualBoundingBoxAscent;
    const bottom = m.actualBoundingBoxDescent;
    const T = ctx.getTransform();
    const xs = [];
    const ys = [];
    for (const [px, py] of [[x + left, y + top], [x + right, y + top], [x + left, y + bottom], [x + right, y + bottom]]) {
      xs.push(rect.left + (T.a * px + T.c * py + T.e) * sx);
      ys.push(rect.top + (T.b * px + T.d * py + T.f) * sy);
    }
    const scale = Math.sqrt(Math.abs(T.a * T.d - T.b * T.c)) * Math.sqrt(sx * sy);
    const em = emOf(ctx.font);
    const shadow = ctx.shadowBlur > 0 || ctx.shadowOffsetX || ctx.shadowOffsetY
      ? { color: colorOf(ctx.shadowColor), px: (ctx.shadowBlur / 2) * Math.sqrt(sx * sy) } : null;
    state.records.push({
      seq: state.seq++, source: 'canvas', layer: layerOf(canvas), kind, text: str.slice(0, 160),
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      emPx: em ? em * scale : null, font: String(ctx.font || ''),
      color: kind === 'fill' ? colorOf(ctx.fillStyle) : colorOf(ctx.strokeStyle),
      lineWidth: kind === 'stroke' ? ctx.lineWidth * scale : 0,
      alpha: ctx.globalAlpha, shadow,
    });
  }
  const wrap = (original, kind) => function (text, x, y, maxWidth) {
    if (state.on) {
      try { recordCanvas(this, kind, text, x, y, maxWidth); } catch { /* a probe fault never breaks the page */ }
    }
    if (state.hidden) return undefined;
    return maxWidth === undefined ? original.call(this, text, x, y) : original.call(this, text, x, y, maxWidth);
  };
  C2D.fillText = wrap(fillText, 'fill');
  C2D.strokeText = wrap(strokeText, 'stroke');

  function opacityOf(element) {
    let alpha = 1;
    for (let el = element; el && el.nodeType === 1; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return 0;
      alpha *= Number(cs.opacity);
    }
    return alpha;
  }
  function domRecords() {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && out.length < MAX_RECORDS; node = walker.nextNode()) {
      const text = node.nodeValue.replace(/\s+/g, ' ').trim();
      const el = node.parentElement;
      if (!text || !el || el.closest('script, style, noscript, template, title')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible') continue;
      const alpha = opacityOf(el);
      if (!(alpha > 0)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const svg = el instanceof SVGElement;
      const strokeWidth = svg ? parseFloat(cs.strokeWidth) || 0 : parseFloat(cs.webkitTextStrokeWidth) || 0;
      const stroke = svg ? (cs.stroke !== 'none' ? cs.stroke : null) : cs.webkitTextStrokeColor;
      const shadow = !svg && cs.textShadow && cs.textShadow !== 'none'
        ? { color: (/rgba?\([^)]*\)/.exec(cs.textShadow) || [null])[0], px: Math.max(...(cs.textShadow.match(/(\d+(?:\.\d+)?)px/g) || ['0px']).map(parseFloat)) / 2 }
        : null;
      const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const base = { source: 'dom', layer: 'dom', text: text.slice(0, 160), x0: box.left, y0: box.top, x1: box.right, y1: box.bottom,
        emPx: parseFloat(cs.fontSize) || null, font, alpha, shadow };
      if (strokeWidth > 0 && stroke) out.push({ ...base, seq: state.seq++, kind: 'stroke', color: stroke, lineWidth: strokeWidth });
      out.push({ ...base, seq: state.seq++, kind: 'fill', color: svg ? (cs.fill !== 'none' ? cs.fill : null) : cs.color, lineWidth: 0, shadow });
    }
    return out;
  }
  const HIDE_CSS = '*, *::before, *::after { color: transparent !important; -webkit-text-stroke-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } svg text, svg tspan, svg textPath { fill: transparent !important; stroke: transparent !important; }';
  globalThis.__portosTextProbe = Object.freeze({
    /** Start recording (and hiding) text for the next seek. */
    begin() {
      state.style?.remove();
      state.style = null;
      state.records = [];
      state.seq = 0;
      state.on = true;
      state.hidden = true;
      return true;
    },
    /** Stop recording; returns every text record and hides DOM text for the backdrop screenshot. */
    end() {
      state.on = false;
      const records = state.records.concat(domRecords());
      state.records = [];
      const style = document.createElement('style');
      style.textContent = HIDE_CSS;
      (document.head || document.documentElement).appendChild(style);
      state.style = style;
      return records;
    },
  });
}

/** The script openComposition installs (an IIFE of overlayTextProbe). */
export const OVERLAY_TEXT_PROBE_SCRIPT = `(${overlayTextProbe.toString()})();`;
