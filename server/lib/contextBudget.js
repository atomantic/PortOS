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

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_000;
export const DEFAULT_SAFETY_MARGIN = 0.1;
// Conservative floor when a provider declares no usable window at all — matches
// Ollama's historical default so we never plan for more than we can be sure of.
export const FALLBACK_CONTEXT_WINDOW = 8_192;

/** chars/4 token estimate. Conservative (real tokenizers pack denser). */
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

const clampMargin = (m) => (Number.isFinite(m) && m >= 0 && m < 1 ? m : DEFAULT_SAFETY_MARGIN);

const resolveWindow = (contextWindow) =>
  (Number(contextWindow) > 0 ? Number(contextWindow) : FALLBACK_CONTEXT_WINDOW);

/**
 * Usable INPUT token budget for the manuscript text itself, after reserving
 * output space, a safety margin, and any fixed prompt/context overhead
 * (template scaffolding, canon JSON, the finding, etc.).
 */
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
 * Plan how to feed a multi-section manuscript to a model with a given window.
 *
 * @param sections - [{ ...meta, text }] where `text` is the section's full
 *   contribution to the corpus (header + body). Order is preserved.
 * @returns
 *   { mode: 'whole',   usableTokens, usableChars, totalTokens }
 *   { mode: 'chunked', usableTokens, usableChars, totalTokens,
 *     chunks: [{ sections, tokens }] }
 *
 * A single section larger than the usable budget becomes its own (over-budget)
 * chunk — the caller truncates that chunk's text but it is never silently
 * dropped. With ≤1 section the result is always `whole` (nothing to split).
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

  if (list.length <= 1 || totalTokens <= usableTokens) {
    return { mode: 'whole', usableTokens, usableChars, totalTokens };
  }

  // Greedy first-fit packing, order-preserving. Each chunk stays under the
  // usable budget unless a single section already exceeds it (own chunk).
  const chunks = [];
  let cur = [];
  let curTokens = 0;
  for (const { section, tokens } of withTokens) {
    if (cur.length && curTokens + tokens > usableTokens) {
      chunks.push({ sections: cur, tokens: curTokens });
      cur = [];
      curTokens = 0;
    }
    cur.push(section);
    curTokens += tokens;
  }
  if (cur.length) chunks.push({ sections: cur, tokens: curTokens });
  return { mode: 'chunked', usableTokens, usableChars, totalTokens, chunks };
}
