/**
 * Universe Builder — prompt compilation.
 *
 * Pure render-prompt assembly: joins the universe's influence token lists +
 * style context and compiles the template into an ordered list of image-gen
 * prompts (variations / composite sheets / canon entries). No storage or
 * peer-sync. Split out of the former monolithic `universeBuilder.js` (#2529);
 * the barrel at `../universeBuilder.js` re-exports this module so existing
 * import paths keep working.
 */

import { composeStyledPrompt } from '../../lib/composeStyledPrompt.js';
import { flattenCanonDescriptorFragments, richCanonDescriptorFragments } from '../../lib/canonPrompt.js';
import { getWorldCategoryKeys, normalizeCategoryKey, ENTRY_REF_KIND } from './sanitize.js';

// Join an influence list (embrace or avoid) into the comma-separated string
// shape the renderer's `composeStyledPrompt` consumes. Tokens have already
// been deduped + capped by `sanitizeInfluenceList` at write time, so this is
// just a thin join — exported so downstream consumers (universeCanon,
// pipeline/visualStages) read a single helper instead of each open-coding
// `(arr || []).join(', ')`.
export function joinInfluenceList(structured = []) {
  if (!Array.isArray(structured)) return '';
  return structured.filter((t) => typeof t === 'string' && t.trim()).join(', ');
}

// Collapse newlines + control chars in user-supplied free text before
// embedding in a prompt. Defense-in-depth against a logline / styleNotes /
// variation label containing "\n# Output contract\n…" that could redirect the
// LLM's output structure. `trimTo` (the universe sanitizer) only trims
// leading/trailing whitespace, so embedded newlines flow through untouched
// without this pass.
export const stripPromptControlChars = (s) =>
  typeof s === 'string' ? s.replace(/[\r\n\t\f\v\u0085\u2028\u2029]+/g, ' ').trim() : '';

const identityText = (s) => s;

/**
 * Render the "established universe context" prompt section shared by the
 * Universe Builder LLM actions (auto-sort, promote-variation,
 * generate-category-variations). Returns the full block including leading
 * `\n# <header>\n` and trailing newline, ready to interpolate; returns `''`
 * when no fields populate so callers can drop the block entirely.
 *
 * Accepts a sanitized universe object or a shaped `{ logline, premise,
 * styleNotes }` literal (the expand-variations path passes the literal).
 *
 * @param {object|null|undefined} universe — sanitized universe or a shaped
 *   `{ logline, premise, styleNotes }` literal; `null`/`undefined` returns ''.
 * @param {object} [options]
 * @param {boolean} [options.includePremise=false] — emit a `PREMISE:` line.
 * @param {boolean} [options.includeEmbrace=true] — emit an
 *   `EMBRACE INFLUENCES:` line from `universe.influences.embrace`. Off for
 *   callers that render their own influences section.
 * @param {boolean} [options.escape=false] — collapse newlines/control chars
 *   in user-supplied text. Auto-sort opts in; promote/expand stayed off
 *   historically and we preserve that to avoid behavior drift.
 * @param {string} [options.headerSuffix=''] — appended after `Universe
 *   context — ` to bias the LLM.
 */
export function buildUniverseStyleContext(universe, options = {}) {
  if (!universe) return '';
  const {
    includePremise = false,
    includeEmbrace = true,
    escape = false,
    headerSuffix = '',
  } = options;
  const safeText = escape ? stripPromptControlChars : identityText;
  const lines = [];
  if (universe.logline) lines.push(`LOGLINE: ${safeText(universe.logline)}`);
  if (includePremise && universe.premise) lines.push(`PREMISE: ${safeText(universe.premise)}`);
  if (universe.styleNotes) lines.push(`STYLE NOTES: ${safeText(universe.styleNotes)}`);
  if (includeEmbrace) {
    const embraceTokens = joinInfluenceList(universe.influences?.embrace);
    if (embraceTokens) lines.push(`EMBRACE INFLUENCES: ${safeText(embraceTokens)}`);
  }
  if (lines.length === 0) return '';
  const header = headerSuffix ? `Universe context — ${headerSuffix}` : 'Universe context';
  return `\n# ${header}\n${lines.join('\n\n')}\n`;
}

// Order matches the Universe Builder tab order (Cast → Places → Objects) so
// the compiled-prompts list is stable across renders.
const CANON_TRUNKS = Object.freeze([
  { key: 'characters', category: 'canon:characters' },
  { key: 'places',     category: 'canon:places' },
  { key: 'objects',    category: 'canon:objects' },
]);

// Synthesize a render prompt from a canon entry. `entry.prompt` wins when
// hand-authored; otherwise stitch the kind's descriptive fields. Output is
// fed through `composeStyledPrompt(...)` so the universe's embrace tokens
// still prefix every canon render.
export function synthesizeCanonPrompt(kind, entry) {
  if (!entry) return '';
  if (typeof entry.prompt === 'string' && entry.prompt.trim()) return entry.prompt.trim();
  // Identifier seed: `name` is the shared anchor for all kinds. For
  // `places`, the bible sanitizer allows entries whose ONLY identifier is
  // a slugline (e.g. "EXT. FOUNDRY CITY — DAY") with no separate name — fall
  // back to slugline so those entries don't synthesize to an empty seed and
  // get silently skipped at render time.
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const sluglineId = (kind === 'places' && typeof entry.slugline === 'string')
    ? entry.slugline.trim()
    : '';
  const identifier = name || sluglineId;
  const body = flattenCanonDescriptorFragments(richCanonDescriptorFragments(kind, entry));
  if (identifier && body) return `${identifier} — ${body}`;
  return identifier || body;
}

/**
 * Compile the universe template into an ordered list of full image-gen
 * prompts. Each entry combines the universe's style prompt with one
 * variation from a chosen category, one composite sheet, or one canon entry.
 *
 *   promptMode: 'variations' | 'sheets' | 'canon' | 'all'
 *
 *   selection: { landscapes: 'all' | string[], characters: ... }
 *     - 'all' → use every variation
 *     - array of labels → only those labels (case-insensitive match)
 *     - missing key → skip the category entirely
 *
 *   canonSelection: { characters?: 'all' | string[], places?: ..., objects?: ... }
 *     - 'all' → render every entry in that canon trunk
 *     - array of names → only those names (case-insensitive match against
 *       `name` and, for places, `slugline`)
 *     - missing key → skip the trunk entirely
 *
 *   batchPerVariation: how many renders per variation (1..20)
 */
export function compilePrompts(universe, options = {}) {
  if (!universe) return [];
  const promptMode = ['variations', 'sheets', 'canon', 'all'].includes(options.promptMode)
    ? options.promptMode
    : 'variations';
  const selection = options.selection && typeof options.selection === 'object'
    ? options.selection
    : Object.fromEntries(getWorldCategoryKeys(universe.categories).map((c) => [c, 'all']));
  const normalizedSelection = {};
  for (const [key, value] of Object.entries(selection)) {
    const normalized = normalizeCategoryKey(key);
    if (normalized) normalizedSelection[normalized] = value;
  }
  const batchPerVariation = Math.max(1, Math.min(20, Number(options.batchPerVariation) || 1));

  // The universe's stored influences are the baseline; per-batch overrides
  // append on top so the user can layer an extra-style chip, a style preset,
  // or an extra negative without editing the persistent influences. Token
  // lists are comma-joined to match composeStyledPrompt's input expectation.
  const baselineEmbrace = joinInfluenceList(universe.influences?.embrace);
  const baselineAvoid = joinInfluenceList(universe.influences?.avoid);
  const embraceParts = [baselineEmbrace, options.stylePresetPrompt, options.extraStyle]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  const avoidParts = [baselineAvoid, options.stylePresetNegative, options.extraNegative]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  const stylePreset = {
    prompt: embraceParts.join(', '),
    negativePrompt: avoidParts.join(', '),
  };
  const compiled = [];

  if (promptMode === 'variations' || promptMode === 'all') {
    for (const category of getWorldCategoryKeys(normalizedSelection)) {
      const sel = normalizedSelection[category];
      if (!sel) continue;
      const variations = universe.categories?.[category]?.variations || [];
      const filtered = sel === 'all'
        ? variations
        : variations.filter((v) => Array.isArray(sel) && sel.some((s) => s.toLowerCase() === v.label.toLowerCase()));
      for (const variation of filtered) {
        const { prompt, negativePrompt } = composeStyledPrompt(variation.prompt, '', stylePreset);
        for (let i = 0; i < batchPerVariation; i += 1) {
          compiled.push({
            category,
            label: variation.label,
            prompt,
            negativePrompt,
            batchIndex: i,
            // `entryRef` lets the collection hook stamp the rendered filename
            // back onto this exact variation regardless of subsequent label
            // edits or bucket moves. Older universes can be missing `id` until
            // the next write through sanitizeTemplate — fall through silently
            // when that happens; the variation just won't accrue a render
            // history until it next gets persisted.
            ...(variation.id ? { entryRef: { kind: ENTRY_REF_KIND.VARIATION, categoryKey: category, id: variation.id } } : {}),
          });
        }
      }
    }
  }

  if (promptMode === 'sheets' || promptMode === 'all') {
    const sheetSelection = options.sheetSelection || 'all';
    const sheets = universe.compositeSheets || [];
    const filteredSheets = sheetSelection === 'all'
      ? sheets
      : sheets.filter((s) => Array.isArray(sheetSelection) && sheetSelection.some((label) => label.toLowerCase() === s.label.toLowerCase()));
    for (const sheet of filteredSheets) {
      const { prompt, negativePrompt } = composeStyledPrompt(sheet.prompt, '', stylePreset);
      const category = sheet.kind === 'world_pitch_poster'
        ? 'world_pitch_posters'
        : 'composite_sheets';
      for (let i = 0; i < batchPerVariation; i += 1) {
        compiled.push({
          category,
          label: sheet.label,
          prompt,
          negativePrompt,
          batchIndex: i,
          ...(sheet.id ? { entryRef: { kind: ENTRY_REF_KIND.SHEET, id: sheet.id } } : {}),
        });
      }
    }
  }

  if (promptMode === 'canon' || promptMode === 'all') {
    const canonSelection = options.canonSelection && typeof options.canonSelection === 'object'
      ? options.canonSelection
      : null;
    if (canonSelection) {
      for (const trunk of CANON_TRUNKS) {
        const sel = canonSelection[trunk.key];
        if (!sel) continue;
        const entries = Array.isArray(universe[trunk.key]) ? universe[trunk.key] : [];
        const filtered = sel === 'all'
          ? entries
          : entries.filter((e) => Array.isArray(sel) && sel.some((s) => {
              const needle = s.toLowerCase();
              if (typeof e.name === 'string' && e.name.toLowerCase() === needle) return true;
              // Slugline is places-only (see canonSelection docstring above
              // and BIBLE_FIELD_WHITELIST). Avoid matching a stray slugline
              // field on a character/object payload — that field isn't part of
              // the canon contract for those kinds.
              if (trunk.key === 'places'
                  && typeof e.slugline === 'string'
                  && e.slugline.toLowerCase() === needle) return true;
              return false;
            }));
        for (const entry of filtered) {
          const seed = synthesizeCanonPrompt(trunk.key, entry);
          // An entry with no name and no descriptive content yields nothing —
          // skip rather than enqueue a style-prompt-only render that would
          // produce a generic image with no identity anchor.
          if (!seed) continue;
          const { prompt, negativePrompt } = composeStyledPrompt(seed, '', stylePreset);
          for (let i = 0; i < batchPerVariation; i += 1) {
            compiled.push({
              category: trunk.category,
              label: entry.name || entry.slugline || trunk.key,
              prompt,
              negativePrompt,
              batchIndex: i,
              ...(entry.id ? { entryRef: { kind: ENTRY_REF_KIND.CANON, kindKey: trunk.key, id: entry.id } } : {}),
            });
          }
        }
      }
    }
  }

  return compiled;
}
