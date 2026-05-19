/**
 * Shared renderers that turn a Universe Builder universe's `categories` map and
 * `compositeSheets` array into prompt-friendly text blocks. Used by both
 * `universeBuilderRefine` (which needs `[LOCKED]` flags) and `arcPlanner` (which
 * does not). The two prior copies in those files had drifted in formatting;
 * consolidating here keeps the LLM input shape consistent across stages.
 */

export function renderCategoriesForPrompt(categories, { showLocked = false } = {}) {
  const entries = Object.entries(categories || {});
  if (!entries.length) return '';
  return entries
    .map(([key, cat]) => {
      const variations = (cat?.variations || [])
        .map((v) => {
          const flag = showLocked && v.locked ? ' [LOCKED]' : '';
          return `    - "${v.label}"${flag}: ${v.prompt}`;
        })
        .join('\n');
      return `  ${key}:\n${variations || '    (no variations yet)'}`;
    })
    .join('\n');
}

export function renderCompositesForPrompt(composites, { showLocked = false } = {}) {
  if (!composites?.length) return '';
  return composites
    .map((c) => {
      const flag = showLocked && c.locked ? ' [LOCKED]' : '';
      return `  - (${c.kind || 'reference_sheet'}) "${c.label}"${flag}: ${c.prompt}`;
    })
    .join('\n');
}

// Caps for canon → prompt rendering. Sanitized universes can hold up to
// BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX (200) entries per kind with multi-KB
// descriptions; rendering all of them into every arc/verify prompt would
// inflate token cost + latency by orders of magnitude. Truncate at the
// rendering layer (not in canon storage) so the on-disk universe stays rich
// while LLM context stays bounded.
export const CANON_PROMPT_ENTRIES_PER_KIND_MAX = 40;
export const CANON_PROMPT_DESCRIPTION_MAX = 300;

const truncDesc = (s) => {
  if (typeof s !== 'string') return '';
  const trimmed = s.trim();
  if (trimmed.length <= CANON_PROMPT_DESCRIPTION_MAX) return trimmed;
  return `${trimmed.slice(0, CANON_PROMPT_DESCRIPTION_MAX - 1).trimEnd()}…`;
};

// Per-canon-kind formatting table — header label + per-entry line builder.
// One row per canon trunk; renderCanonForPrompt iterates this so a future
// kind addition (or field tweak) is a one-line change. formatEntry truncates
// the long description field so a single entry can't dominate the prompt.
// Build a `  - name [role]: physDesc. personality (background). tags: a, b`
// line for a canon character. Trailing metadata is rendered only when
// present so an empty bible doesn't pollute the prompt with empty markers.
const formatCharacter = (c) => {
  const role = c.role ? ` [${c.role}]` : '';
  const tags = Array.isArray(c.tags) && c.tags.length ? ` tags: ${c.tags.join(', ')}` : '';
  const parts = [
    truncDesc(c.physicalDescription || c.description || ''),
    truncDesc(c.personality || ''),
    c.background ? `background: ${truncDesc(c.background)}` : '',
  ].filter(Boolean);
  const body = parts.length ? `: ${parts.join('. ')}` : '';
  return `  - ${c.name}${role}${body}${tags}`;
};

// Place: prefer name; show slugline when present (screenplay-style location
// header used by scene matchers); include recurringDetails — the expand
// contract collects all three and the LLM uses them as continuity anchors.
const formatPlace = (p) => {
  const label = p.name || p.slugline || '(unnamed)';
  const sluglineTag = p.name && p.slugline ? ` (${p.slugline})` : '';
  const palette = p.palette ? ` palette: ${p.palette}` : '';
  const parts = [
    truncDesc(p.description || ''),
    p.recurringDetails ? `recurring: ${truncDesc(p.recurringDetails)}` : '',
  ].filter(Boolean);
  const body = parts.length ? `: ${parts.join('. ')}` : '';
  return `  - ${label}${sluglineTag}${body}${palette}`;
};

const formatObject = (o) => {
  const desc = truncDesc(o.description || '');
  const sig = o.significance ? ` (${truncDesc(o.significance)})` : '';
  return `  - ${o.name}${desc ? `: ${desc}` : ''}${sig}`;
};

const CANON_SECTIONS = [
  { field: 'characters', header: 'characters', formatEntry: formatCharacter },
  { field: 'places', header: 'places', formatEntry: formatPlace },
  { field: 'objects', header: 'objects', formatEntry: formatObject },
];

// Render the universe's canon arrays (characters/places/objects) into a
// prompt-friendly text block. Distinct from renderCategoriesForPrompt because
// canon entries are first-class named entities with rich metadata, not
// exploratory variations — the arc planner references them by name.
// Caps each section at CANON_PROMPT_ENTRIES_PER_KIND_MAX entries; an
// "(… + N more)" footer signals truncation so the LLM doesn't assume the
// canon is complete.
export function renderCanonForPrompt(world) {
  if (!world || typeof world !== 'object') return '';
  const sections = [];
  for (const { field, header, formatEntry } of CANON_SECTIONS) {
    const entries = Array.isArray(world[field]) ? world[field] : [];
    if (!entries.length) continue;
    const shown = entries.slice(0, CANON_PROMPT_ENTRIES_PER_KIND_MAX);
    const hiddenCount = entries.length - shown.length;
    const lines = shown.map(formatEntry);
    if (hiddenCount > 0) {
      lines.push(`  - (… + ${hiddenCount} more ${header} not shown — prompt budget reached)`);
    }
    sections.push(`${header}:\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

// Per-kind caps for the compact entity summary. The summary is meant for
// per-issue text stages (prose/teleplay/comic-script) where the full canon
// dump would dominate the prompt — keep one short line per kind so the LLM
// gets continuity anchors without the budget hit.
export const ENTITIES_SUMMARY_MAX_PER_KIND = 8;
export const ENTITIES_SUMMARY_DESCRIPTOR_MAX = 80;

const truncOneLine = (s) => {
  if (typeof s !== 'string') return '';
  const flat = s.trim().replace(/\s+/g, ' ');
  if (!flat) return '';
  if (flat.length <= ENTITIES_SUMMARY_DESCRIPTOR_MAX) return flat;
  return `${flat.slice(0, ENTITIES_SUMMARY_DESCRIPTOR_MAX - 1).trimEnd()}…`;
};

// Pick the most useful 1-line descriptor available per kind. Characters lead
// with role + a sliver of physicalDescription/personality; places use a slice
// of description; objects pull from significance or description. The goal is
// a quick orientation glance, not a substitute for the full canon block.
const summarizeCharacter = (c) => {
  const role = c.role ? `${c.role}` : '';
  const body = truncOneLine(c.physicalDescription || c.personality || c.description || c.background || '');
  if (role && body) return `${c.name} (${role} — ${body})`;
  if (role) return `${c.name} (${role})`;
  if (body) return `${c.name} (${body})`;
  return c.name;
};

const summarizePlace = (p) => {
  const label = p.name || p.slugline || '(unnamed)';
  const desc = truncOneLine(p.description || p.recurringDetails || '');
  return desc ? `${label} (${desc})` : label;
};

const summarizeObject = (o) => {
  const desc = truncOneLine(o.significance || o.description || '');
  return desc ? `${o.name} (${desc})` : o.name;
};

const SUMMARY_SECTIONS = [
  { field: 'characters', header: 'Characters', formatEntry: summarizeCharacter },
  { field: 'places',     header: 'Places',     formatEntry: summarizePlace },
  { field: 'objects',    header: 'Objects',    formatEntry: summarizeObject },
];

/**
 * Render a compact one-line-per-kind synopsis of the universe's named canon.
 *
 * Shape: each non-empty kind becomes `<Header>: name (descriptor); name; …`
 * joined with newlines. Top-N entries per kind (canon list order = LLM-
 * generated importance order). Returns an empty string when there is no
 * canon — callers gate against that for the `(none)` placeholder.
 *
 * Distinct from `renderCanonForPrompt`:
 *   - canon block: multi-line, rich metadata per entry, intended for arc-
 *     level prompts that benefit from the full bible.
 *   - this summary: terse one-line tags meant for per-issue text stages
 *     (prose/teleplay/comic-script) where the budget can't afford the full
 *     dump but the LLM still needs continuity anchors.
 */
export function renderEntitiesSummary(world, { maxPerKind = ENTITIES_SUMMARY_MAX_PER_KIND } = {}) {
  if (!world || typeof world !== 'object') return '';
  const lines = [];
  for (const { field, header, formatEntry } of SUMMARY_SECTIONS) {
    const entries = Array.isArray(world[field]) ? world[field] : [];
    if (!entries.length) continue;
    const shown = entries.slice(0, maxPerKind);
    const hidden = entries.length - shown.length;
    const tags = shown.map(formatEntry).filter(Boolean);
    if (!tags.length) continue;
    const joined = tags.join('; ');
    lines.push(hidden > 0 ? `${header}: ${joined}; (+${hidden} more)` : `${header}: ${joined}`);
  }
  return lines.join('\n');
}
