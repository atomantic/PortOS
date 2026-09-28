/**
 * Mood board → style-relevant text context (pure).
 *
 * Shared by the style synthesis run (`moodBoardStyleSynthesis.js`) and Code
 * Animation's art direction, and kept dependency-light so a caller that only
 * needs the board's text fragments doesn't import the provider stack.
 */

import { trimTo } from './textUtils.js';

// Context bounds: a board caps at 500 items, but the synthesis context must
// stay well inside a chat-completion window. Items are taken in board order
// (the user's curation order); fragments beyond either cap are dropped and
// the count is reported in the result so the UI can say so. The aggregate
// character budget is the load-bearing one — 60 items can each carry four
// 600-char fields, far past what a small local model's window fits — and it
// is a FIXED conservative budget (≈6k tokens) rather than model-aware:
// provider window metadata isn't reliably known here, and a proposal
// synthesized from the first N curated items beats a request the model
// truncates or rejects.
const CONTEXT_ITEMS_MAX = 60;
const CONTEXT_FIELD_MAX = 600;
const CONTEXT_TOTAL_CHARS_MAX = 24000;

/**
 * Reduce a board to the style-relevant text fragments the LLM sees. An item
 * contributes only what it actually carries: a text note, a caption, and/or a
 * persisted analysis (prompt + negative + rationale). Media items without any
 * of those contribute nothing — synthesis reads text, not pixels (analyzing
 * an item is Phase 3's explicit per-item vision step).
 */
export function collectBoardStyleContext(board) {
  const items = Array.isArray(board?.items) ? board.items : [];
  const fragments = [];
  let dropped = 0;
  let totalChars = 0;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const entry = {};
    if (it.type === 'text' && typeof it.text === 'string' && it.text.trim()) {
      entry.note = trimTo(it.text, CONTEXT_FIELD_MAX);
    }
    if (typeof it.caption === 'string' && it.caption.trim()) {
      entry.caption = trimTo(it.caption, CONTEXT_FIELD_MAX);
    }
    const analysis = it.analysis;
    if (analysis && typeof analysis === 'object' && typeof analysis.prompt === 'string' && analysis.prompt.trim()) {
      entry.analyzedPrompt = trimTo(analysis.prompt, CONTEXT_FIELD_MAX);
      if (typeof analysis.negativePrompt === 'string' && analysis.negativePrompt.trim()) {
        entry.analyzedNegative = trimTo(analysis.negativePrompt, CONTEXT_FIELD_MAX);
      }
      if (typeof analysis.rationale === 'string' && analysis.rationale.trim()) {
        entry.analysisRationale = trimTo(analysis.rationale, CONTEXT_FIELD_MAX);
      }
    }
    if (!Object.keys(entry).length) continue;
    const entrySize = Object.values(entry).reduce((sum, v) => sum + v.length, 0);
    if (fragments.length >= CONTEXT_ITEMS_MAX || totalChars + entrySize > CONTEXT_TOTAL_CHARS_MAX) {
      dropped += 1;
      continue;
    }
    totalChars += entrySize;
    fragments.push({ kind: it.type, ...entry });
  }
  // The board's own composite prompt is the distilled through-line. It is one
  // field, so it gets the description budget rather than the per-item cap —
  // clipping it to 600 would drop the look downstream renders are asked to match.
  const style = board?.style;
  const stylePrompt = trimTo(style?.prompt, 2000) || null;
  const styleNegative = trimTo(style?.negativePrompt, 2000) || null;
  return {
    name: trimTo(board?.name, 200) || null,
    description: trimTo(board?.description, 2000) || null,
    stylePrompt,
    styleNegative,
    items: fragments,
    droppedItems: dropped,
  };
}

/**
 * Local image references a board contributes, poster first. `resolveItem`
 * is `boardItemLocalImage` (injected so this module stays free of the board
 * store). The canonical poster is the board's style reference — the same role
 * a universe's style-probe image plays — and pinned item images follow it.
 * Duplicate filenames are dropped so a poster that was also pinned ships once.
 */
export function moodBoardImageCandidates(board, resolveItem) {
  const candidates = [];
  const seen = new Set();
  const push = (kind, filename, label) => {
    if (kind !== 'image' && kind !== 'image-ref') return;
    if (typeof filename !== 'string' || !filename.trim()) return;
    const key = `${kind}:${filename.trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ kind, filename: filename.trim(), label });
  };
  push('image', board?.posterImageRef, 'Mood board poster');
  const items = Array.isArray(board?.items) ? board.items : [];
  for (const item of items) {
    const asset = typeof resolveItem === 'function' ? resolveItem(item) : null;
    if (!asset) continue;
    const caption = typeof item?.caption === 'string' ? item.caption.trim() : '';
    push(asset.kind, asset.filename, caption || asset.filename);
  }
  return candidates;
}
