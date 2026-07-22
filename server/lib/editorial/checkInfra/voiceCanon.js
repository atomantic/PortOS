/**
 * Voice + canon-state prompt summaries (#2842 split of checkInfra.js). Renders
 * the authored voice fields, style-guide intent, character state/trait facts and
 * the continuity ledger into the compact text blocks the LLM checks pass
 * alongside the manuscript.
 */

import { characterNameTokens } from './rosterCast.js';

// Stage name for the narrator voice / tone-consistency LLM check (#1586) — the
// narration-level sibling of voice-distinctiveness (which covers per-CHARACTER
// dialogue). Ships in data.reference/prompts/stages/ + stage-config.json (fresh
// installs via setup-data.js) and migrates to existing installs via migration 134
// (boot runs migrations but NOT setup-data, so the migration is required).
export const VOICE_CONSISTENCY_STAGE = 'pipeline-editorial-voice-consistency';

// Render each canon character's authored voice fields into a compact text block
// the voice-distinctiveness LLM check passes alongside the manuscript, so the
// model can flag lines that contradict a character's recorded speechPattern /
// speechAccent (closing the "voice fields feed generation only" gap, #1307) and
// reason about whether characters sound distinct from one another. Pure +
// deterministic so it's unit-testable and its token cost can be counted into the
// per-chunk overhead. Returns '' when no character carries a voice field (the
// prompt's {{#voiceProfiles}} section then renders nothing and the check
// degrades to a pure interchangeability scan).
export function characterVoiceProfiles(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const lines = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (!name) continue;
    const pattern = typeof c.speechPattern === 'string' ? c.speechPattern.trim() : '';
    const accent = typeof c.speechAccent === 'string' ? c.speechAccent.trim() : '';
    if (!pattern && !accent) continue;
    const parts = [`- ${name}`];
    if (pattern) parts.push(`speech pattern: ${pattern}`);
    if (accent) parts.push(`accent/dialect: ${accent}`);
    lines.push(parts.join(' — '));
  }
  if (!lines.length) return '';
  return `Authored character voices (canon speechPattern / speechAccent):\n${lines.join('\n')}`;
}

// Render the series style guide's INTENDED narrative voice — the authored `tone`
// words (e.g. "witty", "grim", "lyrical") — into a compact block the narrator
// voice-consistency check (#1586) passes alongside the manuscript, so the model
// can measure each issue's narration against the declared intent, not just
// against the other issues. Pure + deterministic so it's unit-testable and its
// token cost counts into the per-chunk overhead. Type-guarded (styleGuide rides
// peer sync, so a hand-edited / older-peer guide could carry a non-array `tone`
// or non-string entries). Returns '' when the guide declares no tone (the
// prompt's {{#intendedVoice}} section then renders nothing and the check degrades
// to a pure cross-issue consistency scan).
export function intendedVoiceSummary(styleGuide) {
  const raw = Array.isArray(styleGuide?.tone) ? styleGuide.tone : [];
  const tone = raw
    .filter((t) => typeof t === 'string' && t.trim())
    .map((t) => t.trim());
  if (!tone.length) return '';
  return `Style guide — intended narrative tone/voice: ${tone.join(', ')}.`;
}

// Render each canon character's contradiction-relevant FACTS into a compact text
// block the timeline / canon-contradiction check (#1581) passes alongside the
// manuscript, so the model can reconcile the prose against the established bible:
// a character the bible records at age 16 who reads "in her 30s" on the page, a
// role/status the prose contradicts, or a description the prose breaks. Pure +
// deterministic so it's unit-testable and its token cost can be counted into the
// per-chunk overhead. Type-guarded throughout (canon rides peer sync, so a
// hand-edited / older-peer character could carry a non-string field a bare
// `.trim()` would throw on — and `age` is commonly stored as a number). Reuses
// `characterNameTokens` so name + aliases render with the same trim/de-dup the
// matcher uses. Returns '' when no character carries both a usable name AND a
// renderable fact (the prompt's `{{#canonStates}}` section then renders nothing
// and the check reasons from the prose + scene map alone).
const CANON_STATE_FACT_CHARS = 240;
export function canonCharacterStatesSummary(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');
  const rows = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    // Require a real name — an alias-only row isn't a named character (mirrors
    // canonRosterNamesSummary, which skips nameless rows). characterNameTokens then
    // returns the trimmed name first, followed by de-duped aliases.
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    const [name, ...aliases] = characterNameTokens(c);
    const facts = [];
    // `age` is often a number in the bible — accept a finite number or a non-empty string.
    const age = typeof c.age === 'number' && Number.isFinite(c.age) ? String(c.age) : cleanStr(c.age);
    if (age) facts.push(`age ${age}`);
    const role = cleanStr(c.role);
    if (role) facts.push(`role: ${role}`);
    const status = cleanStr(c.status);
    if (status) facts.push(`status: ${status}`);
    // physicalDescription is the richer bible field; fall back to a generic description.
    const description = (cleanStr(c.physicalDescription) || cleanStr(c.description)).slice(0, CANON_STATE_FACT_CHARS);
    if (description) facts.push(`described as: ${description}`);
    if (!facts.length) continue;
    const who = aliases.length ? `${name} (also: ${aliases.join(', ')})` : name;
    rows.push(`- ${who} — ${facts.join('; ')}`);
  }
  if (!rows.length) return '';
  return `Canon character facts (the established bible — reconcile the prose against these):\n${rows.join('\n')}`;
}

// Render each canon character's PERSONALITY-relevant traits into a compact text
// block the character-consistency check (#1582) passes alongside the manuscript,
// so the model can flag an UNEARNED shift: a reserved character suddenly cracking
// jokes, an established fear/allergy silently contradicted, a voice that drifts
// off the authored speech pattern. Distinct from `canonCharacterStatesSummary`
// (age/role/status/described-as — the contradiction-of-FACTS grounding the
// timeline check reads) and from `characterVoiceProfiles` (speech only): this is
// the temperament/traits grounding. Pure + deterministic so it's unit-testable
// and its token cost can be counted into the per-chunk overhead. Type-guarded
// throughout (canon rides peer sync, so a hand-edited / older-peer character
// could carry a non-string field a bare `.trim()` would throw on, and
// mannerisms/likes/dislikes are commonly arrays). Reuses `characterNameTokens` so
// name + aliases render with the same trim/de-dup the matcher uses. Returns ''
// when no character carries both a usable name AND a renderable trait (the
// prompt's `{{#canonTraits}}` section then renders nothing and the check reasons
// from the prose alone).
const CANON_TRAIT_FACT_CHARS = 240;
export function canonCharacterTraitsSummary(canon) {
  const chars = Array.isArray(canon?.characters) ? canon.characters : [];
  const cleanStr = (v) => (typeof v === 'string' ? v.trim() : '');
  // mannerisms / likes / dislikes are commonly arrays of short strings in the
  // bible; render the first few as a comma list. Tolerates a plain string too.
  const cleanList = (v) => {
    if (typeof v === 'string') return v.trim();
    if (!Array.isArray(v)) return '';
    return v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).slice(0, 5).join(', ');
  };
  const rows = [];
  for (const c of chars) {
    if (!c || typeof c !== 'object') continue;
    // Require a real name — an alias-only row isn't a named character (mirrors
    // canonCharacterStatesSummary). characterNameTokens returns the trimmed name
    // first, followed by de-duped aliases.
    if (typeof c.name !== 'string' || !c.name.trim()) continue;
    const [name, ...aliases] = characterNameTokens(c);
    const facts = [];
    const personality = cleanStr(c.personality).slice(0, CANON_TRAIT_FACT_CHARS);
    if (personality) facts.push(`personality: ${personality}`);
    const specialTraits = cleanStr(c.specialTraits).slice(0, CANON_TRAIT_FACT_CHARS);
    if (specialTraits) facts.push(`fixed traits: ${specialTraits}`);
    const mannerisms = cleanList(c.mannerisms);
    if (mannerisms) facts.push(`mannerisms: ${mannerisms}`);
    const motivations = cleanStr(c.motivations).slice(0, CANON_TRAIT_FACT_CHARS);
    if (motivations) facts.push(`motivations: ${motivations}`);
    const likes = cleanList(c.likes);
    if (likes) facts.push(`likes: ${likes}`);
    const dislikes = cleanList(c.dislikes);
    if (dislikes) facts.push(`dislikes: ${dislikes}`);
    const speechPattern = cleanStr(c.speechPattern);
    if (speechPattern) facts.push(`speech: ${speechPattern}`);
    // Authored character-framework fields (CWQE Phase 10, #2175) — the Lie the
    // character believes, the Want (external goal), the Need (the Truth), and
    // the declared arc type. Surfacing these lets the consistency / arc checks
    // reconcile the prose against the PLAN (does the character overcome the Lie,
    // pursue the Want, arrive at the Need per the declared arc?) instead of
    // inferring the intended arc from the prose alone.
    const lie = cleanStr(c.lie).slice(0, CANON_TRAIT_FACT_CHARS);
    if (lie) facts.push(`believes (Lie): ${lie}`);
    const want = cleanStr(c.want).slice(0, CANON_TRAIT_FACT_CHARS);
    if (want) facts.push(`wants: ${want}`);
    const need = cleanStr(c.need).slice(0, CANON_TRAIT_FACT_CHARS);
    if (need) facts.push(`needs (Truth): ${need}`);
    const arcType = cleanStr(c.arcType);
    if (arcType) facts.push(`declared arc: ${arcType}`);
    if (!facts.length) continue;
    const who = aliases.length ? `${name} (also: ${aliases.join(', ')})` : name;
    rows.push(`- ${who} — ${facts.join('; ')}`);
  }
  if (!rows.length) return '';
  return `Canon character traits (the established bible — a shift away from these must be earned on the page):\n${rows.join('\n')}`;
}

// Human-readable labels for the continuity-bible fact categories (#1305). Inlined
// (not imported from server/services/pipeline/continuityBible.js) to keep this
// registry PURE — that module pulls in I/O + an SSE runner. Mirrors its
// `FACT_CATEGORIES`; a category absent from this map falls back to its raw id, so
// a new bible category still renders (just without a prettied label) until it's
// added here.
const CONTINUITY_CATEGORY_LABELS = Object.freeze({
  physical: 'Physical traits',
  age: 'Ages & birthdays',
  timeline: 'Dates & elapsed time',
  location: 'Locations & geography',
  possession: 'Possessions & wardrobe',
  'world-rule': 'World rules',
  knowledge: 'Who knows what, when',
});

// Render the continuity-bible facts ledger (#1305) into a compact text block the
// timeline / canon-contradiction check (#1581) passes alongside the manuscript, so
// the model reconciles the prose against the established ground-truth facts the
// bible already extracted — ages/birthdays, dates & elapsed time, locations, world
// rules, who-knows-what — which the shallow per-character canon fields don't carry.
// Facts are grouped by category (in the stable category order) and tagged with the
// issue they were established in, when known, so the model can reason about WHEN a
// fact held. Pure + deterministic so it's unit-testable and its token cost can be
// counted into the per-chunk overhead. Type-guarded throughout (the ledger rides
// peer sync, so a hand-edited / older-peer fact could carry a non-string field).
// Returns '' when there are no usable facts (the prompt's `{{#continuityLedger}}`
// section then renders nothing and the check falls back to the canon fields + prose).
export function continuityLedgerSummary(facts) {
  const list = Array.isArray(facts) ? facts : [];
  const byCategory = new Map();
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const category = typeof f.category === 'string' ? f.category.trim() : '';
    const subject = typeof f.subject === 'string' ? f.subject.trim() : '';
    const statement = typeof f.statement === 'string' ? f.statement.trim() : '';
    if (!category || !statement) continue;
    const where = Number.isInteger(f.issueNumber) ? ` (Issue ${f.issueNumber})` : '';
    const line = subject ? `- ${subject}: ${statement}${where}` : `- ${statement}${where}`;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(line);
  }
  if (!byCategory.size) return '';
  // Render known categories in their canonical order first, then any unknown
  // category (a newer-peer addition) after, so the block is stable + complete.
  const order = [...Object.keys(CONTINUITY_CATEGORY_LABELS), ...byCategory.keys()];
  const seen = new Set();
  const blocks = [];
  for (const category of order) {
    if (seen.has(category) || !byCategory.has(category)) continue;
    seen.add(category);
    const label = CONTINUITY_CATEGORY_LABELS[category] || category;
    blocks.push(`${label}:\n${byCategory.get(category).join('\n')}`);
  }
  return `Continuity bible facts (established ground truth — reconcile the prose against these):\n\n${blocks.join('\n\n')}`;
}

