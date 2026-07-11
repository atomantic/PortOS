import { hasCanonDescriptorContent } from './canonPrompt.js';
import { getCategoryKeys } from './universeBuilderShared.js';

// Pure prompt-count helpers for the Universe Builder (#2374). They mirror the
// server's compile/skip rules so inline "Render N images" buttons can advertise
// the exact number the server will enqueue, without a round trip. The server
// copy in server/services/universeBuilder.js (compilePrompts /
// synthesizeCanonPrompt) is authoritative — keep these in sync.

export function totalVariationCount(world) {
  return getCategoryKeys(world?.categories).reduce(
    (n, c) => n + (world?.categories?.[c]?.variations?.length || 0),
    0,
  );
}

const hasNonBlankString = (v) => typeof v === 'string' && v.trim().length > 0;

// Mirror the server's synthesizeCanonPrompt skip rule: entries with no
// identity-anchor (name / slugline / prompt) AND no descriptive content for the
// kind compile to an empty seed and get skipped at render time.
export const canonEntryHasContent = (e, kind) => {
  if (!e) return false;
  if (hasNonBlankString(e.prompt)) return true;
  // Identifier anchors per kind — places allow slugline-only entries (bible
  // sanitizer); characters/objects ignore stray slugline. Mirrors server
  // synthesizeCanonPrompt's identifier-seed rule.
  if (hasNonBlankString(e.name)) return true;
  if (kind === 'places' && hasNonBlankString(e.slugline)) return true;
  return hasCanonDescriptorContent(kind, e);
};

export const countCanonWithContent = (world, kind) =>
  (Array.isArray(world?.[kind]) ? world[kind] : []).filter((e) => canonEntryHasContent(e, kind)).length;

export function renderPromptCount(world, promptMode = 'variations') {
  if (promptMode === 'variations') return totalVariationCount(world);
  const sheets = world?.compositeSheets?.length || 0;
  if (promptMode === 'sheets') return sheets;
  const canon = countCanonWithContent(world, 'characters')
    + countCanonWithContent(world, 'places')
    + countCanonWithContent(world, 'objects');
  if (promptMode === 'canon') return canon;
  return totalVariationCount(world) + sheets + canon;
}

// Mirrors the server's compilePrompts for selection/sheetSelection/canonSelection
// so an inline "Render" button can disable itself + show an accurate count
// without a round trip.
//
// Defaulting rules — mirror server/services/universeBuilder.js compilePrompts:
//   - sheets/all + no sheetSelection → render every sheet (server defaults to 'all')
//   - variations/all + no selection → render every category (server falls back
//     to a full category map via getWorldCategoryKeys)
//   - canon/all + no canonSelection → render NOTHING (server gates on a non-null
//     canonSelection; missing key skips the trunk entirely)
// Canon entries are filtered through `canonEntryHasContent(kind)` since the
// server skips entries whose synthesized seed is empty.
export function scopedPromptCount(world, scope) {
  if (!scope) return 0;
  const mode = scope.promptMode || 'variations';
  let n = 0;
  if (mode === 'sheets' || mode === 'all') {
    const sheets = world?.compositeSheets || [];
    if (scope.sheetSelection === 'all' || scope.sheetSelection === undefined || scope.sheetSelection === null) {
      // Both `sheets` and `all` default to every sheet when sheetSelection is
      // omitted — server: `options.sheetSelection || 'all'`.
      n += sheets.length;
    } else if (Array.isArray(scope.sheetSelection)) {
      const set = new Set(scope.sheetSelection.map((s) => s.toLowerCase()));
      n += sheets.filter((s) => set.has((s.label || '').toLowerCase())).length;
    }
  }
  if (mode === 'variations' || mode === 'all') {
    if (scope.selection) {
      for (const [cat, pick] of Object.entries(scope.selection)) {
        const vars = world?.categories?.[cat]?.variations || [];
        if (pick === 'all') n += vars.length;
        else if (Array.isArray(pick)) {
          const labels = new Set(pick.map((p) => p.toLowerCase()));
          n += vars.filter((v) => labels.has((v.label || '').toLowerCase())).length;
        }
      }
    } else {
      // No selection ⇒ server treats this as "every category, all variations".
      n += totalVariationCount(world);
    }
  }
  if (mode === 'canon' || mode === 'all') {
    if (scope.canonSelection) {
      for (const trunk of ['characters', 'places', 'objects']) {
        const pick = scope.canonSelection[trunk];
        if (!pick) continue;
        const entries = Array.isArray(world?.[trunk]) ? world[trunk] : [];
        const withContent = entries.filter((e) => canonEntryHasContent(e, trunk));
        if (pick === 'all') n += withContent.length;
        else if (Array.isArray(pick)) {
          const needles = new Set(pick.map((p) => p.toLowerCase()));
          // Mirror server: slugline matching is places-only — name is the
          // shared anchor for characters/objects.
          n += withContent.filter((e) => {
            const name = (e.name || '').toLowerCase();
            if (needles.has(name)) return true;
            if (trunk === 'places') {
              const slug = (e.slugline || '').toLowerCase();
              if (needles.has(slug)) return true;
            }
            return false;
          }).length;
        }
      }
    }
  }
  return n;
}
