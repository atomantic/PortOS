/**
 * Catalog scrap chunking — pure, side-effect-free.
 *
 * Pure lossless scrap-text chunker (`chunkRawText`, `CATALOG_CHUNK_MAX_CHARS`) — splits a long paste
 * into ≤maxChars chunks on paragraph/newline/sentence/whitespace boundaries so the catalog extractor
 * processes each child and unions results.
 *
 * Contract (relied on by catalogDB.createChunkedScrap + the extractor):
 *   - Lossless: `chunks.join('') === input` exactly (nothing dropped or injected).
 *   - Boundary preference: latest paragraph break, else newline, else sentence
 *     boundary, else whitespace, else a hard cut.
 *   - maxChunks ceiling: the last chunk holds the entire remainder even if over maxChars.
 *
 * NO db / llm / fs imports — keep it unit-testable in isolation.
 */

// Counted in UTF-16 code units, like the rest of the catalog's scrap lengths.
export const CATALOG_CHUNK_MAX_CHARS = 12_000;

// Bounds the LLM extraction passes one huge paste can trigger.
const DEFAULT_MAX_CHUNKS = 40;

const SENTENCE_BOUNDARY = /[.!?]["')\]]?\s/g;

/**
 * Best split offset (absolute, exclusive chunk end) inside `text[start .. start+limit]`:
 * paragraph break → newline → sentence boundary → whitespace → hard cut. Always
 * > start (forward progress) and ≤ start + limit.
 */
function findSplit(text, start, limit) {
  const hardEnd = start + limit;
  const window = text.slice(start, hardEnd);

  // Split AFTER the blank line so the separator rides with the preceding chunk.
  const para = window.lastIndexOf('\n\n');
  if (para > 0) return start + para + 2;

  const nl = window.lastIndexOf('\n');
  if (nl > 0) return start + nl + 1;

  let lastSentenceEnd = -1;
  SENTENCE_BOUNDARY.lastIndex = 0;
  let m;
  while ((m = SENTENCE_BOUNDARY.exec(window)) !== null) {
    // End of match: punctuation and trailing space stay with the current chunk.
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
