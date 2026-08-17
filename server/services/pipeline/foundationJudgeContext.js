/**
 * Pure foundation-judge input projection, hashing, and prompt context assembly.
 *
 * The orchestration, persistence, and repair paths remain in foundationJudge.js;
 * this module owns the deterministic view of the foundation those paths judge.
 */

import { createHash } from 'crypto';
import { composeStyleNotes } from '../../lib/styleGuide.js';
import { renderCharacterArcsForPrompt } from '../../lib/seriesCharacterArc.js';
import { renderEntitiesSummary } from '../../lib/universePromptRenderers.js';
import { isBlankString, isBlankArray } from '../universeCharacterExpand.js';

// The character-framework subset the character dimension scores (Ghost → Wound →
// Lie → Want → Need chain + secrets + arc fields). Shared by the hash projection
// and the "thinnest character" fix target so both read the SAME field set.
export const FRAMEWORK_STRING_FIELDS = Object.freeze(['ghost', 'wound', 'lie', 'want', 'need', 'coreTheme', 'motivations', 'speechPattern']);
// A dramatic engine alone does not make a complete bible card. These fields
// prevent a later drafter or renderer from having to invent a supporting
// character's identity, behavior, and capabilities after the plot is settled.
export const PROFILE_STRING_FIELDS = Object.freeze([
  'pronouns', 'age', 'speechAccent', 'personality', 'background',
  'likes', 'dislikes', 'mannerisms', 'relationships', 'skills',
]);
// Identity-bearing visual axes a graphic-novel lead needs before the plot is
// allowed to grow around them. This intentionally stops short of requiring a
// human facial-expression or wardrobe sheet from non-human characters.
export const VISUAL_FOUNDATION_STRING_FIELDS = Object.freeze([
  'physicalDescription', 'visualNotes', 'silhouetteNotes', 'visualIdentity',
]);
export const VISUAL_FOUNDATION_LIST_FIELDS = Object.freeze(['colorPalette']);

export function pickFrameworkFields(c) {
  const out = {};
  for (const f of FRAMEWORK_STRING_FIELDS) out[f] = c?.[f] || '';
  out.arcType = c?.arcType || '';
  out.secrets = Array.isArray(c?.secrets) ? c.secrets : [];
  return out;
}

function pickProfileFields(c) {
  return Object.fromEntries(PROFILE_STRING_FIELDS.map((field) => [field, c?.[field] || '']));
}

export function pickVisualFoundationFields(c) {
  const out = {};
  for (const field of VISUAL_FOUNDATION_STRING_FIELDS) out[field] = c?.[field] || '';
  for (const field of VISUAL_FOUNDATION_LIST_FIELDS) out[field] = Array.isArray(c?.[field]) ? c[field] : [];
  return out;
}

function countOccurrences(text, value) {
  const haystack = String(text || '').toLocaleLowerCase();
  const needle = String(value || '').trim().toLocaleLowerCase();
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

export function rankFoundationCharacters(characters, series, issues = [], { includeLocked = false } = {}) {
  const list = Array.isArray(characters) ? characters : [];
  const storyText = JSON.stringify({
    logline: series?.logline || '',
    premise: series?.premise || '',
    arc: series?.arc || null,
    seasons: series?.seasons || [],
    characterArcs: series?.characterArcs || [],
    episodes: (Array.isArray(issues) ? issues : []).map((issue) => ({
      title: issue?.title || '',
      synopsis: issue?.stages?.idea?.input || '',
    })),
  });
  const authoredArcKeys = new Set((Array.isArray(series?.characterArcs) ? series.characterArcs : [])
    .flatMap((arc) => [
      arc?.characterId || '',
      arc?.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '',
    ])
    .filter(Boolean));
  return list
    .filter((character) => character && (includeLocked || character.locked !== true))
    .map((character, index) => {
      const blanks = FRAMEWORK_STRING_FIELDS.filter((field) => isBlankString(character[field])).length
        + PROFILE_STRING_FIELDS.filter((field) => isBlankString(character[field])).length
        + (isBlankArray(character.secrets) ? 1 : 0)
        + VISUAL_FOUNDATION_STRING_FIELDS.filter((field) => isBlankString(character[field])).length
        + VISUAL_FOUNDATION_LIST_FIELDS.filter((field) => isBlankArray(character[field])).length;
      const mentions = countOccurrences(storyText, character.name);
      const authoredArc = authoredArcKeys.has(character.id)
        || authoredArcKeys.has(`name:${String(character.name || '').trim().toLowerCase()}`);
      const coreRole = /protagonist|lead|hero|antagonist|villain|deuteragonist|mentor/i.test(character.role || '');
      const seriesOwned = !!series?.id && character.sourceSeriesId === series.id;
      return { character, index, mentions, authoredArc, coreRole, seriesOwned, blanks };
    })
    .sort((a, b) => Number(b.authoredArc) - Number(a.authoredArc)
      || Number(b.seriesOwned) - Number(a.seriesOwned)
      || Number(b.coreRole) - Number(a.coreRole)
      || b.mentions - a.mentions
      || b.blanks - a.blanks
      || a.index - b.index);
}

/**
 * Resolve the cast that belongs to this series from actual story references.
 * Once a plot exists, every named/arc-linked character is retained: there is no
 * arbitrary top-N cap. Before a plot exists, a small ranked fallback gives the
 * character architect enough principals to start from without drafting every
 * unrelated person in a shared universe.
 *
 * Locked referenced characters remain in this returned roster because the
 * judge still has to see constraints it cannot repair. Repair callers filter
 * them separately.
 */
export function seriesFoundationCharacters(characters, series, issues = []) {
  const ranked = rankFoundationCharacters(characters, series, issues, { includeLocked: true });
  const referenced = ranked.filter(({ authoredArc, mentions, seriesOwned }) => authoredArc || mentions > 0 || seriesOwned);
  const selected = referenced.length > 0 ? referenced : ranked.slice(0, 6);
  return selected.map(({ character }) => character);
}

export function repairableSeriesFoundationCharacters(characters, series, issues = []) {
  return seriesFoundationCharacters(characters, series, issues)
    .filter((character) => character?.locked !== true);
}

/**
 * Blank foundation fields across the cast a `character` repair is allowed to
 * write — the series roster minus locked members, over the SAME framework,
 * profile, and visual field sets the character dimension is scored on.
 *
 * This is the gate's objective, LLM-free second opinion on a repair the judge
 * scored as a tie. A judge can misread the cast — a presence-marker render once
 * showed every authored design as the bare word `ready`, so a complete five-sheet
 * character foundation was scored as absent and thrown away — but "25 named
 * fields went from empty to authored" is a fact on disk, not an opinion.
 */
export function countFoundationCharacterBlanks(characters, series, issues = []) {
  const targets = repairableSeriesFoundationCharacters(characters, series, issues);
  return rankFoundationCharacters(targets, series, issues)
    .reduce((total, { blanks }) => total + blanks, 0);
}

// ---------- input hashing (fast-pass / staleness) ----------

// The judged foundation as a stable, hashable projection: universe canon,
// character records, the full synopsis plan, authored character arcs, and the
// series voice. A change
// to ANY of these flips the pinned hash so a re-judge re-runs; an unchanged
// foundation short-circuits to the cached verdict. Kept deliberately narrow —
// only the fields the judge actually reads — so an unrelated series edit (e.g. a
// render slot) doesn't needlessly invalidate the score.
export function foundationInputs(series, universe, issues = []) {
  const characters = Array.isArray(universe?.characters) ? universe.characters : [];
  const seriesCharacters = seriesFoundationCharacters(characters, series, issues);
  const episodeInputs = [...(Array.isArray(issues) ? issues : [])]
    .sort((a, b) => String(a?.seasonId || '').localeCompare(String(b?.seasonId || ''))
      || (a?.number ?? 9999) - (b?.number ?? 9999)
      || String(a?.id || '').localeCompare(String(b?.id || '')))
    .map((issue) => ({
      id: issue?.id || '',
      seasonId: issue?.seasonId || '',
      number: issue?.number ?? null,
      title: issue?.title || '',
      arcRole: issue?.arcRole || null,
      lengthProfile: issue?.lengthProfile || null,
      synopsis: issue?.stages?.idea?.input || '',
    }));
  return {
    world: universe
      ? {
        // The starter prompt is the author's protected originating intent, not
        // just another generated bible paragraph. A change here must invalidate
        // a cached verdict, and the judge must compare every derived field to it
        // so a polished-but-off-premise foundation cannot fast-pass forever.
        starterPrompt: universe.starterPrompt || '',
        logline: universe.logline || '',
        premise: universe.premise || '',
        styleNotes: universe.styleNotes || '',
        influences: universe.influences || null,
        // Places/objects are rendered into the world summary the judge scores,
        // so a user edit to either must flip the pinned hash (otherwise a clean
        // verdict would wrongly fast-pass a changed world).
        places: Array.isArray(universe.places) ? universe.places : [],
        objects: Array.isArray(universe.objects) ? universe.objects : [],
      }
      : null,
    // A linked universe can contain characters belonging to other stories. Only
    // the cast referenced by THIS series is judged and hashed; otherwise an
    // unrelated blank universe asset can keep an otherwise-ready series trapped
    // in the character repair loop forever.
    characters: seriesCharacters.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role || '',
      ...pickFrameworkFields(c),
      ...pickProfileFields(c),
      ...pickVisualFoundationFields(c),
    })),
    arc: series?.arc || null,
    seasons: Array.isArray(series?.seasons)
      ? series.seasons.map((s) => ({
        id: s.id,
        number: s.number,
        title: s.title || '',
        logline: s.logline || '',
        synopsis: s.synopsis || '',
        endingHook: s.endingHook || '',
      }))
      : [],
    episodes: episodeInputs,
    characterArcs: Array.isArray(series?.characterArcs) ? series.characterArcs : [],
    voice: {
      styleNotes: series?.styleNotes || '',
      styleGuide: series?.styleGuide || null,
    },
  };
}

export const contentHash = (value) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
export const foundationInputsHash = (series, universe, issues = []) => contentHash(foundationInputs(series, universe, issues));

// ---------- context assembly ----------

// Render one character's framework completeness so the judge can see which of
// the Wound/Lie/Want/Need chain is present vs. blank (the character dimension's
// core signal) without dumping the whole record.
export function renderCharacterLine(c, { core = false } = {}) {
  const role = c?.role ? ` (${c.role})` : '';
  const concise = (value, maxChars = 100) => {
    if (typeof value !== 'string' || !value.trim()) return '—';
    const compact = value.trim().replace(/\s+/g, ' ');
    return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 1).trimEnd()}…`;
  };
  const framework = FRAMEWORK_STRING_FIELDS
    .map((field) => `${field}: ${concise(c?.[field])}`)
    .join(' | ');
  const profile = PROFILE_STRING_FIELDS
    .map((field) => `${field}: ${concise(c?.[field])}`)
    .join(' | ');
  const secrets = (Array.isArray(c?.secrets) ? c.secrets : [])
    .map(concise)
    .slice(0, 3)
    .join('; ');
  // The harsh judge needs the actual render identity, not a presence marker.
  // `ready` proved actively misleading: five complete character sheets were
  // scored as absent because the prompt hid every distinguishing detail. Keep
  // the lines bounded, but show enough anatomy, silhouette, palette, and visual
  // grammar to compare the cast and identify generic or contradictory designs.
  const visualString = (field) => (isBlankString(c?.[field]) ? 'BLANK' : concise(c[field], 320));
  const visualList = (field) => {
    if (isBlankArray(c?.[field])) return 'BLANK';
    const compact = JSON.stringify(c[field]).replace(/\s+/g, ' ');
    return compact.length <= 420 ? compact : `${compact.slice(0, 419).trimEnd()}…`;
  };
  const visual = [
    ...VISUAL_FOUNDATION_STRING_FIELDS.map((field) => `${field}: ${visualString(field)}`),
    ...VISUAL_FOUNDATION_LIST_FIELDS.map((field) => `${field}: ${visualList(field)}`),
  ].join(' | ');
  return `- ${core ? '[CORE] ' : ''}**${c?.name || 'Unnamed'}**${role} — dramatic framework: ${framework} | profile: ${profile} | arcType: ${c?.arcType || '—'} | secrets: ${secrets || '—'} | visual foundation: ${visual}`;
}

const joinedLength = (lines) => lines.reduce((total, line) => total + line.length + 1, 0);

const pluralLines = (count) => (count === 1 ? 'line' : 'lines');

// Last-resort clamp for `renderArc`. Every tier above it drops WHOLE lines so the
// render stays coherent, but a budget smaller than the arc header itself (or a
// series with more volume loglines than the budget has room for) can still
// overrun — and `maxChars` is a hard contract, not a target. Slice, and keep the
// marker only when there is room for it.
const ARC_TRUNCATION_NOTE = '\n[series plan truncated to fit the prompt budget]';
function clampArcToBudget(text, maxChars) {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  if (maxChars <= ARC_TRUNCATION_NOTE.length) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - ARC_TRUNCATION_NOTE.length)}${ARC_TRUNCATION_NOTE}`;
}

/**
 * Render the synopsis-level series plan: arc header, per-volume loglines and
 * synopses, the episode list under each volume, and the authored character arcs.
 *
 * `maxChars` is a HARD bound on the result, spent in tiers so the render always
 * degrades to something coherent rather than being sliced mid-sentence:
 *
 *   1. Drop WHOLE episode synopsis lines from the end. Earliest episodes survive
 *      a tight budget because that's where a character arc's opening transitions
 *      hang.
 *   2. If the spine alone (arc header + every volume's logline/synopsis/hook +
 *      the authored character arcs) still overruns, drop the per-volume synopsis
 *      and ending-hook lines, keeping `V# title: logline` so the volume order and
 *      shape survive. Every episode goes with them.
 *   3. Slice, as a floor, when even the loglines cannot fit — a caller that set a
 *      budget gets a smaller string, never a longer one.
 *
 * Each tier names what it left out, so the model can tell a short plan from a
 * budgeted one.
 *
 * Unbudgeted (the default) the output is byte-identical to the pre-budget
 * render, so the foundation judge's own section-level truncation is unchanged.
 */
export function renderArc(series, issues = [], { maxChars = Infinity, includeArcTransitions = false } = {}) {
  const arc = series?.arc || {};
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort((a, b) => (a.number || 0) - (b.number || 0)) : [];
  const orderedIssues = [...(Array.isArray(issues) ? issues : [])]
    .sort((a, b) => (a?.number ?? 9999) - (b?.number ?? 9999));
  const themes = Array.isArray(arc.themes) ? arc.themes.join(', ') : (arc.themes || '');
  const head = [
    `Logline: ${arc.logline || '(none)'}`,
    `Summary: ${arc.summary || '(none)'}`,
    `Themes: ${themes || '(none)'}`,
    `Protagonist arc: ${arc.protagonistArc || '(none)'}`,
    `Shape: ${arc.shape || '(unset)'}`,
    '',
    `Volumes (${seasons.length}):`,
  ];
  const volumes = seasons.map((season) => {
    const logline = `  V${season.number ?? '?'} ${season.title || ''}: ${season.logline || '(no logline)'}`;
    const detail = [`    Synopsis: ${season.synopsis || '(none)'}`];
    if (season.endingHook) detail.push(`    Ending hook: ${season.endingHook}`);
    const episodes = orderedIssues
      .filter((issue) => issue?.seasonId === season.id)
      .map((issue) => {
        const synopsis = issue?.stages?.idea?.input || '(no synopsis)';
        const words = synopsis === '(no synopsis)' ? 0 : synopsis.trim().split(/\s+/).filter(Boolean).length;
        const metadata = [
          issue.arcRole ? `role=${issue.arcRole}` : 'role=unset',
          issue.lengthProfile ? `length=${issue.lengthProfile}` : 'length=unset',
          `${words} synopsis words`,
        ].join(', ');
        return `    #${issue.number ?? '?'} ${issue.title || 'Untitled'} [${metadata}]: ${synopsis}`;
      });
    return { logline, detail, episodes };
  });
  const characterArcs = Array.isArray(series?.characterArcs) ? series.characterArcs : [];
  const tail = ['', `Authored character arcs (${characterArcs.length}):`];
  if (includeArcTransitions) {
    tail.push(renderCharacterArcsForPrompt(characterArcs) || '(none)');
  } else {
    for (const characterArc of characterArcs) {
      tail.push(`  - ${characterArc.characterName || characterArc.characterId || 'Unnamed'}: ${characterArc.startState || '(no start)'} → ${characterArc.endState || '(no end)'}; want=${characterArc.want || '—'}; need=${characterArc.need || '—'}`);
    }
  }

  // Tier 1: the full spine is unconditional; episodes fill whatever is left.
  const fullSpine = [...head, ...volumes.flatMap((volume) => [volume.logline, ...volume.detail]), ...tail];
  let remaining = maxChars - joinedLength(fullSpine);
  const notes = [];
  // Tier 2: the spine alone overruns, so the per-volume synopsis/hook lines go
  // and every episode goes with them — dropping craft detail to make room for
  // episode lines would invert the priority the tiers exist to express.
  const withDetail = remaining >= 0;
  if (!withDetail) {
    const droppedDetail = volumes.reduce((total, volume) => total + volume.detail.length, 0);
    if (droppedDetail > 0) {
      notes.push(`  [${droppedDetail} volume synopsis ${pluralLines(droppedDetail)} omitted to fit the prompt budget]`);
    }
    remaining = -1;
  }
  let omitted = 0;
  const lines = [...head];
  for (const volume of volumes) {
    lines.push(volume.logline);
    if (withDetail) lines.push(...volume.detail);
    for (const episode of volume.episodes) {
      if (episode.length + 1 <= remaining) {
        lines.push(episode);
        remaining -= episode.length + 1;
      } else {
        omitted += 1;
      }
    }
  }
  if (omitted > 0) lines.push(`  [${omitted} later episode synopsis ${pluralLines(omitted)} omitted to fit the prompt budget]`);
  lines.push(...notes, ...tail);
  return clampArcToBudget(lines.join('\n'), maxChars);
}

// Below this the named-canon line carries no usable signal — render the
// omission marker instead of a handful of dangling entity names.
const NAMED_CANON_MIN_CHARS = 200;

/**
 * Render the world as the worldbuilding dimension is scored on it, bounded by
 * `maxChars`.
 *
 * The budget is spent by dropping the NAMED-CANON inventory, never the narrative
 * spine. Causal rules, costs, hard limits, and failure modes live in the premise
 * and style notes; the entity list is the noun inventory whose over-supply the
 * judge already penalizes, and it is the part that grows without bound. Slicing
 * the joined block instead (what this did before) cut the TAIL of the premise —
 * exactly where a freshly authored ruleset lands — so a world repair the judge
 * had just demanded became invisible to the next judge, the score never moved,
 * and the foundation gate burned its rounds against a repair it could not see.
 */
export function renderWorldFoundation(universe, { maxChars = Infinity } = {}) {
  if (!universe) return '(no linked universe — worldbuilding cannot be judged from canon)';
  const influences = universe.influences && typeof universe.influences === 'object'
    ? `Embrace: ${(universe.influences.embrace || []).join(', ') || '—'}; Avoid: ${(universe.influences.avoid || []).join(', ') || '—'}`
    : '(none)';
  const spine = [
    `Protected author intent (starter idea): ${universe.starterPrompt || '(none)'}`,
    `Universe logline: ${universe.logline || '(none)'}`,
    `Universe premise: ${universe.premise || '(none)'}`,
    `Universe style: ${universe.styleNotes || '(none)'}`,
    `Influences: ${influences}`,
  ].join('\n');
  const entities = renderEntitiesSummary(universe, { maxPerKind: { characters: 0 } }) || '(no named places or objects)';
  const canonLine = `Named canon: ${entities}`;
  const remaining = maxChars - spine.length - 1;
  if (canonLine.length <= remaining) return `${spine}\n${canonLine}`;
  if (remaining >= NAMED_CANON_MIN_CHARS) return `${spine}\n${canonLine.slice(0, remaining - 1).trimEnd()}…`;
  if (spine.length <= maxChars) return `${spine}\nNamed canon: [omitted to fit the judging budget]`;
  // The spine alone overruns: the premise is larger than this judge model's
  // world budget. Slicing is unavoidable here, but say so rather than letting
  // the judge score a silently amputated world.
  return `${spine.slice(0, maxChars)}\n\n[world summary truncated for judging]`;
}

// Build the judge's variable bag from the whole foundation. Content is budgeted
// to the judge model's window (a small/local judge trims to fit rather than
// overflowing; a big-context judge gets the whole foundation).
export function buildFoundationContext({ series, universe, canon, issues = [], contentMax }) {
  const characters = Array.isArray(canon?.characters) ? canon.characters : [];
  const seriesCharacters = seriesFoundationCharacters(characters, series, issues);
  const characterRoster = seriesCharacters.length
    ? seriesCharacters.map((character) => renderCharacterLine(character, { core: true })).join('\n')
    : '(no canon characters)';
  const sectionMax = Math.max(1_000, Math.floor(contentMax / 3));
  const world = renderWorldFoundation(universe, { maxChars: sectionMax });
  // Character quality lives in the choices between start and end, not merely
  // the endpoints. Reuse the canonical authored-arc renderer here so the judge
  // sees decisions, relapses, sacrifices, and their issue placement. The
  // repair prompt keeps the legacy compact summary because it already receives
  // the full `series.characterArcs` JSON separately.
  const arcText = renderArc(series, issues, { includeArcTransitions: true });
  const roster = characterRoster.length > sectionMax
    ? `${characterRoster.slice(0, sectionMax)}\n\n[character roster truncated for judging]`
    : characterRoster;
  const arcContext = arcText.length > sectionMax
    ? `${arcText.slice(0, sectionMax)}\n\n[series plan truncated for judging]`
    : arcText;
  return {
    series: {
      name: series?.name || 'Untitled series',
      logline: series?.logline || '',
      premise: series?.premise || '',
      styleNotes: composeStyleNotes(series, { proseCraft: true }),
    },
    worldEntitiesSummary: world,
    characterRoster: roster,
    characterCount: seriesCharacters.length,
    arc: arcContext,
  };
}
