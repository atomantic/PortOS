/**
 * Decides which image from a Codex session belongs to the job.
 *
 * A Codex turn can call image_gen more than once: a stray follow-up call
 * (a made-up "completion summary" dashboard was observed), a refinement, or a
 * plain retry. File order says nothing about which one the job asked for, so
 * the session log's per-image prompt decides, and a session that cannot be
 * resolved fails instead of guessing.
 *
 * Codex rewrites prompts before calling the tool, so matching measures word
 * overlap rather than requiring the job's text verbatim.
 */

import { basename } from 'path';

export const IMAGE_GEN_ITEM_KIND = 'image_gen.generation';

// Observed rewrites keep well above half of the job's words; an unrelated call
// keeps almost none.
const MIN_PROMPT_COVERAGE = 0.5;

const normalizePrompt = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();
const promptWords = (text) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

const promptCoverage = (jobPrompt, prompt) => {
  const jobWords = promptWords(jobPrompt);
  if (!jobWords.size) return 0;
  const words = promptWords(prompt);
  let shared = 0;
  for (const word of jobWords) if (words.has(word)) shared += 1;
  return shared / jobWords.size;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const decodePng = (result) => {
  if (!result) return null;
  const buffer = Buffer.from(result.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''), 'base64');
  return buffer.length >= 12 && buffer.subarray(0, 8).equals(PNG_SIGNATURE) ? buffer : null;
};

// Current builds log an `item_completed` Extension item; older ones logged
// `image_generation_end`, named after the Responses API's `revised_prompt`.
const imageRecordFrom = (payload) => {
  const source = payload?.type === 'image_generation_end' ? payload
    : payload?.type === 'item_completed' && payload.item?.kind === IMAGE_GEN_ITEM_KIND ? payload.item
      : null;
  if (!source) return null;
  const prompt = source.revisedPrompt ?? source.revised_prompt;
  return {
    prompt: typeof prompt === 'string' ? prompt : null,
    // Reduced to a name: only a file inside the session's own directory counts.
    fileName: typeof source.savedPath === 'string' ? basename(source.savedPath) : null,
    result: typeof source.result === 'string' ? source.result : null,
  };
};

/** Every image the session log records, in the order Codex made them. */
export function parseSessionImageRecords(logText) {
  const records = [];
  for (const line of logText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = imageRecordFrom(JSON.parse(line)?.payload);
      if (record) records.push(record);
    } catch {
      // Session JSONL can end in a truncated line; the complete ones still count.
    }
  }
  return records;
}

const matchJobPrompt = (candidates, jobPrompt) => {
  const job = normalizePrompt(jobPrompt ?? '');
  const close = candidates.filter(({ prompt }) => prompt && promptCoverage(job, prompt) >= MIN_PROMPT_COVERAGE);
  const exact = close.filter(({ prompt }) => normalizePrompt(prompt) === job);
  const pool = exact.length ? exact : close;
  // The same prompt sent twice is a retry: both were made from it, and Codex
  // kept going past the first for a reason. Two different prompts are a guess.
  return new Set(pool.map(({ prompt }) => normalizePrompt(prompt))).size === 1 ? pool.at(-1) : null;
};

/**
 * @param {object} session
 * @param {string[]} session.fileNames - PNGs in the session's image directory
 * @param {object[]} session.records - from parseSessionImageRecords
 * @param {string} session.jobPrompt - the job's own prompt, without PortOS's wrapper
 * @returns {null | { fileName?: string, buffer?: Buffer, ignoredImages: number } | { unmatchedImages: number }}
 *   null when the session made no image yet.
 */
export function selectJobImage({ fileNames, records, jobPrompt }) {
  const onDisk = new Set(fileNames);
  const recordedNames = new Set(records.map(({ fileName }) => fileName));
  const candidates = fileNames
    .filter((fileName) => !recordedNames.has(fileName))
    .map((fileName) => ({ prompt: null, fileName }));
  for (const { prompt, fileName, result } of records) {
    if (fileName && onDisk.has(fileName)) {
      candidates.push({ prompt, fileName });
      continue;
    }
    const buffer = decodePng(result);
    if (buffer) candidates.push({ prompt, buffer });
  }
  if (!candidates.length) return null;
  const match = candidates.length === 1 ? candidates[0] : matchJobPrompt(candidates, jobPrompt);
  if (!match) return { unmatchedImages: candidates.length };
  return { fileName: match.fileName, buffer: match.buffer, ignoredImages: candidates.length - 1 };
}
