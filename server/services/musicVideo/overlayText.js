/**
 * Music Video — overlay text quality pass (pure half; I/O in overlayTextService.js).
 *
 * The check renders a composition document at the moments text appears (each
 * lyric line and text cue, and every shot), records where every word lands
 * (overlayTextProbe.js) and what sits behind it, and flags what a viewer on a
 * phone would trip over:
 *
 *   overlap    two separate pieces of text collide (a corner readout under a lyric)
 *   off-frame  text runs past the edge of the frame and is cut off
 *   contrast   the words blend into the picture behind them: too little
 *              contrast and no outline or shadow wide enough to separate them
 *   small      text too small to read at phone width (390px)
 *
 * Contrast follows the shared lyric type (lyricType.js): a cream fill with an
 * ink outline reads on any picture, so an outline that is visible at phone
 * size passes on its own; a dark backing plate also passes (it is part of the
 * measured backdrop), but the fix this check recommends is an outline.
 *
 * Findings repeat across samples (a readout stays up for a whole shot), so one
 * finding is kept per problem and text, with every time it was seen.
 */
import { createHash, randomUUID } from 'node:crypto';

const PHONE_WIDTH_PX = 390;
const OVERLAY_TEXT_LIMITS = Object.freeze({
  maxSamples: 180,
  maxFindings: 40,
  maxTimesPerFinding: 8,
  // Smallest em (font size) still readable at phone width, in phone pixels.
  minPhoneEmPx: 8,
  // At or above this em (phone px) text counts as large (WCAG 3:1, else 4.5:1).
  largePhoneEmPx: 18,
  contrastLarge: 3,
  contrastSmall: 4.5,
  // An outline / shadow separates the words when this wide outside the glyph at phone width…
  minHaloPhonePx: 0.6,
  // …and this different from the fill.
  minHaloContrast: 3,
  // Text more transparent than this is mid-fade: skipped for overlap and size.
  minAlpha: 0.35,
  // Contrast is judged only on settled (near-opaque) text.
  contrastAlpha: 0.85,
});
const OVERLAY_TEXT_KINDS = Object.freeze(['overlap', 'off-frame', 'contrast', 'small']);
const SEVERITY = Object.freeze({ overlap: 'error', 'off-frame': 'error', contrast: 'warning', small: 'warning' });
// The process that owns a running check; a record left `running` by another process was interrupted.
export const OVERLAY_TEXT_PROCESS_ID = randomUUID();

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const round3 = (n) => Math.round(n * 1000) / 1000;
const round1 = (n) => Math.round(n * 10) / 10;

/** `{ r, g, b, a }` (0-255, alpha 0-1) for a CSS colour a canvas or computed style reports; null otherwise. */
function parseCssColor(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = 'f'] = hex.split('').map((c) => c + c);
      return { r: parseInt(r, 16), g: parseInt(g, 16), b: parseInt(b, 16), a: parseInt(a, 16) / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1 };
    }
    return null;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (!m) return null;
  const alpha = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: Math.min(255, +m[1]), g: Math.min(255, +m[2]), b: Math.min(255, +m[3]), a: Math.max(0, Math.min(1, alpha)) };
}

const channel = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
/** WCAG relative luminance (0-1) of an sRGB colour. */
const relativeLuminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** A 256-entry sRGB → linear table, for per-pixel luminance of a screenshot. */
export const SRGB_TO_LINEAR = Object.freeze(Array.from({ length: 256 }, (_, c) => channel(c)));
/** WCAG contrast ratio (1-21) between two relative luminances. */
const contrastRatio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Song times (seconds, on the frame grid) to sample: each lyric line and text
 * cue once settled (0.35s after it starts), mid-way through a long one and near
 * its end; each shot just after it starts and at its middle. Times closer than
 * 0.15s collapse; more than `maxSamples` thin evenly.
 */
export function planTextSampleTimes({ lyrics = [], textCues = [], scenes = [], durationSec, fps = 24, maxSamples = OVERLAY_TEXT_LIMITS.maxSamples }) {
  if (!(durationSec > 0)) return [];
  const times = [];
  const span = (start, end) => {
    if (!finite(start)) return;
    const stop = finite(end) && end > start ? end : start + 1;
    const length = stop - start;
    times.push(start + Math.min(0.35, length / 2));
    if (length > 1.2) times.push((start + stop) / 2);
    if (length > 2.4) times.push(stop - 0.2);
  };
  for (const line of Array.isArray(lyrics) ? lyrics : []) {
    const words = Array.isArray(line?.words) ? line.words.filter((w) => finite(w?.startSec)) : [];
    const end = finite(line?.endSec) ? line.endSec : words.length ? Math.max(...words.map((w) => (finite(w.endSec) ? w.endSec : w.startSec))) : null;
    span(line?.startSec ?? words[0]?.startSec, end);
  }
  for (const cue of Array.isArray(textCues) ? textCues : []) span(cue?.startSec, cue?.endSec);
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    if (!finite(scene?.startSec) || !finite(scene?.endSec) || scene.endSec <= scene.startSec) continue;
    times.push(scene.startSec + Math.min(0.25, (scene.endSec - scene.startSec) / 2));
    times.push((scene.startSec + scene.endSec) / 2);
  }
  const last = Math.max(0, Math.floor(durationSec * fps - 1e-6) / fps);
  const snapped = times
    .map((t) => Math.min(last, Math.max(0, Math.floor(t * fps + 1e-6) / fps)))
    .sort((a, b) => a - b);
  const kept = [];
  for (const t of snapped) if (!kept.length || t - kept[kept.length - 1] >= 0.15) kept.push(round3(t));
  if (kept.length <= maxSamples) return kept;
  return Array.from({ length: maxSamples }, (_, i) => kept[Math.floor(((i + 0.5) * kept.length) / maxSamples)]);
}

const widthOf = (b) => b.x1 - b.x0;
const heightOf = (b) => b.y1 - b.y0;
const emOf = (item) => (finite(item.emPx) && item.emPx > 0 ? item.emPx : heightOf(item));

/**
 * Collapse one sample's raw probe records into drawn words: the outline and the
 * fill of one word (drawn as separate calls) become one item with a face colour
 * (the fill, or the last outline for outline-only type) and halos (outlines
 * and shadows that ring the face).
 */
export function mergeTextRecords(records = []) {
  const items = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r.text !== 'string' || !(r.x1 > r.x0) || !(r.y1 > r.y0)) continue;
    const em = finite(r.emPx) && r.emPx > 0 ? r.emPx : r.y1 - r.y0;
    const tol = Math.max(3, em * 0.15);
    const same = items.find((it) => it.text === r.text && it.layer === r.layer
      && Math.abs(it.x0 - r.x0) <= tol && Math.abs(it.y0 - r.y0) <= tol && Math.abs(it.x1 - r.x1) <= tol && Math.abs(it.y1 - r.y1) <= tol);
    const item = same || { text: r.text, layer: r.layer, source: r.source, font: r.font || '', emPx: r.emPx ?? null,
      x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, alpha: 0, fill: null, strokes: [], shadows: [], seq: r.seq ?? items.length };
    if (!same) items.push(item);
    item.x0 = Math.min(item.x0, r.x0); item.y0 = Math.min(item.y0, r.y0);
    item.x1 = Math.max(item.x1, r.x1); item.y1 = Math.max(item.y1, r.y1);
    item.alpha = Math.max(item.alpha, finite(r.alpha) ? r.alpha : 1);
    if (r.kind === 'stroke' && r.lineWidth > 0) item.strokes.push({ color: r.color, width: r.lineWidth });
    else if (r.kind !== 'stroke' && r.color) item.fill = r.color;
    if (r.shadow?.color && r.shadow.px > 0) item.shadows.push({ color: r.shadow.color, px: r.shadow.px });
  }
  return items.map((item) => {
    // Outline-only type: the last (top) outline is the letter face; wider ones under it ring it.
    const face = item.fill || item.strokes.at(-1)?.color || null;
    const faceWidth = item.fill ? 0 : item.strokes.at(-1)?.width || 0;
    const halos = [
      ...item.strokes.filter((s) => s.width > faceWidth && s.color !== face).map((s) => ({ color: s.color, px: (s.width - faceWidth) / 2 })),
      ...item.shadows,
    ];
    const { strokes, shadows, fill, ...rest } = item;
    return { ...rest, face, halos };
  });
}

// Union-find over items: one block per run of text set in the same face that
// touches (a line's words, a wrapped paragraph). Blocks are what may collide.
function blocksOf(items) {
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a.layer !== b.layer || a.font !== b.font) continue;
      const em = Math.max(emOf(a), emOf(b));
      const dx = em * 0.6;
      const dy = em * 0.45;
      if (a.x0 - dx < b.x1 && b.x0 - dx < a.x1 && a.y0 - dy < b.y1 && b.y0 - dy < a.y1) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()];
}

// The block's words in reading order, as one short quote.
function blockText(block, max = 48) {
  const words = block.slice().sort((a, b) => (Math.abs(a.y0 - b.y0) > emOf(a) * 0.5 ? a.y0 - b.y0 : a.x0 - b.x0)).map((w) => w.text.trim());
  const text = words.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The contrast verdict for one drawn word against its backdrop luminance
 * percentiles (`backdrop: { p15, p50, p85 }`, 0-1). Null when it cannot be
 * judged (an unknown or gradient fill, no backdrop, mid-fade).
 */
function wordContrast(item, phoneScale) {
  const L = OVERLAY_TEXT_LIMITS;
  const face = parseCssColor(item.face);
  const bg = item.backdrop;
  if (!face || face.a < 0.5 || !bg || !finite(bg.p15) || !finite(bg.p85) || (item.alpha ?? 1) < L.contrastAlpha) return null;
  const lf = relativeLuminance(face);
  const ratio = Math.min(contrastRatio(lf, bg.p15), contrastRatio(lf, bg.p85));
  const phoneEm = emOf(item) * phoneScale;
  const needed = phoneEm >= L.largePhoneEmPx ? L.contrastLarge : L.contrastSmall;
  const halo = (item.halos || []).some((h) => {
    const color = parseCssColor(h.color);
    return color && color.a >= 0.5 && h.px * phoneScale >= L.minHaloPhonePx && contrastRatio(lf, relativeLuminance(color)) >= L.minHaloContrast;
  });
  return { ratio: round1(ratio), needed, halo, ok: ratio >= needed || halo, outlined: (item.halos || []).length > 0 };
}

/**
 * Luminance percentiles `{ p15, p50, p85 }` of the backdrop under a word's box
 * (`backdrop` from probeDocumentText: linear luminance at `scale` of the frame).
 * Null when the box misses the frame.
 */
export function backdropStats(backdrop, box) {
  if (!backdrop?.values || !box) return null;
  const { width, height, scale, values } = backdrop;
  const x0 = Math.max(0, Math.floor(box.x0 * scale));
  const y0 = Math.max(0, Math.floor(box.y0 * scale));
  const x1 = Math.min(width, Math.ceil(box.x1 * scale));
  const y1 = Math.min(height, Math.ceil(box.y1 * scale));
  if (x1 <= x0 || y1 <= y0) return null;
  // At most ~20k pixels per word: a stride keeps a full-width hook cheap.
  const stride = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  const picked = [];
  for (let y = y0; y < y1; y += stride) for (let x = x0; x < x1; x += stride) picked.push(values[y * width + x]);
  picked.sort((a, b) => a - b);
  const at = (q) => picked[Math.min(picked.length - 1, Math.floor(q * picked.length))];
  return { p15: at(0.15), p50: at(0.5), p85: at(0.85) };
}

/**
 * Problems in one sampled frame. `items` come from mergeTextRecords (with an
 * optional per-item `backdrop`); `frame` is `{ width, height }` in the same
 * pixels as the boxes. Returns `[{ kind, texts, detail }]`.
 */
export function analyzeTextFrame(items = [], frame) {
  const L = OVERLAY_TEXT_LIMITS;
  const W = frame?.width;
  const H = frame?.height;
  if (!(W > 0 && H > 0)) return [];
  const phoneScale = PHONE_WIDTH_PX / W;
  const visible = items.filter((it) => it.x1 > 0 && it.x0 < W && it.y1 > 0 && it.y0 < H && (it.alpha ?? 1) >= L.minAlpha);
  const blocks = blocksOf(visible);
  const issues = [];
  // Collisions: a word of one block crossing a word of another.
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const hit = blocks[i].some((a) => blocks[j].some((b) => {
        const tol = Math.max(2, Math.min(emOf(a), emOf(b)) * 0.08);
        return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > tol && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > tol;
      }));
      if (hit) issues.push({ kind: 'overlap', texts: [blockText(blocks[i]), blockText(blocks[j])], detail: null });
    }
  }
  for (const block of blocks) {
    const text = blockText(block);
    const tol = 2;
    if (block.some((w) => w.x0 < -tol || w.y0 < -tol || w.x1 > W + tol || w.y1 > H + tol)) {
      issues.push({ kind: 'off-frame', texts: [text], detail: null });
    }
    const phoneEm = Math.min(...block.map((w) => emOf(w) * phoneScale));
    if (phoneEm < L.minPhoneEmPx) issues.push({ kind: 'small', texts: [text], detail: { phoneEmPx: round1(phoneEm) } });
    const verdicts = block.map((w) => wordContrast(w, phoneScale)).filter(Boolean);
    const failing = verdicts.filter((v) => !v.ok);
    if (failing.length) {
      const worst = failing.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      issues.push({ kind: 'contrast', texts: [text], detail: { ratio: worst.ratio, needed: worst.needed, outlined: worst.outlined } });
    }
  }
  return issues;
}

const quote = (text) => `“${text}”`;
/** One plain sentence for a finding (what is wrong, and the fix lyricType uses). */
function describeTextFinding({ kind, texts, detail }) {
  switch (kind) {
    case 'overlap': return `${quote(texts[0])} collides with ${quote(texts[1])}. Move one to a free corner or time them apart.`;
    case 'off-frame': return `${quote(texts[0])} runs off the edge of the frame. Keep it inside the safe margin or let it wrap.`;
    case 'small': return `${quote(texts[0])} is ${detail?.phoneEmPx ?? 'too few'}px tall at phone width. Set it larger (at least ${OVERLAY_TEXT_LIMITS.minPhoneEmPx}px on a phone).`;
    case 'contrast': return `${quote(texts[0])} blends into the picture (${detail?.ratio ?? '?'}:1). Give it an ink outline wide enough to read on a phone${detail?.outlined ? ' (its outline is too thin there)' : ''}.`;
    default: return quote(texts.join(' / '));
  }
}

// Words appear one by one, so the same line reads "whole", then "whole species
// bloom": a finding of the same kind whose text contains (or is contained in)
// another's, seen within a few seconds, is the same problem.
const SAME_TEXT_WINDOW_SEC = 8;
const contains = (a, b) => {
  const x = a.toLowerCase().replace(/…$/, '');
  const y = b.toLowerCase().replace(/…$/, '');
  // A very short fragment ("I", "a") would match any line, so only an exact match counts for it.
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
};
function sameProblem(finding, issue, atSec) {
  if (finding.kind !== issue.kind || finding.texts.length !== issue.texts.length || atSec - finding.lastSec > SAME_TEXT_WINDOW_SEC) return false;
  if (finding.texts.length === 1) return contains(finding.texts[0], issue.texts[0]);
  const [a, b] = finding.texts;
  const [c, d] = issue.texts;
  return (contains(a, c) && contains(b, d)) || (contains(a, d) && contains(b, c));
}

const sceneAt = (scenes, t) => (scenes || []).filter((s) => finite(s?.startSec) && s.startSec <= t + 1e-6 && (!finite(s.endSec) || t < s.endSec)).pop() || null;
const findingKey = (issue) => `${issue.kind}|${issue.texts.map((t) => t.toLowerCase()).sort().join('|')}`;

/**
 * Merge per-sample issues (`[{ atSec, issues }]`) into findings, errors first,
 * then by first time seen; each names the shot it was first seen in.
 */
export function summarizeTextFindings(samples = [], scenes = []) {
  const L = OVERLAY_TEXT_LIMITS;
  const byKey = new Map();
  for (const sample of samples.slice().sort((a, b) => a.atSec - b.atSec)) {
    for (const issue of sample.issues || []) {
      const key = findingKey(issue);
      const found = byKey.get(key) || [...byKey.values()].find((f) => sameProblem(f, issue, sample.atSec));
      if (found) {
        if (found.times.length < L.maxTimesPerFinding && !found.times.includes(round3(sample.atSec))) found.times.push(round3(sample.atSec));
        found.count += 1;
        found.lastSec = sample.atSec;
        // Keep the fullest reading of the text (the whole line, not its first word).
        if (issue.texts.join(' ').length > found.texts.join(' ').length) {
          found.texts = issue.texts;
          found.detail = issue.detail ?? found.detail;
          found.message = describeTextFinding(issue);
        }
        continue;
      }
      const scene = sceneAt(scenes, sample.atSec);
      byKey.set(key, {
        id: createHash('sha1').update(key).digest('hex').slice(0, 12),
        kind: issue.kind, severity: SEVERITY[issue.kind] || 'warning', texts: issue.texts, detail: issue.detail ?? null,
        atSec: round3(sample.atSec), lastSec: sample.atSec, times: [round3(sample.atSec)], count: 1,
        sceneId: scene?.sceneId ?? null, sceneLabel: scene?.label || null,
        message: describeTextFinding(issue),
      });
    }
  }
  return [...byKey.values()]
    .map(({ lastSec, ...finding }) => finding)
    .sort((a, b) => (a.severity === b.severity ? a.atSec - b.atSec : a.severity === 'error' ? -1 : 1))
    .slice(0, L.maxFindings);
}

/** Counts per kind and severity, for the one-line summary. */
function countTextFindings(findings = []) {
  const counts = { errors: 0, warnings: 0, ...Object.fromEntries(OVERLAY_TEXT_KINDS.map((k) => [k, 0])) };
  for (const f of findings) {
    counts[f.kind] = (counts[f.kind] || 0) + 1;
    if (f.severity === 'error') counts.errors += 1; else counts.warnings += 1;
  }
  return counts;
}

/**
 * The stored check as the storyboard reports it: null outside document mode;
 * otherwise `{ status, current, ... }`. `status` is none | running |
 * interrupted | complete | failed; `current` says it was run on the present
 * document, timing, shots and takes (`basisOf(project)`, hashed only here).
 */
export function overlayTextReport(project, basisOf) {
  if (project?.composition?.mode !== 'document' || !project.composition.document?.directory) return null;
  const check = project.productionReview?.textCheck;
  if (!check) return { status: 'none', current: false, findings: [], counts: countTextFindings([]) };
  const status = check.status === 'running' && check.processId !== OVERLAY_TEXT_PROCESS_ID ? 'interrupted' : check.status;
  const findings = Array.isArray(check.findings) ? check.findings : [];
  return { status, current: check.basis === basisOf(project), checkedAt: check.checkedAt || null, startedAt: check.startedAt || null,
    samples: check.samples ?? null, textSamples: check.textSamples ?? null, error: check.error || null,
    findings, counts: countTextFindings(findings) };
}
