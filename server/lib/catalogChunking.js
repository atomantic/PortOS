/**
 * Catalog scrap chunking — pure, side-effect-free.
 *
 * A long scrap paste is split into chunks so the catalog extractor can process
 * each chunk independently (bounded concurrency) and union the per-chunk drafts.
 * Short inputs return a single chunk and behave exactly as the pre-chunking
 * code did.
 *
 * Design contract (relied on by catalogDB.createChunkedScrap + the extractor):
 *   - Lossless: concatenating the returned chunks reproduces the input EXACTLY
 *     (no characters dropped, no separators injected). Tests assert join('') ===
 *     input.
 *   - Boundary preference: when a chunk would exceed maxChars, split at the
 *     latest paragraph break (\n\n) within the window, else the latest newline,
 *     else the latest sentence boundary, else the latest whitespace, else a hard
 *     character cut (pathological no-whitespace input).
 *   - maxChunks ceiling: never emit more than maxChunks entries; the last chunk
 *     holds the entire remainder even if it exceeds maxChars.
 *
 * NO db / llm / fs imports — keep it unit-testable in isolation.
 */

// Default per-chunk character ceiling. Counted by JS string length (UTF-16 code
// units), matching how the rest of the catalog measures scrap length.
export const CATALOG_CHUNK_MAX_CHARS = 12_000;

// Default ceiling on how many chunks one scrap can split into. Bounds the number
// of LLM extraction passes a single huge paste can trigger.
const DEFAULT_MAX_CHUNKS = 40;

// Sentence-terminator followed by whitespace. Used to find the last sentence
// boundary inside a candidate window when no paragraph/newline break exists.
const SENTENCE_BOUNDARY = /[.!?]["')\]]?\s/g;

/**
 * Find the best split offset inside `text[start .. start+limit]`. Returns an
 * absolute index in `text` (exclusive end of the chunk). Prefers, in order:
 * paragraph break (\n\n) → newline → sentence boundary → any whitespace →
 * hard cut at `start + limit`. The returned index is always > start (so we make
 * forward progress) and ≤ start + limit.
 */
function findSplit(text, start, limit) {
  const hardEnd = start + limit;
  const window = text.slice(start, hardEnd);

  // Paragraph break — split AFTER the blank line so the separator rides with the
  // preceding chunk (lossless either way; trailing-with-chunk keeps the next
  // chunk's leading content clean).
  const para = window.lastIndexOf('\n\n');
  if (para > 0) return start + para + 2;

  const nl = window.lastIndexOf('\n');
  if (nl > 0) return start + nl + 1;

  // Latest sentence boundary inside the window.
  let lastSentenceEnd = -1;
  SENTENCE_BOUNDARY.lastIndex = 0;
  let m;
  while ((m = SENTENCE_BOUNDARY.exec(window)) !== null) {
    // End of the match (after the trailing whitespace char) so the punctuation
    // and the following space stay with the current chunk.
    lastSentenceEnd = m.index + m[0].length;
  }
  if (lastSentenceEnd > 0) return start + lastSentenceEnd;

  // Any whitespace — avoid splitting mid-word.
  const ws = window.search(/\s\S*$/);
  if (ws > 0) return start + ws + 1;

  // Pathological no-whitespace run: hard char cut.
  return hardEnd;
}

/**
 * Split raw scrap text into lossless chunks.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars=CATALOG_CHUNK_MAX_CHARS]  per-chunk ceiling
 * @param {number} [opts.maxChunks=40]                       chunk-count ceiling
 * @returns {string[]}  one entry when text ≤ maxChars, else N entries. Always
 *                      reassembles losslessly: chunks.join('') === text.
 */
export function chunkRawText(text, { maxChars = CATALOG_CHUNK_MAX_CHARS, maxChunks = DEFAULT_MAX_CHUNKS } = {}) {
  if (typeof text !== 'string') return [];
  const cap = Math.max(1, Math.floor(maxChars));
  const ceiling = Math.max(1, Math.floor(maxChunks));

  if (text.length <= cap) return [text];

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    // Last allowed chunk: take the entire remainder even if it exceeds cap, so
    // we never exceed the maxChunks ceiling and never drop characters.
    if (chunks.length === ceiling - 1) {
      chunks.push(text.slice(start));
      break;
    }
    const remaining = text.length - start;
    if (remaining <= cap) {
      chunks.push(text.slice(start));
      break;
    }
    const end = findSplit(text, start, cap);
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
