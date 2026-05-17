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
const formatSetting = (s) => {
  const label = s.name || s.slugline || '(unnamed)';
  const sluglineTag = s.name && s.slugline ? ` (${s.slugline})` : '';
  const palette = s.palette ? ` palette: ${s.palette}` : '';
  const parts = [
    truncDesc(s.description || ''),
    s.recurringDetails ? `recurring: ${truncDesc(s.recurringDetails)}` : '',
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
  { field: 'settings', header: 'places', formatEntry: formatSetting },
  { field: 'objects', header: 'objects', formatEntry: formatObject },
];

// Render the universe's canon arrays (characters/settings/objects) into a
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
