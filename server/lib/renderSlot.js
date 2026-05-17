/**
 * Shared render-slot helpers — used by anything that owns a (proof|final)
 * image render: comic issue covers / back covers, comic page renders, and
 * volume (season) covers / back covers.
 *
 * The slot record is the in-flight + completed-render state for one image:
 *
 *   { jobId, filename, prompt, width, height, createdAt, fromProof? }
 *
 * `filename` is null while in-flight; the filename hook stamps it at job
 * completion. `fromProof` is omitted for the proof slot, required for the
 * final slot (so the UI can render "(upscaled from proof)" provenance).
 *
 * This module is a leaf — no imports from other PortOS modules. That keeps
 * it usable from both issues.js (cover, backCover, page-render slots) and
 * storyArc.js (season cover, backCover slots) without circular imports.
 */

import { isStr, trimTo } from './storyBible.js';

export const COVER_SCRIPT_MAX = 8000;
export const COVER_PROMPT_MAX = 16_000;
export const RENDER_FILENAME_MAX = 500;

/**
 * Sanitize a persisted slot record (cover.proofImage, season.backCover.finalImage,
 * etc). Returns null for an empty record so the persisted JSON stays clean.
 */
export const sanitizeRenderSlot = (raw, { isFinal = false } = {}) => {
  if (!raw || typeof raw !== 'object') return null;
  const jobId = isStr(raw.jobId) && raw.jobId ? raw.jobId : null;
  const filename = isStr(raw.filename) && raw.filename
    ? raw.filename.slice(0, RENDER_FILENAME_MAX)
    : null;
  const prompt = trimTo(raw.prompt, COVER_PROMPT_MAX) || null;
  const width = Number.isFinite(raw.width) ? Math.max(0, Math.floor(raw.width)) : null;
  const height = Number.isFinite(raw.height) ? Math.max(0, Math.floor(raw.height)) : null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : null;
  if (!jobId && !filename) return null;
  const out = { jobId, filename, prompt, width, height, createdAt };
  if (isFinal) out.fromProof = raw.fromProof === true;
  return out;
};

/**
 * Sanitize a cover-like record (one script + proof slot + final slot, plus
 * legacy pre-split fields). Used for issue.cover, issue.backCover,
 * season.cover, season.backCover.
 */
export const sanitizeCoverLike = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const script = trimTo(raw.script, COVER_SCRIPT_MAX);
  const imageJobId = isStr(raw.imageJobId) && raw.imageJobId ? raw.imageJobId : null;
  const prompt = trimTo(raw.prompt, COVER_PROMPT_MAX);
  const filename = isStr(raw.filename) && raw.filename ? raw.filename : null;
  const proofImage = sanitizeRenderSlot(raw.proofImage);
  const finalImage = sanitizeRenderSlot(raw.finalImage, { isFinal: true });
  if (!script && !imageJobId && !prompt && !filename && !proofImage && !finalImage) return null;
  return {
    script,
    imageJobId,
    prompt: prompt || null,
    filename,
    proofImage,
    finalImage,
  };
};

/**
 * Build a fresh in-flight render slot — used by route handlers when enqueueing
 * a new render and by filename hooks when migrating a legacy in-flight job.
 * `filename` starts null; the filename hook stamps it on job completion.
 */
export const buildRenderSlot = ({ slotKey, jobId, prompt, width, height, fromProof = false, filename = null }) => ({
  jobId,
  filename,
  prompt: prompt || null,
  width: width ?? null,
  height: height ?? null,
  createdAt: new Date().toISOString(),
  ...(slotKey === 'finalImage' ? { fromProof } : {}),
});

/**
 * Read-fallback chain for "which image filename should I display / embed":
 *   1. finalImage.filename — the hi-res print-ready render (preferred)
 *   2. proofImage.filename — the fast layout render
 *   3. legacy `filename`   — pre-proof/final split records
 * Returns null when nothing is available yet.
 */
export const pickRenderedFilename = (record) => {
  if (!record) return null;
  return record.finalImage?.filename
    || record.proofImage?.filename
    || (typeof record.filename === 'string' && record.filename ? record.filename : null);
};
