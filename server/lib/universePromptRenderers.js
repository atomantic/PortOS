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

// Per-canon-kind formatting table — header label + per-entry line builder.
// One row per canon trunk; renderCanonForPrompt iterates this so a future
// kind addition (or field tweak) is a one-line change.
const CANON_SECTIONS = [
  {
    field: 'characters',
    header: 'characters',
    formatEntry: (c) => {
      const desc = c.physicalDescription || c.description || '';
      const role = c.role ? ` [${c.role}]` : '';
      return `  - ${c.name}${role}${desc ? `: ${desc}` : ''}`;
    },
  },
  {
    field: 'settings',
    header: 'places',
    formatEntry: (s) => {
      const label = s.name || s.slugline || '(unnamed)';
      const desc = s.description || '';
      const palette = s.palette ? ` palette: ${s.palette}` : '';
      return `  - ${label}${desc ? `: ${desc}` : ''}${palette}`;
    },
  },
  {
    field: 'objects',
    header: 'objects',
    formatEntry: (o) => {
      const desc = o.description || '';
      const sig = o.significance ? ` (${o.significance})` : '';
      return `  - ${o.name}${desc ? `: ${desc}` : ''}${sig}`;
    },
  },
];

// Render the universe's canon arrays (characters/settings/objects) into a
// prompt-friendly text block. Distinct from renderCategoriesForPrompt because
// canon entries are first-class named entities with rich metadata, not
// exploratory variations — the arc planner references them by name.
export function renderCanonForPrompt(world) {
  if (!world || typeof world !== 'object') return '';
  const sections = [];
  for (const { field, header, formatEntry } of CANON_SECTIONS) {
    const entries = Array.isArray(world[field]) ? world[field] : [];
    if (!entries.length) continue;
    sections.push(`${header}:\n${entries.map(formatEntry).join('\n')}`);
  }
  return sections.join('\n\n');
}
