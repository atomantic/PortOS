// Shared helpers for the voice tool domain modules. Pure utilities used by more
// than one domain (or by the orchestrator) live here so each domain file stays
// focused on its own tool definitions. No tool definitions in this file.

import { normalizeLabel } from '../../../lib/navManifest.js';

// Clamp an LLM-supplied `limit` to [1, hi]. Tool-call args can arrive as
// strings ("10") or non-numeric junk; `Math.min(hi, "abc")` is NaN, which would
// silently slice an empty result. Coerce with Number() and fall back to
// `fallback` when the value isn't a finite positive number (preserving the old
// `limit || fallback` behavior for 0 / blank).
export const clampLimit = (raw, fallback, hi) => {
  const n = Number(raw);
  return Math.max(1, Math.min(hi, Number.isFinite(n) && n > 0 ? n : fallback));
};

// Shared with pipeline.js (summarizeUi) and the client's domIndex.classify.
// Mirror of the client-side kinds; keep in sync.
export const UI_KINDS = ['tab', 'button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio'];

// Accepts one kind OR an array of kinds for multi-kind tools like ui_fill
// (input|textarea) and ui_check (checkbox|radio). The error pool and label
// come from the union so the LLM sees the correct "available" list.
export const findUiElement = (ctx, label, kindHint) => {
  const ui = ctx?.state?.ui;
  if (!ui || !Array.isArray(ui.elements) || !ui.elements.length) {
    return {
      entry: null,
      err: {
        ok: false,
        error: 'No UI index available',
        summary: 'I don\'t see the page contents yet — reload the voice widget and try again.',
      },
    };
  }
  const kinds = Array.isArray(kindHint) ? kindHint : (kindHint ? [kindHint] : null);
  const target = normalizeLabel(label);
  const withKind = kinds ? ui.elements.filter((e) => kinds.includes(e.kind)) : ui.elements;
  const pools = kinds ? [withKind, ui.elements] : [ui.elements];
  const matchers = [
    (lab) => lab === target,
    (lab) => lab.startsWith(target),
    (lab) => lab.includes(target),
  ];
  for (const matcher of matchers) {
    for (const pool of pools) {
      const hit = pool.find((e) => matcher(normalizeLabel(e.label)));
      if (hit) return { entry: hit, err: null };
    }
  }
  const available = (kinds ? withKind : ui.elements).slice(0, 12).map((e) => e.label);
  const kindLabel = kinds ? kinds.join('/') : 'element';
  return {
    entry: null,
    err: {
      ok: false,
      error: `No ${kindLabel} matching "${label}" on this page`,
      available,
      summary: `I don't see "${label}" on this page. Available: ${available.join(', ') || 'none'}.`,
    },
  };
};
