/** Shared bounded list sanitization for story-bible fields. */

import { trimTo } from './textUtils.js';

// Walk a raw array through a per-item sanitizer, dropping rejected entries
// (falsy return from `sanitizer`) and capping the output at `cap`. Keep the cap
// and rejection behavior consistent across list fields.
export const sanitizeListWith = (raw, sanitizer, cap) => {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const v of raw) {
    const s = sanitizer(v);
    if (!s) continue;
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
};

export const cleanStringArray = (raw, itemMax, listMax) =>
  sanitizeListWith(raw, (v) => trimTo(v, itemMax), listMax);
