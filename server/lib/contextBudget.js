/**
 * Context-window budgeter for manuscript editorial passes.
 *
 * The editorial passes (completeness, manuscript-fix, per-issue analysis) feed
 * manuscript text to an LLM. Whether the whole manuscript fits in one call —
 * or has to be chunked — depends on the target model's context window. This
 * module makes that decision with a deliberately conservative heuristic: no
 * tokenizer dependency (chars/4), combined with an output reserve and a safety
 * margin, so a slight under-estimate never overflows the window.
 *
 * Pure / side-effect-free — unit-tested in contextBudget.test.js.
 */

import { chunkRawText } from './catalogChunking.js';

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_000;
export const DEFAULT_SAFETY_MARGIN = 0.1;
// Minimum manuscript token budget a chunked pass guarantees (~6K chars). Re-sent
// context (scene map, arcs, ...) is trimmed first, since on a small window its overhead
// could otherwise slice the manuscript chunk to '' and run a check on NO prose (#1459).
export const MANUSCRIPT_FLOOR_TOKENS = 1_500;
// Appended to a clipped context block so the model knows it was truncated.
const CONTEXT_TRIM_MARKER = '\n…[context trimmed to fit the model window]…';
// Floor when a provider declares no usable window (Ollama's default).
export const FALLBACK_CONTEXT_WINDOW = 8_192;

// Output reserve for a LOCAL model with a known window: the generic 8K reserve is
// sized for cloud windows and would eat half a 16K local window. The larger of a floor
// and window/8, capped at window/4 and at the caller's declared reserve.
export const LOCAL_OUTPUT_RESERVE_FLOOR_TOKENS = 2_048;
export const LOCAL_OUTPUT_RESERVE_WINDOW_DIVISOR = 8;
export const LOCAL_OUTPUT_RESERVE_MAX_WINDOW_DIVISOR = 4;

/**
 * The output reserve to plan (and cap generation at) for a local model:
 * `min(declared, floor(window / 4), max(LOCAL_OUTPUT_RESERVE_FLOOR_TOKENS, floor(window / 8)))`
 * — 2,048 on a 16K window, 4,096 on 32K, 1,024 on 4K.
 * Returns `null` when either input is missing or not a positive number (nothing to shrink).
 *
 * @param {number|null|undefined} declaredReserveTokens
 * @param {number|null|undefined} contextWindow
 * @returns {number|null}
 */
export function localOutputReserveTokens(declaredReserveTokens, contextWindow) {
  const declared = Number(declaredReserveTokens);
  const window = Number(contextWindow);
  if (!Number.isFinite(declared) || declared <= 0 || !Number.isFinite(window) || window <= 0) return null;
  const scaled = Math.max(LOCAL_OUTPUT_RESERVE_FLOOR_TOKENS, Math.floor(window / LOCAL_OUTPUT_RESERVE_WINDOW_DIVISOR));
  const ceiling = Math.floor(window / LOCAL_OUTPUT_RESERVE_MAX_WINDOW_DIVISOR);
  return Math.max(1, Math.floor(Math.min(declared, ceiling, scaled)));
}

/** chars/4 token estimate. Conservative (real tokenizers pack denser). */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

/** Same heuristic for a char *count*, keeping every estimation site on one formula. */
export const estimateTokensFromChars = (chars) => Math.ceil((chars || 0) / CHARS_PER_TOKEN);

// Token cost of the `\n\n---\n\n` join `sectionsCorpus` inserts; budgeted so a full chunk's tail isn't sliced off.
const SECTION_SEPARATOR_TOKENS = estimateTokens('\n\n---\n\n');

const clampMargin = (m) => (Number.isFinite(m) && m >= 0 && m < 1 ? m : DEFAULT_SAFETY_MARGIN);

const resolveWindow = (contextWindow) =>
  (Number(contextWindow) > 0 ? Number(contextWindow) : FALLBACK_CONTEXT_WINDOW);

/** Usable INPUT token budget for the manuscript after output reserve, safety margin and fixed overhead. */
export function usableInputTokens({
  contextWindow,
  overheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
} = {}) {
  const afterMargin = Math.floor(resolveWindow(contextWindow) * (1 - clampMargin(safetyMargin)));
  return Math.max(0, afterMargin - Math.max(0, outputReserveTokens) - Math.max(0, overheadTokens));
}

/**
 * Char cap for a SINGLE-block manuscript/script pass (one big content block plus fixed
 * overhead, no trimmable context block, so `fitContextToManuscriptFloor` doesn't apply).
 * Returns the usable INPUT budget in chars (window − overhead − output reserve − margin),
 * floored at a manuscript minimum so a small window never sizes the content to empty
 * (#1459) and free to grow on a large window (#1488: a fixed 48–60K-char floor
 * overflowed small local windows). The caller appends its own truncation marker.
 *
 * The floor is itself capped by the raw window after fixed overhead (the output reserve
 * is generated, not part of the input prompt), so on a tiny or heavy-overhead window the
 * manuscript is trimmed *below* the floor (to 0 only when overhead meets the window)
 * rather than overflowing the real context.
 */
export function manuscriptContentBudgetChars({
  contextWindow,
  overheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
  floorTokens = MANUSCRIPT_FLOOR_TOKENS,
} = {}) {
  // The explicit 0 guards a negative floor.
  const budgetTokens = usableInputTokens({ contextWindow, overheadTokens, outputReserveTokens, safetyMargin });
  const desiredTokens = Math.max(0, floorTokens, budgetTokens);
  // Hard ceiling: the raw window after overhead (output reserve ignored). The floor may
  // exceed `budgetTokens` but never this. 0 when overhead ≥ window.
  const windowCapTokens = usableInputTokens({ contextWindow, overheadTokens, outputReserveTokens: 0, safetyMargin });
  return Math.min(desiredTokens, windowCapTokens) * CHARS_PER_TOKEN;
}

/**
 * How much of a re-sent context block (scene map, character arcs, ...) a chunked
 * manuscript pass can afford, guaranteeing the manuscript at least `floorTokens`
 * (#1459). `fixedOverheadTokens` (template scaffolding, NOT trimmable) is always
 * reserved; only `contextTokens` is squeezed.
 *
 * Returns the allowed budget as tokens and chars, within [0, contextTokens];
 * unchanged (`trimmed === false`) when everything fits.
 */
export function capContextOverhead({
  contextWindow,
  contextTokens = 0,
  fixedOverheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
  floorTokens = MANUSCRIPT_FLOOR_TOKENS,
} = {}) {
  const wantContext = Math.max(0, contextTokens);
  const floor = Math.max(0, floorTokens);
  // Input budget after fixed overhead, NOT subtracting the trimmable context (that is what we size).
  const inputBudget = usableInputTokens({
    contextWindow,
    overheadTokens: fixedOverheadTokens,
    outputReserveTokens,
    safetyMargin,
  });
  // Manuscript floor first; context gets what's left.
  const allowedContextTokens = Math.min(wantContext, Math.max(0, inputBudget - floor));
  return {
    allowedContextTokens,
    allowedContextChars: allowedContextTokens * CHARS_PER_TOKEN,
    trimmed: allowedContextTokens < wantContext,
  };
}

/**
 * Trim a context string to `maxChars`, preferring a newline boundary and appending a
 * marker. Within budget passes through; a 0/negative budget yields ''.
 */
export function trimContextToBudget(text, maxChars) {
  const s = String(text ?? '');
  const cap = Math.max(0, Math.floor(maxChars));
  if (s.length <= cap) return s;
  if (cap <= CONTEXT_TRIM_MARKER.length) return '';
  const bodyBudget = cap - CONTEXT_TRIM_MARKER.length;
  const slice = s.slice(0, bodyBudget);
  // Cut at the last newline unless that discards most of the budget.
  const lastNl = slice.lastIndexOf('\n');
  const body = lastNl > bodyBudget * 0.5 ? slice.slice(0, lastNl) : slice;
  return `${body}${CONTEXT_TRIM_MARKER}`;
}

/**
 * Trim a map of re-sent context blocks to fit a manuscript-floor budget and report the
 * overhead the trimmed context costs. The single place that decides the floor (#1459):
 * caps the token contribution (`capContextOverhead`) AND shrinks the strings
 * (`trimContextToBudget`), since capping only the token math would overflow the real prompt.
 *
 * The LARGEST blocks are trimmed first: `sceneMap` grows unbounded with scene count
 * while the others are bounded, so it absorbs the cut. Checks already handle an absent block.
 *
 * @param context - { [varName]: string } of trimmable blocks (non-strings coerced;
 *   an empty / non-object input yields `{}`).
 * @returns { context: { [varName]: string } (trimmed copy),
 *            overheadTokens: number (fixedOverheadTokens + trimmed context tokens),
 *            trimmed: boolean }
 */
export function fitContextToManuscriptFloor(context, {
  contextWindow,
  fixedOverheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
  floorTokens = MANUSCRIPT_FLOOR_TOKENS,
} = {}) {
  const entries = context && typeof context === 'object' ? Object.entries(context) : [];
  const blocks = {};
  for (const [k, v] of entries) blocks[k] = String(v ?? '');
  const fixed = Math.max(0, fixedOverheadTokens);

  const contextTokens = entries.reduce((n, [k]) => n + estimateTokens(blocks[k]), 0);
  const { allowedContextTokens, trimmed } = capContextOverhead({
    contextWindow,
    contextTokens,
    fixedOverheadTokens: fixed,
    outputReserveTokens,
    safetyMargin,
    floorTokens,
  });

  if (!trimmed) {
    return { context: blocks, overheadTokens: fixed + contextTokens, trimmed: false };
  }

  // Largest first. Drive the loop on the TOKEN budget, not aggregate chars:
  // `estimateTokens` ceilings per block, so small blocks could fit the char budget yet
  // exceed `allowedContextTokens` and starve the manuscript floor. Re-sum after each trim.
  const largestFirst = entries.map(([k]) => k).sort((a, b) => blocks[b].length - blocks[a].length);
  const tokenSum = () => entries.reduce((n, [k]) => n + estimateTokens(blocks[k]), 0);
  for (const k of largestFirst) {
    if (tokenSum() <= allowedContextTokens) break;
    const overshootTokens = tokenSum() - allowedContextTokens;
    blocks[k] = trimContextToBudget(blocks[k], Math.max(0, blocks[k].length - overshootTokens * CHARS_PER_TOKEN));
  }

  return { context: blocks, overheadTokens: fixed + tokenSum(), trimmed: true };
}

/**
 * Expand one section into `{ section, tokens }` units that each fit the usable budget.
 * An over-budget section following the `${header}\n\n${body}` convention (its `text` is the
 * header-prefixed `content`) is split on `body` via the lossless `chunkRawText`, with the
 * header preserved on each piece so `sectionsCorpus` re-attaches identical issue attribution
 * and first-wins finding-merge still dedups across sub-chunks. `maxChunks: Infinity` so a
 * long section is never trimmed. An unsplittable section (no string body, or header alone
 * over budget) passes through as one over-budget unit the caller truncates.
 */
function expandSection(section, text, tokens, usableTokens, usableChars) {
  if (tokens <= usableTokens) return [{ section, tokens }];
  const body = section?.content;
  if (typeof body !== 'string' || body.length === 0 || typeof text !== 'string' || !text.endsWith(body)) {
    return [{ section, tokens }];
  }
  const prefix = text.slice(0, text.length - body.length); // `${header}\n\n`
  const bodyBudgetChars = usableChars - prefix.length;
  if (bodyBudgetChars <= 0) return [{ section, tokens }]; // header alone over budget
  const pieces = chunkRawText(body, { maxChars: bodyBudgetChars, maxChunks: Number.POSITIVE_INFINITY });
  if (pieces.length <= 1) return [{ section, tokens }];
  return pieces.map((piece) => {
    const sub = { ...section, content: piece, text: `${prefix}${piece}` };
    return { section: sub, tokens: estimateTokens(sub.text) };
  });
}

/**
 * Plan how to feed a multi-section manuscript to a model with a given window.
 *
 * @param sections - [{ ...meta, text }] where `text` is the section's full corpus
 *   contribution (header + body); order is preserved. A section also carrying a string
 *   `content` (`text === \`${header}\n\n${content}\``) can be split when it alone overflows.
 * @returns
 *   { mode: 'whole',   usableTokens, usableChars, totalTokens }
 *   { mode: 'chunked', usableTokens, usableChars, totalTokens,
 *     chunks: [{ sections, tokens }] }
 *
 * An oversized single section is split into header-preserving sub-chunks so its tail
 * is reviewed (#1386); an unsplittable one stays one over-budget unit the caller
 * truncates. A corpus that fits (including empty) is `whole`.
 */
export function planManuscriptPass({
  contextWindow,
  sections,
  overheadTokens = 0,
  outputReserveTokens = DEFAULT_OUTPUT_RESERVE_TOKENS,
  safetyMargin = DEFAULT_SAFETY_MARGIN,
} = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const usableTokens = usableInputTokens({ contextWindow, overheadTokens, outputReserveTokens, safetyMargin });
  const usableChars = usableTokens * CHARS_PER_TOKEN;
  const withTokens = list.map((s) => ({ section: s, tokens: estimateTokens(s?.text) }));
  const totalTokens = withTokens.reduce((n, x) => n + x.tokens, 0);

  // The fit decision counts separators, or a corpus fitting only without them is mislabeled `whole`.
  const renderedTokens = totalTokens + Math.max(0, list.length - 1) * SECTION_SEPARATOR_TOKENS;
  if (renderedTokens <= usableTokens) {
    return { mode: 'whole', usableTokens, usableChars, totalTokens };
  }

  // Expand over-budget sections (#1386), then first-fit chunks.
  const units = withTokens.flatMap(({ section, tokens }) =>
    expandSection(section, section?.text, tokens, usableTokens, usableChars));

  // A lone unsplittable section stays one over-budget `whole` pass (caller truncates).
  if (units.length <= 1) {
    return { mode: 'whole', usableTokens, usableChars, totalTokens };
  }

  // Greedy first-fit, order-preserving; separators counted so a re-joined chunk never overflows usableChars.
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const { section, tokens } of units) {
    const sep = cur.length ? SECTION_SEPARATOR_TOKENS : 0;
    if (cur.length && curTokens + sep + tokens > usableTokens) {
      chunks.push({ sections: cur, tokens: curTokens });
      cur = [];
      curTokens = 0;
    }
    curTokens += (cur.length ? SECTION_SEPARATOR_TOKENS : 0) + tokens;
    cur.push(section);
  }
  if (cur.length) chunks.push({ sections: cur, tokens: curTokens });
  return { mode: 'chunked', usableTokens, usableChars, totalTokens, chunks };
}
