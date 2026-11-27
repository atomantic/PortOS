// Repairs the character, craft and worldbuilding dimensions of a series foundation.

import { assertValidSeriesId } from '../../lib/pipelineIds.js';
import { runStagedLLM } from '../stageRunner.js';
import { sanitizeStyleGuide, STYLE_GUIDE_LIMITS } from '../../lib/styleGuide.js';
import { sanitizeCharacterArcList } from '../../lib/seriesCharacterArc.js';
import { BIBLE_SOURCE, normalizeBibleName, sanitizeCharacter } from '../../lib/storyBible.js';
import { getUniverse, updateUniverse } from '../universeBuilder.js';
import { isBlankString, isBlankArray } from '../universeCharacterExpand.js';
import { expandWorldTemplate, narrativeRepairTargets } from '../universeBuilderExpand.js';
import { getSeries, updateSeries } from './series.js';
import {
  FRAMEWORK_STRING_FIELDS,
  PROFILE_STRING_FIELDS,
  VISUAL_FOUNDATION_LIST_FIELDS,
  VISUAL_FOUNDATION_STRING_FIELDS,
  pickFrameworkFields,
  pickVisualFoundationFields,
  renderArc,
  repairableSeriesFoundationCharacters,
  seriesFoundationCharacters,
} from './foundationJudgeContext.js';
import { repairOversizedCharacter } from './foundationCharacterOverflow.js';
import { escapeRegExp, isNonBlankStr } from '../../lib/textUtils.js';

const REPAIR_STAGE = 'pipeline-foundation-repair';
const CHARACTER_FOUNDATION_STAGE = 'pipeline-character-foundation';

const REPAIRABLE_CHARACTER_FIELDS = Object.freeze([
  ...FRAMEWORK_STRING_FIELDS,
  ...PROFILE_STRING_FIELDS,
  ...VISUAL_FOUNDATION_STRING_FIELDS,
  ...VISUAL_FOUNDATION_LIST_FIELDS,
  'arcType',
  'secrets',
  // Optional structured psychology (#6414). Allowlisted so a repair proposal
  // that authors one is applied rather than silently dropped; it is NOT part
  // of `hasCompleteFramework` below, so its absence never by itself makes an
  // existing cast read as incomplete and schedule a repair run.
  'psychology',
  'personality',
  'background',
  'relationships',
  'postureNotes',
  'specialTraits',
  'stats',
  'props',
  'expressions',
  'handGestures',
  'wardrobes',
]);

const MAX_FOUNDATION_NEW_CHARACTERS = 3;
// Exhaustive, not restrictive: large casts are split across as many sequential
// calls as necessary so every story-referenced character gets authored without
// asking one response to carry an unbounded amount of JSON. Each batch sees the
// full ensemble map for differentiation and relationship continuity.
export const CHARACTER_FOUNDATION_BATCH_SIZE = 6;

// How much of the synopsis-level plan a repair prompt may carry. The judge
// prompt this mirrors has always been budgeted (`buildFoundationContext` caps
// each section at a third of the model's usable input); repair alone sent the
// whole plan raw, so its prompt grew with every episode the series gained. On a
// long-running series that section reached 28KB of a 35KB prompt and BOTH the
// primary and the fallback TUI provider burned their full 10-minute timeout on
// it without emitting a response — which errored the entire autonomous run.
// ~12K chars (~3K tokens) keeps the arc spine plus the early episodes a
// character arc's transitions hang off, and still fits alongside the rest of the
// prompt inside a small local model's window. A fixed cap rather than a
// window-derived one on purpose: the binding constraint here is how much
// material a reasoning model will chew through before the wall clock runs out,
// not how much its context can hold.
export const REPAIR_OUTLINE_MAX_CHARS = 12_000;

// The outline cap above only ever bound ONE of the repair prompt's three large
// sections. A real character-foundation run built a 72KB prompt — 35KB of raw
// series seed, 18KB of outline, 15KB of candidate cast — and burned a CLI
// runner's full wall clock without emitting a byte. Each section now carries its
// own budget so the total lands near 40K chars, which the stage demonstrably
// completes within. Same reasoning as the outline cap: fixed rather than
// window-derived, because the binding constraint is how much material a
// reasoning model chews through before the clock runs out, not context size.
export const REPAIR_SERIES_MAX_CHARS = 12_000;
export const REPAIR_CHARACTERS_MAX_CHARS = 12_000;

// The character-foundation stage reasons over the whole ensemble at once, so it
// is the slowest repair stage by a wide margin. Ten minutes proved short enough
// to kill productive high-effort work, and a fixed two-hour ceiling still cuts
// off a healthy provider solely because the ensemble is large. Match the
// quality-first ceiling used by the pipeline's other long-form editorial calls;
// provider cancellation remains available for a truly hung run.
export const CHARACTER_FOUNDATION_TIMEOUT_MS = 43_200_000;

const CRAFT_REPAIR_MAX_ATTEMPTS = 2;

// A repair prompt's JSON sections shed the least load-bearing material first,
// then trim the free-text fields that remain, so the payload stays VALID JSON at
// every tier — a mid-object slice would hand the model a parse error instead of
// a smaller brief. That is the one way these differ from `renderArc`, which is
// plain text and hard-clamps: below the JSON skeleton's own size (a few hundred
// chars of keys and notes) these renderers overshoot the budget rather than
// emitting something unparseable. The real budgets are 12,000.
const JSON_TRUNCATION_MARK = '… [truncated to fit the prompt budget]';
function fitJsonToBudget(payload, trimKeys, maxChars) {
  const shrunk = { ...payload };
  let rendered = JSON.stringify(shrunk, null, 2);
  while (rendered.length > maxChars) {
    const key = trimKeys
      .filter((candidate) => typeof shrunk[candidate] === 'string' && shrunk[candidate].length > 0)
      .sort((a, b) => shrunk[b].length - shrunk[a].length)[0];
    // Nothing left that is safe to trim (structural ids/counts only) — return the
    // smallest valid JSON we can build rather than corrupting it with a slice.
    if (!key) return rendered;
    const keep = Math.max(0, shrunk[key].length - Math.max(rendered.length - maxChars, 1) - JSON_TRUNCATION_MARK.length);
    shrunk[key] = keep > 0 ? `${shrunk[key].slice(0, keep)}${JSON_TRUNCATION_MARK}` : '';
    rendered = JSON.stringify(shrunk, null, 2);
  }
  return rendered;
}

// Drop the style guide's exemplars first — they are craft-dimension material and
// tell a character or world repair nothing — then flatten the authored character
// arcs to their want/need spine, which the outline section already renders in
// full. `premise` / `targetFormat` / `issueCountTarget` / `styleNotes` are the
// brief itself and stay unconditional.
export function renderRepairSeriesJson(series, maxChars = REPAIR_SERIES_MAX_CHARS) {
  const base = {
    id: series?.id,
    name: series?.name,
    premise: series?.premise,
    targetFormat: series?.targetFormat,
    issueCountTarget: series?.issueCountTarget,
    styleNotes: series?.styleNotes,
  };
  const arcs = Array.isArray(series?.characterArcs) ? series.characterArcs : [];
  const trimKeys = ['styleNotes', 'premise'];
  const tiers = [
    { ...base, styleGuide: series?.styleGuide, characterArcs: series?.characterArcs },
    {
      ...base,
      characterArcs: series?.characterArcs,
      omitted: 'styleGuide (craft exemplars) omitted to fit the prompt budget',
    },
    {
      ...base,
      characterArcs: arcs.map((arc) => ({
        characterId: arc?.characterId,
        characterName: arc?.characterName,
        want: arc?.want,
        need: arc?.need,
      })),
      omitted: 'styleGuide and character-arc detail omitted to fit the prompt budget; see the outline section',
    },
    // The arcs are named in full in the outline section, so the last structural
    // tier keeps only their count — after this only the brief's own free text is
    // left, which `fitJsonToBudget` can trim.
    {
      ...base,
      characterArcCount: arcs.length,
      omitted: 'styleGuide and every character arc omitted to fit the prompt budget; see the outline section',
    },
  ];
  for (const tier of tiers) {
    const rendered = JSON.stringify(tier, null, 2);
    if (rendered.length <= maxChars) return rendered;
  }
  return fitJsonToBudget(tiers.at(-1), trimKeys, maxChars);
}

// The full-ensemble roster is the unbounded half of the character payload:
// `CHARACTER_FOUNDATION_BATCH_SIZE` bounds `targetCharacters`, but
// `fullSeriesRoster` carries every cast member with every framework field, so it
// grows with the series. Compact the roster to the narrative and visual
// differentiation spine before dropping members — the roster exists so the
// batch can differentiate relationships, motives, and render identities.
const compactRosterCharacter = (character) => ({
  id: character?.id,
  name: character?.name,
  role: character?.role,
  want: character?.want || '',
  need: character?.need || '',
  physicalDescription: character?.physicalDescription || '',
  visualIdentity: character?.visualIdentity || '',
});

// `CHARACTER_FOUNDATION_BATCH_SIZE` bounds how MANY characters a batch carries,
// not how large each one is — six characters with long personality/background/
// relationship prose still run to tens of KB. So the last tier caps every string
// field on the batch itself, halving the cap until the payload fits.
// An explicit ladder rather than a halving loop: a loop guarded on `>= floor`
// steps 1_200 → … → 75 → 37 and exits WITHOUT ever trying the floor itself.
const CHARACTER_FIELD_CAPS = Object.freeze([1_200, 600, 300, 150, 75, 40]);
const truncateField = (value, cap) => {
  if (typeof value !== 'string' || value.length <= cap) return value;
  // Below the marker's own length the marker would be the longer string — slice
  // bare rather than "truncating" a field into a longer one.
  if (cap <= JSON_TRUNCATION_MARK.length) return value.slice(0, Math.max(0, cap));
  return `${value.slice(0, cap - JSON_TRUNCATION_MARK.length)}${JSON_TRUNCATION_MARK}`;
};
// Recursive so a nested shape (an array of objects, an object-valued field)
// cannot smuggle uncapped prose past the budget.
const capValue = (value, cap) => {
  if (Array.isArray(value)) return value.map((entry) => capValue(entry, cap));
  if (value && typeof value === 'object') return capCharacterFields(value, cap);
  return truncateField(value, cap);
};
function capCharacterFields(character, cap) {
  return Object.fromEntries(Object.entries(character || {}).map(([key, value]) => [key, capValue(value, cap)]));
}

export function renderRepairCharactersJson(payload, maxChars = REPAIR_CHARACTERS_MAX_CHARS) {
  const render = (value) => JSON.stringify(value, null, 2);
  const full = render(payload);
  if (full.length <= maxChars) return full;

  // The flat array shape (non-character dimensions) is ALL batch — there is no
  // roster to shed — so it trims field text rather than dropping fields, and only
  // falls back to the compact spine when even the tightest cap does not fit.
  if (Array.isArray(payload)) {
    let rendered = full;
    for (const cap of CHARACTER_FIELD_CAPS) {
      rendered = render(payload.map((character) => capCharacterFields(character, cap)));
      if (rendered.length <= maxChars) return rendered;
    }
    // Floor: the compact spine at the tightest cap, shedding trailing members
    // until it fits. The budget is a hard contract, so a cast large enough to
    // overrun even that loses members rather than the bound.
    const spine = payload.map((character) => capCharacterFields(compactRosterCharacter(character), CHARACTER_FIELD_CAPS.at(-1)));
    let kept = spine.length;
    rendered = render(spine);
    while (kept > 0 && rendered.length > maxChars) {
      kept -= 1;
      rendered = render(spine.slice(0, kept));
    }
    return rendered;
  }

  const targets = Array.isArray(payload?.targetCharacters) ? payload.targetCharacters : [];
  const roster = Array.isArray(payload?.fullSeriesRoster) ? payload.fullSeriesRoster : [];
  const compactRoster = roster.map(compactRosterCharacter);
  const rosterNote = (kept) => (kept === compactRoster.length
    ? 'Roster compacted to narrative and visual identity axes to fit the prompt budget.'
    : `Roster compacted and limited to ${kept} of ${compactRoster.length} members to fit the prompt budget.`);
  const buildTargets = (cap, spine) => {
    const shaped = spine ? targets.map(compactRosterCharacter) : targets;
    return cap ? shaped.map((character) => capCharacterFields(character, cap)) : shaped;
  };
  const targetNote = (cap, spine) => {
    if (spine) return `Batch compacted to narrative and visual identity axes and truncated at ${cap} characters to fit the prompt budget.`;
    return cap ? `Character fields over ${cap} characters were truncated to fit the prompt budget.` : undefined;
  };
  const build = (kept, cap, spine = false) => render({
    targetCharacters: buildTargets(cap, spine),
    fullSeriesRoster: compactRoster.slice(0, kept),
    rosterNote: rosterNote(kept),
    ...(targetNote(cap, spine) ? { targetNote: targetNote(cap, spine) } : {}),
  });

  // At a given field cap, keep as many roster members as fit. The batch under
  // repair outranks the roster, so the cap only tightens once even an empty
  // roster cannot make room.
  const bestFit = (cap, spine = false) => {
    let kept = compactRoster.length;
    let rendered = build(kept, cap, spine);
    while (kept > 0 && rendered.length > maxChars) {
      kept -= 1;
      rendered = build(kept, cap, spine);
    }
    return rendered;
  };

  let rendered = bestFit(null);
  for (const cap of CHARACTER_FIELD_CAPS) {
    if (rendered.length <= maxChars) return rendered;
    rendered = bestFit(cap);
  }
  // Floor: compact the batch itself to the spine. Lossy for the characters under
  // repair, which is why it is last, but the budget is a hard contract.
  if (rendered.length > maxChars) rendered = bestFit(CHARACTER_FIELD_CAPS.at(-1), true);
  return rendered;
}

function craftRepairViolations(proposal) {
  const guide = proposal?.styleGuide;
  if (!guide || typeof guide !== 'object') return ['styleGuide is missing'];
  const violations = [];
  const validateEntries = (key, { min, max }) => {
    const entries = guide[key];
    if (!Array.isArray(entries)) {
      violations.push(`${key} must be an array`);
      return;
    }
    if (entries.length < min || entries.length > max) {
      violations.push(`${key} must contain ${min}-${max} entries`);
    }
    for (const [index, entry] of entries.entries()) {
      const passage = typeof entry?.passage === 'string' ? entry.passage.trim() : '';
      const note = typeof entry?.note === 'string' ? entry.note.trim() : '';
      if (!passage) violations.push(`${key}[${index}].passage is required`);
      else if (passage.length > STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX) {
        violations.push(`${key}[${index}].passage exceeds ${STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX} characters`);
      }
      if (!note) violations.push(`${key}[${index}].note is required`);
      else if (note.length > STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX) {
        violations.push(`${key}[${index}].note exceeds ${STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX} characters`);
      }
    }
  };
  validateEntries('voiceExemplars', { min: 1, max: 2 });
  validateEntries('voiceAntiExemplars', { min: 1, max: STYLE_GUIDE_LIMITS.EXEMPLARS_MAX });
  return violations;
}

const renderPromptCharacter = (character) => ({
  id: character.id,
  name: character.name,
  role: character.role,
  ...Object.fromEntries(PROFILE_STRING_FIELDS.map((field) => [field, character[field] || ''])),
  ...pickFrameworkFields(character),
  ...pickVisualFoundationFields(character),
  postureNotes: character.postureNotes || '',
  specialTraits: character.specialTraits || '',
  stats: Array.isArray(character.stats) ? character.stats : [],
  props: Array.isArray(character.props) ? character.props : [],
  expressions: Array.isArray(character.expressions) ? character.expressions : [],
  handGestures: Array.isArray(character.handGestures) ? character.handGestures : [],
  wardrobes: Array.isArray(character.wardrobes) ? character.wardrobes : [],
});

async function runFoundationRepair(series, issues, dimension, finding, characters, options) {
  const stage = dimension === 'character' ? CHARACTER_FOUNDATION_STAGE : REPAIR_STAGE;
  const charactersPayload = dimension === 'character'
    ? {
      targetCharacters: characters.map(renderPromptCharacter),
      fullSeriesRoster: (options.ensembleCharacters || characters).map(renderPromptCharacter),
    }
    : characters.map(renderPromptCharacter);
  let violations = [];
  const maxAttempts = dimension === 'craft' ? CRAFT_REPAIR_MAX_ATTEMPTS : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const findingPayload = { gap: finding?.gap || '', fix: finding?.fix || '' };
    // The gate may already have reverted an attempt at this dimension — say so,
    // so the next proposal changes strategy instead of re-earning the same
    // rollback. Craft's storage-contract retry below appends to this.
    if (finding?.retryReason) findingPayload.retryReason = finding.retryReason;
    if (dimension === 'craft') {
      findingPayload.hardStorageContract = {
        voiceExemplars: '1-2 entries',
        voiceAntiExemplars: `1-${STYLE_GUIDE_LIMITS.EXEMPLARS_MAX} entries`,
        passageMaxChars: STYLE_GUIDE_LIMITS.EXEMPLAR_PASSAGE_MAX,
        noteMaxChars: STYLE_GUIDE_LIMITS.EXEMPLAR_NOTE_MAX,
        requirement: 'Every passage and note must end as complete prose within these limits; storage never preserves overflow.',
      };
      if (violations.length > 0) {
        findingPayload.retryReason = [
          findingPayload.retryReason,
          `The previous proposal violated the hard storage contract: ${violations.join('; ')}. Rewrite it shorter; do not merely cut it off.`,
        ].filter(Boolean).join(' ');
      }
    }
    const result = await runStagedLLM(stage, {
      dimension,
      phase: options.phase || (dimension === 'character' ? 'post-arc reconciliation' : 'foundation repair'),
      foundationFindingJson: JSON.stringify(findingPayload, null, 2),
      seriesJson: renderRepairSeriesJson(series),
      outline: renderArc(series, issues, { maxChars: REPAIR_OUTLINE_MAX_CHARS }),
      charactersJson: renderRepairCharactersJson(charactersPayload),
    }, {
      returnsJson: true,
      providerDefault: options.providerId,
      modelDefault: options.model,
      effortDefault: options.effort,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      source: stage,
      ...(stage === CHARACTER_FOUNDATION_STAGE ? { timeoutOverride: CHARACTER_FOUNDATION_TIMEOUT_MS } : {}),
    });
    const proposal = result?.content && typeof result.content === 'object' ? result.content : {};
    if (dimension !== 'craft') return proposal;
    violations = craftRepairViolations(proposal);
    if (violations.length === 0) return proposal;
  }
  throw new Error(`foundation craft repair failed its storage contract after ${CRAFT_REPAIR_MAX_ATTEMPTS} attempts: ${violations.join('; ')}`);
}

export async function repairCharacters(series, issues, universe, finding, options) {
  const seriesRoster = seriesFoundationCharacters(universe?.characters, series, issues);
  const repairable = seriesRoster.filter((character) => character?.locked !== true);
  const directive = normalizeBibleName(`${finding?.gap || ''} ${finding?.fix || ''}`);
  const namedCast = seriesRoster.filter((character) => [character.name, ...(Array.isArray(character.aliases) ? character.aliases : [])]
    .some((name) => typeof name === 'string' && name.trim()
      && new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(normalizeBibleName(name))}(?![\\p{L}\\p{N}_])`, 'u').test(directive)));
  // A named post-arc finding owns that character's repair. Starting a new
  // foundation or reconciling an ensemble-wide finding still covers the cast.
  const namedRepair = options.phase !== 'pre-arc character foundation' && namedCast.length > 0;
  const targets = namedRepair
    ? namedCast.filter((character) => character.locked !== true)
    : repairable;
  if (namedRepair && targets.length === 0) return { applied: false, reason: 'the named character repair targets are locked' };
  const targetBatches = targets.length > 0
    ? Array.from({ length: Math.ceil(targets.length / CHARACTER_FOUNDATION_BATCH_SIZE) }, (_, index) => (
      targets.slice(index * CHARACTER_FOUNDATION_BATCH_SIZE, (index + 1) * CHARACTER_FOUNDATION_BATCH_SIZE)
    ))
    : [[]];
  const proposals = [];
  const overflowOriginals = new Map();
  let workingRoster = [...seriesRoster];
  const workingNewCharacters = [];
  while (targetBatches.length > 0) {
    const originalBatch = targetBatches.shift();
    const batchIds = new Set(originalBatch.map((character) => character.id));
    const targetBatch = workingRoster.filter((character) => batchIds.has(character.id));
    const ensembleCharacters = [...workingRoster, ...workingNewCharacters];
    const preview = JSON.parse(renderRepairCharactersJson({
      targetCharacters: targetBatch.map(renderPromptCharacter),
      fullSeriesRoster: ensembleCharacters.map(renderPromptCharacter),
    }));
    if (preview.targetNote) {
      // Shrink the batch before shrinking the records it is allowed to edit.
      // A 40-character field cap erased whole designs in a real repair prompt.
      if (originalBatch.length > 1) {
        const midpoint = Math.ceil(originalBatch.length / 2);
        targetBatches.unshift(originalBatch.slice(0, midpoint), originalBatch.slice(midpoint));
        continue;
      }
    }
    const overflow = Boolean(preview.targetNote);
    const proposal = overflow
      ? await repairOversizedCharacter(targetBatch[0], {
        finding,
        phase: options.phase || 'post-arc reconciliation',
        seriesJson: renderRepairSeriesJson(series),
        outline: renderArc(series, issues, { maxChars: REPAIR_OUTLINE_MAX_CHARS }),
        rosterJson: renderRepairCharactersJson(ensembleCharacters.map(compactRosterCharacter), 2_000),
      }, REPAIRABLE_CHARACTER_FIELDS, { ...options, timeoutOverride: CHARACTER_FOUNDATION_TIMEOUT_MS })
      : await runFoundationRepair(series, issues, 'character', finding, targetBatch, {
        ...options,
        // Locked cast members constrain relationships and voices. Later batches
        // also see accepted proposals so they do not invent duplicate identities.
        ensembleCharacters,
      });
    if (overflow) overflowOriginals.set(targetBatch[0].id, targetBatch[0]);
    const boundedProposal = {
      ...proposal,
      characters: (Array.isArray(proposal.characters) ? proposal.characters : [])
        .filter((character) => batchIds.has(character?.id)),
    };
    proposals.push(boundedProposal);

    const proposedById = new Map(boundedProposal.characters
      .filter((character) => typeof character?.id === 'string')
      .map((character) => [character.id, character]));
    workingRoster = workingRoster.map((character) => {
      const raw = proposedById.get(character.id);
      if (!raw) return character;
      if (overflowOriginals.has(character.id)) return { ...character, ...raw };
      return sanitizeCharacter({ ...character, ...raw, id: character.id, name: character.name }) || character;
    });
    const knownNames = new Set([...workingRoster, ...workingNewCharacters]
      .map((character) => String(character?.name || '').trim().toLowerCase())
      .filter(Boolean));
    for (const raw of Array.isArray(proposal.newCharacters) ? proposal.newCharacters : []) {
      if (workingNewCharacters.length >= MAX_FOUNDATION_NEW_CHARACTERS) break;
      const nameKey = String(raw?.name || '').trim().toLowerCase();
      if (!nameKey || knownNames.has(nameKey)) continue;
      workingNewCharacters.push(raw);
      knownNames.add(nameKey);
    }
  }
  const proposedCharacters = proposals.flatMap((proposal) => (
    Array.isArray(proposal.characters) ? proposal.characters : []
  ));
  const proposalById = new Map(proposedCharacters
    .filter((character) => typeof character?.id === 'string')
    .map((character) => [character.id, character]));
  const targetIds = new Set(targets.map((character) => character.id));
  const updatedFields = new Set();
  let charactersApplied = false;
  const addedCharacters = [];
  await updateUniverse(universe.id, (latest) => {
    const latestCharacters = Array.isArray(latest?.characters) ? latest.characters : [];
    for (const [id, original] of overflowOriginals) {
      if (JSON.stringify(latestCharacters.find((character) => character.id === id)) !== JSON.stringify(original)) {
        throw new Error('Character foundation overflow repair source changed during validation; no edits applied.');
      }
    }
    let changed = false;
    const characters = latestCharacters.map((character) => {
      if (!targetIds.has(character.id) || character.locked === true) return character;
      const raw = proposalById.get(character.id);
      if (!raw) return character;
      const sanitized = sanitizeCharacter({ ...character, ...raw, id: character.id, name: character.name });
      if (!sanitized) return character;
      const next = { ...character };
      for (const field of REPAIRABLE_CHARACTER_FIELDS) {
        // Overflow validation covers only the explicit patch. Never rewrite
        // untouched supporting detail through the sanitizer.
        if (overflowOriginals.has(character.id) && !Object.hasOwn(raw, field)) continue;
        const value = sanitized[field];
        // Object-valued fields (`psychology`) are authored when the sanitizer
        // returned one at all — it collapses an empty proposal to null/absent.
        const authored = Array.isArray(value)
          ? value.length > 0
          : (value && typeof value === 'object')
            ? Object.keys(value).length > 0
            : !isBlankString(value);
        if (!authored || JSON.stringify(value) === JSON.stringify(character[field])) continue;
        next[field] = value;
        updatedFields.add(field);
        changed = true;
      }
      return next;
    });
    const knownNames = new Set(characters
      .map((character) => String(character?.name || '').trim().toLowerCase())
      .filter(Boolean));
    const proposedNewCharacters = proposals
      .flatMap((proposal) => (Array.isArray(proposal.newCharacters) ? proposal.newCharacters : []))
      .slice(0, MAX_FOUNDATION_NEW_CHARACTERS);
    for (const raw of proposedNewCharacters) {
      const nameKey = String(raw?.name || '').trim().toLowerCase();
      if (!nameKey || knownNames.has(nameKey)) continue;
      const sanitized = sanitizeCharacter({
        ...raw,
        id: undefined,
        locked: false,
        source: BIBLE_SOURCE.SERIES_EXTRACT,
        sourceSeriesId: series.id,
      }, { preserveTimestamps: false });
      if (!sanitized) continue;
      characters.push(sanitized);
      addedCharacters.push(sanitized);
      knownNames.add(nameKey);
      changed = true;
    }
    if (!changed) return null;
    charactersApplied = true;
    return { characters };
  });

  const characterIdByName = new Map([
    ...(Array.isArray(universe?.characters) ? universe.characters : []),
    ...addedCharacters,
  ].map((character) => [String(character?.name || '').trim().toLowerCase(), character?.id]));
  const proposedArcs = sanitizeCharacterArcList(proposals
    .flatMap((proposal) => (Array.isArray(proposal.characterArcs) ? proposal.characterArcs : []))
    .map((arc) => ({
      ...arc,
      characterId: characterIdByName.get(String(arc?.characterName || '').trim().toLowerCase()) || arc?.characterId,
    })))
    .filter((arc) => !namedRepair || targetIds.has(arc.characterId)
      || addedCharacters.some((character) => character.id === arc.characterId));
  let arcsApplied = false;
  if (proposedArcs.length > 0) {
    const latestSeries = await getSeries(series.id);
    const existingArcByKey = new Map((latestSeries.characterArcs || []).flatMap((arc) => [
      arc?.characterId ? [arc.characterId, arc] : null,
      arc?.characterName ? [`name:${arc.characterName.trim().toLowerCase()}`, arc] : null,
    ].filter(Boolean)));
    // Character repairs after the macro arc may deepen motivation, arc type,
    // and start/end states, but transition beats are plot events. Letting this
    // editor add or move them silently creates an arc-ledger event that no
    // episode synopsis stages; the next judge then (correctly) penalizes the
    // structure for a contradiction the previous repair just invented. Keep
    // existing authored transitions unchanged in post-arc reconciliation and leave
    // missing scene placement to the structure owner (`resolveVerifyIssues`).
    const boundedProposedArcs = options.phase === 'post-arc reconciliation'
      ? proposedArcs.map((arc) => {
        const existing = existingArcByKey.get(arc.characterId)
          || existingArcByKey.get(`name:${String(arc.characterName || '').trim().toLowerCase()}`);
        return existing
          ? { ...arc, transitions: Array.isArray(existing.transitions) ? existing.transitions : [] }
          : arc;
      })
      : proposedArcs;
    // A legacy name-only arc and a newly canon-linked arc otherwise have
    // different sanitizer keys and survive as duplicates. Remove every prior
    // identity the proposal replaces, then rely on last-write-wins within the
    // proposal itself. This preserves untouched arcs while upgrading the
    // authored character to its stable canon id.
    const replacementKeys = new Set(boundedProposedArcs.flatMap((arc) => [
      arc.characterId || '',
      arc.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '',
    ]).filter(Boolean));
    const untouchedArcs = (latestSeries.characterArcs || []).filter((arc) => (
      !replacementKeys.has(arc?.characterId || '')
      && !replacementKeys.has(arc?.characterName ? `name:${arc.characterName.trim().toLowerCase()}` : '')
    ));
    const mergedArcs = sanitizeCharacterArcList([...untouchedArcs, ...boundedProposedArcs]);
    if (JSON.stringify(mergedArcs) !== JSON.stringify(latestSeries.characterArcs || [])) {
      await updateSeries(series.id, { characterArcs: mergedArcs });
      arcsApplied = true;
    }
  }

  const applied = charactersApplied || arcsApplied;
  return applied
    ? {
      applied: true,
      entryIds: targets.map((character) => character.id),
      updatedFields: [...updatedFields],
      charactersAdded: addedCharacters.length,
      characterArcsUpdated: arcsApplied,
    }
    : { applied: false, reason: 'repair model proposed no usable core-cast or character-arc changes' };
}

function hasCompleteFramework(character) {
  return FRAMEWORK_STRING_FIELDS.every((field) => !isBlankString(character?.[field]))
    && PROFILE_STRING_FIELDS.every((field) => !isBlankString(character?.[field]))
    && !isBlankArray(character?.secrets)
    && !isBlankString(character?.arcType)
    && VISUAL_FOUNDATION_STRING_FIELDS.every((field) => !isBlankString(character?.[field]))
    && VISUAL_FOUNDATION_LIST_FIELDS.every((field) => !isBlankArray(character?.[field]));
}

/**
 * Establish the character engine before the plot spine is generated. This is
 * intentionally distinct from the later whole-foundation judge: the early pass
 * gives the arc planner causal people to build events around, while the later
 * pass reconciles those people with story-specific discoveries.
 */
export async function establishCharacterFoundation(seriesId, {
  providerDefault,
  modelDefault,
  effortDefault,
  onRunCreated,
  onRunSettled,
} = {}) {
  assertValidSeriesId(seriesId);
  const series = await getSeries(seriesId);
  if (!series?.universeId) {
    return { applied: false, skipped: true, ran: false, reason: 'no linked universe' };
  }
  const universe = await getUniverse(series.universeId).catch(() => null);
  if (!universe) {
    return { applied: false, skipped: true, ran: false, reason: 'linked universe not found' };
  }
  const targets = repairableSeriesFoundationCharacters(universe.characters, series, []);
  const authoredArcs = Array.isArray(series.characterArcs) ? series.characterArcs : [];
  const arcKeys = new Set(authoredArcs.flatMap((arc) => [
    arc?.characterId || '',
    `name:${String(arc?.characterName || '').trim().toLowerCase()}`,
  ]).filter(Boolean));
  const needsRepair = targets.length === 0 || targets.some((character) => (
    !hasCompleteFramework(character)
    || (!arcKeys.has(character.id) && !arcKeys.has(`name:${String(character.name || '').trim().toLowerCase()}`))
  ));
  if (!needsRepair) {
    return { applied: false, skipped: true, ran: false, reason: 'core character foundation is already complete' };
  }
  const result = await repairCharacters(series, [], universe, {
    gap: 'The plot spine has not been generated yet, so the core cast must first have specific causal inner engines, relationship tensions, and stable render identities.',
    fix: 'Complete the core ensemble from the premise: Ghost to Wound to Lie to Want to Need, distinct voice and contradictions, active relationships, mutually distinct physical descriptions, silhouettes, visual identities and palettes, and a provisional whole-series change path. Add only a genuinely missing core role.',
  }, {
    providerId: providerDefault,
    model: modelDefault,
    effort: effortDefault,
    onRunCreated,
    onRunSettled,
    phase: 'pre-arc character foundation',
  });
  return { ...result, ran: true };
}

export async function repairCraft(series, issues, finding, options) {
  const proposal = await runFoundationRepair(series, issues, 'craft', finding, [], options);
  const latestSeries = await getSeries(series.id);
  const rawGuide = proposal.styleGuide && typeof proposal.styleGuide === 'object'
    ? proposal.styleGuide
    : null;
  const existingGuide = latestSeries.styleGuide || {};
  const mergedGuide = rawGuide
    ? sanitizeStyleGuide({
      ...existingGuide,
      ...rawGuide,
      conventions: rawGuide.conventions && typeof rawGuide.conventions === 'object'
        ? { ...(existingGuide.conventions || {}), ...rawGuide.conventions }
        : existingGuide.conventions,
      voiceExemplars: Array.isArray(rawGuide.voiceExemplars) && rawGuide.voiceExemplars.length > 0
        ? rawGuide.voiceExemplars
        : existingGuide.voiceExemplars,
      voiceAntiExemplars: Array.isArray(rawGuide.voiceAntiExemplars) && rawGuide.voiceAntiExemplars.length > 0
        ? rawGuide.voiceAntiExemplars
        : existingGuide.voiceAntiExemplars,
    })
    : latestSeries.styleGuide;
  const styleNotes = typeof proposal.styleNotes === 'string' && proposal.styleNotes.trim()
    ? proposal.styleNotes.trim()
    : latestSeries.styleNotes;
  const patch = {};
  if (styleNotes !== latestSeries.styleNotes) patch.styleNotes = styleNotes;
  if (JSON.stringify(mergedGuide) !== JSON.stringify(latestSeries.styleGuide)) patch.styleGuide = mergedGuide;
  if (Object.keys(patch).length === 0) {
    return { applied: false, reason: 'repair model proposed no usable series voice changes' };
  }
  await updateSeries(series.id, patch);
  return { applied: true, updatedFields: Object.keys(patch) };
}

// Refine the universe world bible (worldbuilding dimension) through the
// owning service: regenerate logline/premise/styleNotes/influences via
// expandWorldTemplate — which ECHOES locked entries unchanged (force:false /
// no-clobber) — then persist through updateUniverse (serialized write queue).
// Mirrors storyBuilder.js's `universeAesthetic` step. Returns false when there's
// no universe to refine.
export async function refineWorld(universeId, { providerId, model, effort, onRunCreated, onRunSettled, finding = {} }) {
  if (!universeId) return { applied: false, reason: 'no linked universe' };
  const universe = await getUniverse(universeId).catch(() => null);
  if (!universe) return { applied: false, reason: 'universe not found' };
  const expanded = await expandWorldTemplate({
    starterPrompt: universe.starterPrompt || universe.name,
    influences: universe.influences,
    logline: universe.logline,
    premise: universe.premise,
    styleNotes: universe.styleNotes,
    locked: universe.locked,
    foundationDirective: [
      [finding.gap, finding.fix].filter(Boolean).join('\nRequested repair: '),
      finding.retryReason ? `Previous attempt: ${finding.retryReason}` : '',
    ].filter(Boolean).join('\n'),
    providerId,
    model,
    effort,
    onRunCreated,
    onRunSettled,
    narrativeOnly: true,
  });
  // Persist through the write-queue mutator against the FRESHEST record, and
  // defensively DROP any field the user has locked — expandWorldTemplate is
  // meant to echo locked fields unchanged, but a bad LLM echo (or a lock set
  // DURING the LLM round-trip) must never overwrite human-locked canon. The
  // gate's whole contract is "locked entries are constraints, not fix targets."
  let wrote = false;
  await updateUniverse(universeId, (latest) => {
    const locked = latest?.locked || {};
    const patch = {};
    // Only write a scalar the LLM actually authored: expandWorldTemplate returns
    // null (or blank) for an OMITTED field, which is "nothing to add" — NOT a
    // clear. Writing it would erase the existing unlocked value (sanitize turns a
    // non-string into ''). Skip locked fields AND absent/blank ones; preserve the
    // current value in both cases (the AGENTS.md absent-vs-empty rule).
    if (locked.logline !== true && isNonBlankStr(expanded.logline)) patch.logline = expanded.logline;
    if (locked.premise !== true && isNonBlankStr(expanded.premise)) patch.premise = expanded.premise;
    if (locked.styleNotes !== true && isNonBlankStr(expanded.styleNotes)) patch.styleNotes = expanded.styleNotes;
    // `influences` is an { embrace, avoid } object and updateUniverse replaces it
    // WHOLESALE — but the lockable keys are the two SUBLISTS
    // (`influencesEmbrace`/`influencesAvoid`, see universeBuilder LOCKABLE_FIELDS),
    // not `influences`. A wholesale write would clobber a locked sublist, so only
    // write influences when NEITHER sublist is locked.
    const influencesLocked = locked.influencesEmbrace === true || locked.influencesAvoid === true;
    if (!influencesLocked && expanded.influences && typeof expanded.influences === 'object') patch.influences = expanded.influences;
    if (!Object.keys(patch).length) return null; // all locked or nothing authored → no-op
    wrote = true;
    return patch;
  });
  // `wrote === false` means every refinable field is locked — report it so the
  // gate pauses 'inapplicable' for human review instead of silently no-op-ing.
  if (!wrote) return { applied: false, reason: 'every refinable world field is locked' };
  // A repair that landed against a field already at its storage ceiling had to
  // consolidate existing prose to make room. Say so on the fix frame: when the
  // gate later pauses on non-convergence, "the premise is full" is the fact that
  // tells a human to prune the bible rather than re-run the same repair.
  const saturated = Object.entries(narrativeRepairTargets(universe))
    .filter(([, budget]) => budget.saturated)
    .map(([field]) => field);
  return saturated.length
    ? { applied: true, reason: `world bible ${saturated.join(' and ')} sat at the storage ceiling; the repair had to consolidate existing canon to fit` }
    : { applied: true };
}
