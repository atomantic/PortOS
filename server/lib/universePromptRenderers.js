/**
 * Shared renderers that turn a Universe Builder universe's `categories` map and
 * `compositeSheets` array into prompt-friendly text blocks. Used by both
 * `universeBuilderRefine` (which needs `[LOCKED]` flags) and `arcPlanner` (which
 * does not). The two prior copies in those files had drifted in formatting;
 * consolidating here keeps the LLM input shape consistent across stages.
 */

import { isEntryRevealGated } from './storyBible.js';

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

// Accept a Set, an array, or a single id and normalize to a Set of non-empty
// string ids. Callers pass whatever they already hold (a bound protagonist id,
// a scoped cast list) without pre-building a Set.
const asIdSet = (ids) => {
  if (ids instanceof Set) return ids;
  const list = Array.isArray(ids) ? ids : (ids == null ? [] : [ids]);
  return new Set(list.filter((id) => typeof id === 'string' && id));
};

// Stable partition: priority entries first (in their original relative order),
// everything else after. Not a sort — a comparator would reorder equal elements
// under an unstable engine and scramble the canon's authored importance order.
const hoistPriorityEntries = (entries, priority) => {
  const first = [];
  const rest = [];
  for (const entry of entries) (priority.has(entry?.id) ? first : rest).push(entry);
  return first.length ? [...first, ...rest] : entries;
};

// Render the universe's canon arrays (characters/places/objects) into a
// prompt-friendly text block. Distinct from renderCategoriesForPrompt because
// canon entries are first-class named entities with rich metadata, not
// exploratory variations — the arc planner references them by name.
// Caps each section at CANON_PROMPT_ENTRIES_PER_KIND_MAX entries; an
// "(… + N more)" footer signals truncation so the LLM doesn't assume the
// canon is complete.
export function renderCanonForPrompt(world, { priorityCharacterIds = null } = {}) {
  if (!world || typeof world !== 'object') return '';
  const priority = asIdSet(priorityCharacterIds);
  const sections = [];
  for (const { field, header, formatEntry } of CANON_SECTIONS) {
    const raw = Array.isArray(world[field]) ? world[field] : [];
    // A character the caller explicitly bound (the FableLoom protagonist) must
    // survive the per-kind cap — otherwise a 60-character universe can silently
    // drop the one entry the story is ABOUT. Hoisting is stable: the priority
    // entries keep their relative order, and so does everything after them.
    const entries = field === 'characters' && priority.size
      ? hoistPriorityEntries(raw, priority)
      : raw;
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
// `maxPerKind` accepts either a single number (applied to every kind) or a
// per-kind map (`{ characters, places, objects }`) so a caller can lift the cap
// on one kind while leaving the others at the default — e.g. the per-issue text
// stages render the roster with the WHOLE non-scoped character cast (continuity
// safety net) while keeping places/objects terse. A missing per-kind key falls
// back to the default cap.
const capForKind = (maxPerKind, field) => (
  typeof maxPerKind === 'object' && maxPerKind !== null
    ? (maxPerKind[field] ?? ENTITIES_SUMMARY_MAX_PER_KIND)
    : maxPerKind
);

// `excludeCharacterNames` (a Set of lower-cased names) drops characters already
// rendered in full elsewhere in the same prompt — e.g. the per-issue text stages
// list the SCOPED characters as full bible records, so re-listing them in this
// terse roster is pure duplication. Places/objects are never excluded (they have
// no full-record block to overlap with). The exclusion happens BEFORE the top-N
// slice so the "+N more" count reflects what's actually withheld.
export function renderEntitiesSummary(world, { maxPerKind = ENTITIES_SUMMARY_MAX_PER_KIND, excludeCharacterNames = null } = {}) {
  if (!world || typeof world !== 'object') return '';
  const exclude = excludeCharacterNames instanceof Set ? excludeCharacterNames : null;
  const lines = [];
  for (const { field, header, formatEntry } of SUMMARY_SECTIONS) {
    let entries = Array.isArray(world[field]) ? world[field] : [];
    if (field === 'characters' && exclude && exclude.size) {
      entries = entries.filter((e) => !exclude.has((e?.name || '').trim().toLowerCase()));
    }
    if (!entries.length) continue;
    const shown = entries.slice(0, capForKind(maxPerKind, field));
    const hidden = entries.length - shown.length;
    const tags = shown.map(formatEntry).filter(Boolean);
    if (!tags.length) continue;
    const joined = tags.join('; ');
    lines.push(hidden > 0 ? `${header}: ${joined}; (+${hidden} more)` : `${header}: ${joined}`);
  }
  return lines.join('\n');
}

// --- Authored character psychology (the "engines" block) -------------------
//
// A character's Ghost/Wound/Lie/Want/Need chain, motivations, relationship
// pressure and declared arc intent are PLOT inputs — the causal machinery that
// makes a character drive the story instead of decorating it. `formatCharacter`
// above deliberately renders only the descriptive/visual half of a canon
// record, so every consumer that reasons about CHOICE needs this second block.
//
// One vocabulary, one renderer: the Series arc planner
// (`renderCharacterFoundationForArc`), the FableLoom canon digest, and the
// series-concept seed all render through here so the labels the LLM learns in
// one stage mean the same thing in the next.

export const CHARACTER_NARRATIVE_FIELD_MAX = 220;

// Default caps per purpose. Arc planning keeps the historical top-six engine
// (it rides inside an already-long shape-guidance block); the FableLoom canon
// digest and the series-concept seed can afford a wider ensemble because the
// psychology block is the only place those prompts see causal motivation.
export const CHARACTER_NARRATIVE_ARC_MAX = 6;
const CHARACTER_NARRATIVE_DIGEST_MAX = 12;

/**
 * Ordered field spec. A newly authored psychology field (theory of control,
 * drives, …) becomes ONE row here and reaches the arc planner, the FableLoom
 * canon digest and the series seed in the same commit — that is the seam the
 * schema work plugs into, and the reason this table is not inlined per caller.
 *
 * `secrets` is deliberately absent: it is the one authored field whose whole
 * purpose is to stay unsaid, and this block feeds generation prompts.
 */
const CHARACTER_NARRATIVE_FIELD_SPECS = Object.freeze([
  { field: 'role', label: 'role', identity: true },
  { field: 'ghost', label: 'ghost' },
  { field: 'wound', label: 'wound' },
  { field: 'lie', label: 'lie' },
  { field: 'want', label: 'want' },
  { field: 'need', label: 'need' },
  { field: 'motivations', label: 'motives' },
  { field: 'relationships', label: 'relationships' },
  { field: 'arcType', label: 'arc intent' },
]);

const CORE_ROLE_RE = /protagonist|lead|hero|antagonist|villain|deuteragonist|mentor/i;

const compactCharacterField = (value, max = CHARACTER_NARRATIVE_FIELD_MAX) => {
  const flat = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

// How many psychology fields (identity excluded — `role` is already the
// core-role signal) the author actually filled in. Used as the ranking
// tiebreak: a fully authored supporting player is worth more prompt budget
// than a name-only walk-on.
const narrativeDepth = (character) => CHARACTER_NARRATIVE_FIELD_SPECS
  .filter(({ field, identity }) => !identity && compactCharacterField(character?.[field]))
  .length;

/**
 * Rank a cast for prompt inclusion and report what fell off the end.
 *
 * Order: caller-pinned ids (a bound protagonist) → recognized core roles →
 * authored depth → original canon order. Returns `{ shown, omitted }` so the
 * caller can render an explicit coverage footer instead of letting the model
 * assume it saw the whole ensemble.
 */
function rankCharactersForNarrativeContext(characters, {
  max = CHARACTER_NARRATIVE_ARC_MAX,
  priorityIds = null,
} = {}) {
  const list = (Array.isArray(characters) ? characters : []).filter((c) => c && typeof c === 'object');
  const priority = asIdSet(priorityIds);
  const ranked = list
    .map((character, index) => ({
      character,
      index,
      pinned: priority.has(character.id),
      coreRole: CORE_ROLE_RE.test(character.role || ''),
      depth: narrativeDepth(character),
    }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned)
      || Number(b.coreRole) - Number(a.coreRole)
      || b.depth - a.depth
      || a.index - b.index)
    .map(({ character }) => character);
  return { shown: ranked.slice(0, max), omitted: ranked.slice(max) };
}

/**
 * Render the authored psychology block.
 *
 * `respectRevealGates` is the safety valve: a character carrying a hard
 * `spoiler` flag or a `revealIssue` has authored history the audience has NOT
 * earned yet, so the gated entry renders as a named placeholder rather than
 * handing a generation prompt the concealed origin. Author-side planning
 * surfaces that already reason over the full bible leave it off.
 *
 * `reportOmitted` appends a coverage footer naming how many cast members the
 * cap withheld — a reviewer that is told the ensemble is complete when it is
 * not will confidently report on characters it never saw.
 */
export function renderCharacterNarrativeContext(characters, {
  max = CHARACTER_NARRATIVE_ARC_MAX,
  priorityIds = null,
  respectRevealGates = false,
  reportOmitted = false,
} = {}) {
  const { shown, omitted } = rankCharactersForNarrativeContext(characters, { max, priorityIds });
  if (!shown.length) return '';
  const lines = shown.map((character) => {
    const name = character.name || 'Unnamed';
    if (respectRevealGates && isEntryRevealGated(character)) {
      return `- ${name}: (reveal-gated — authored psychology withheld until the story earns it)`;
    }
    const fields = CHARACTER_NARRATIVE_FIELD_SPECS
      .map(({ field, label }) => [label, compactCharacterField(character[field])])
      .filter(([, value]) => value)
      .map(([label, value]) => `${label}=${value}`);
    return `- ${name}: ${fields.join(' | ') || '(framework not authored)'}`;
  });
  if (reportOmitted && omitted.length) {
    lines.push(`- (… + ${omitted.length} more characters not shown — prompt budget reached; do not treat this cast list as complete)`);
  }
  return lines.join('\n');
}

// Header for the psychology block inside a canon digest. Carries the standing
// craft constraint with it (behavior, not exposition) so every stage template
// that renders `{{canonDigest}}` inherits the rule without a template edit.
const CHARACTER_ENGINES_HEADER = 'character engines (author-only canon — motivate behavior and choices with these; do not have characters recite them as exposition, and do not reveal concealed history before the story earns it):';

/**
 * Compose the full story-facing canon digest for a linked universe: the
 * verified protagonist binding, the descriptive canon block, and the authored
 * psychology block. Shared by FableLoom generation/review (`weave.js`) and the
 * author-side editorial pass (`editorial.js`) so both reason from the same
 * facts — before this, both rendered `renderCanonForPrompt` alone and the
 * Ghost/Wound/Lie/Want/Need chain never reached the model at all (#6416).
 *
 * NOT for reader-facing surfaces. The play turn and the cold-opening
 * first-time-viewer review deliberately withhold canon; they must keep passing
 * their own placeholder rather than calling this.
 */
export function renderStoryCanonDigest(universe, { protagonistCharacterId = null } = {}) {
  if (!universe || typeof universe !== 'object') return '';
  const characters = Array.isArray(universe.characters) ? universe.characters : [];
  const protagonist = protagonistCharacterId
    ? characters.find((character) => character?.id === protagonistCharacterId)
    : null;
  const priorityIds = protagonist ? [protagonist.id] : null;
  const narrative = renderCharacterNarrativeContext(characters, {
    max: CHARACTER_NARRATIVE_DIGEST_MAX,
    priorityIds,
    respectRevealGates: true,
    reportOmitted: true,
  });
  return [
    protagonist ? `Verified Universe protagonist: id=${protagonist.id}; name=${protagonist.name}.` : '',
    renderCanonForPrompt(universe, { priorityCharacterIds: priorityIds }),
    narrative ? `${CHARACTER_ENGINES_HEADER}\n${narrative}` : '',
  ].filter(Boolean).join('\n\n');
}
