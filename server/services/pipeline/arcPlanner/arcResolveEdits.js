// Resolves verification findings and applies bounded arc, season and episode edits.

import { runStagedLLM } from '../../stageRunner.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { MANUSCRIPT_TYPES, getSeries, updateSeries } from '../series.js';
import { listIssues, updateIssue, updateStageWithLatest } from '../issues.js';
import {
  ARC_LIMITS,
  TICKING_CLOCK_LIMITS,
  buildSeason,
  sanitizeArc,
  sanitizeSeason,
  sanitizeSeasonList,
  sanitizeTickingClock,
} from '../../../lib/storyArc.js';
import { sanitizeCharacterArcList } from '../../../lib/seriesCharacterArc.js';
import {
  ERR_VALIDATION,
  buildResolveContext,
  findingIdSet,
  matchIssueForEpisodeEdit,
  matchResolvedFindings,
  resolveWorldContext,
  seasonIdByNumberOf,
  shapeEpisodeResolutions,
  shapeFindings,
} from './context.js';
import { verifyArc } from './arcGenerateVerify.js';
import { EPISODE_METADATA_FIELDS, episodeMetadataOf, ideaSnapshotOf, resolvedEpisodeEdits } from './arcSnapshots.js';
import { matchProposedSeasons, commitSeasonsWithRemap } from './arcSeasonRemap.js';

/**
 * Split one auto-resolve response into the edits that actually name a finding
 * the round was handed, and the ones to drop (#3724). Pure.
 *
 * Every entry in `arc` / `characterArcs[]` / `seasons[]` / `episodes[]` has to carry
 * `resolves: ["f2", …]` naming at least one input finding — an edit that names
 * none can't be closing anything, so applying it is all blast radius and no
 * benefit. Returns `{ legacy, arc, arcDropped, characterArcs,
 * characterArcsDropped, seasons, seasonsDropped, episodes, episodesDropped,
 * episodesOutOfScope }`.
 *
 * `spineOnly` drops every episode edit regardless of what it names (#3789): a
 * spine round is judged against an episode-empty plan, so an episode rewrite
 * cannot close the finding it declares — it only mutates records the gate never
 * read. Counted separately from `episodesDropped` because the two are different
 * diagnoses (wrong scope vs. named no finding), and enforced here rather than
 * trusting the prompt alone so a customized/stale installed template can't
 * re-open the blast radius.
 *
 * `legacy` is the escape hatch for an install whose `pipeline-arc-resolve.md`
 * was customized before #3724 and therefore never got the migration: when NOT
 * ONE entry in the whole response declares a `resolves` array, the model is
 * plainly running the old contract, and dropping everything would silently turn
 * auto-resolve into a no-op that burns a round per pass. Those responses are
 * applied unkeyed (still as a sparse patch, which is strictly safer than the
 * old full-list rewrite) and logged. A response that keys SOME of its edits is
 * on the new contract, so its unkeyed entries are genuine drops.
 */
export function selectFindingKeyedEdits(content, findings, { spineOnly = false } = {}) {
  const validIds = findingIdSet(findings);
  const isEdit = (e) => !!e && typeof e === 'object';
  const arcEdit = isEdit(content?.arc) ? content.arc : null;
  const characterArcsRaw = (Array.isArray(content?.characterArcs) ? content.characterArcs : []).filter(isEdit);
  const seasonsRaw = (Array.isArray(content?.seasons) ? content.seasons : []).filter(isEdit);
  const episodesRaw = (Array.isArray(content?.episodes) ? content.episodes : []).filter(isEdit);
  const legacy = ![arcEdit, ...characterArcsRaw, ...seasonsRaw, ...episodesRaw]
    .some((e) => e && matchResolvedFindings(e, validIds).declared);
  const targeted = (raw) => legacy || matchResolvedFindings(raw, validIds).matched.length > 0;
  const characterArcs = characterArcsRaw.filter(targeted);
  const seasons = seasonsRaw.filter(targeted);
  const episodes = spineOnly ? [] : episodesRaw.filter(targeted);
  return {
    legacy,
    arc: arcEdit && targeted(arcEdit) ? arcEdit : null,
    arcDropped: !!arcEdit && !targeted(arcEdit),
    characterArcs,
    characterArcsDropped: characterArcsRaw.length - characterArcs.length,
    seasons,
    seasonsDropped: seasonsRaw.length - seasons.length,
    episodes,
    episodesDropped: spineOnly ? 0 : episodesRaw.length - episodes.length,
    episodesOutOfScope: spineOnly ? episodesRaw.length : 0,
  };
}

const characterArcKey = (arc) => {
  const characterId = typeof arc?.characterId === 'string' ? arc.characterId.trim() : '';
  if (characterId) return `id:${characterId}`;
  const characterName = typeof arc?.characterName === 'string' ? arc.characterName.trim().toLowerCase() : '';
  return characterName ? `name:${characterName}` : '';
};

const CHARACTER_ARC_PATCH_FIELDS = Object.freeze([
  'want', 'need', 'startState', 'endState', 'status',
]);
const TRANSITION_PATCH_FIELDS = Object.freeze([
  'kind', 'label', 'atIssue', 'atSceneAnchor', 'note',
]);

/**
 * Apply finding-keyed per-character arc edits as sparse patches. Existing
 * character and transition identifiers are required and preserved: an arc
 * verifier finding must never mint a new cast arc or replace every transition
 * merely because the model corrected one milestone.
 */
export function mergeCharacterArcPatches(existingArcs, patches) {
  const current = sanitizeCharacterArcList(existingArcs);
  if (!Array.isArray(patches) || patches.length === 0) return current;
  const patchByKey = new Map(patches.map((patch) => [characterArcKey(patch), patch]).filter(([key]) => key));
  const merged = current.map((arc) => {
    const patch = patchByKey.get(characterArcKey(arc));
    if (!patch) return arc;
    const next = { ...arc };
    for (const field of CHARACTER_ARC_PATCH_FIELDS) {
      if (field in patch) next[field] = patch[field];
    }
    if (Array.isArray(patch.transitions)) {
      const transitionPatches = new Map(patch.transitions
        .filter((transition) => transition && typeof transition === 'object' && typeof transition.id === 'string')
        .map((transition) => [transition.id, transition]));
      next.transitions = arc.transitions.flatMap((transition) => {
        const transitionPatch = transitionPatches.get(transition.id);
        if (!transitionPatch) return [transition];
        if (transitionPatch.delete === true) return [];
        const updated = { ...transition };
        for (const field of TRANSITION_PATCH_FIELDS) {
          if (field in transitionPatch) updated[field] = transitionPatch[field];
        }
        return [updated];
      });
    }
    return next;
  });
  return sanitizeCharacterArcList(merged);
}

const EXACT_TEXT_PATCH_MODE = 'exact-text-v1';
const EXACT_TEXT_EDITS_MAX = 12;

/**
 * Apply bounded exact-match replacements to one persisted long-form field.
 *
 * Arc verification findings are usually sentence-local, but `synopsis` and
 * `summary` are monolithic strings. Asking the resolver to return either field
 * wholesale gave a one-sentence repair thousands of unrelated words of blast
 * radius, and an over-limit rewrite could then be truncated mid-sentence by the
 * canonical sanitizer. Exact replacements keep the untouched text byte-for-byte
 * stable. Ambiguous/missing anchors are skipped rather than guessed at. Check
 * capacity after all replacements: an early expansion may rely on a later
 * compression. If the final field exceeds its limit, preserve the original
 * field instead of persisting a partial version of the proposed change.
 */
export function applyExactTextEdits(current, rawEdits, maxLength) {
  const original = typeof current === 'string' ? current : '';
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { value: original, applied: 0, rejected: 0 };
  }
  let value = original;
  let applied = 0;
  let rejected = 0;
  for (const raw of rawEdits.slice(0, EXACT_TEXT_EDITS_MAX)) {
    const find = typeof raw?.find === 'string' ? raw.find : '';
    const replacement = typeof raw?.replace === 'string' ? raw.replace : null;
    const first = find ? value.indexOf(find) : -1;
    const duplicate = first >= 0 && value.indexOf(find, first + find.length) >= 0;
    const replacesWholeLongField = find.length === value.length
      && maxLength > ARC_LIMITS.SEASON_ENDING_HOOK_MAX;
    if (!find || replacement == null || first < 0 || duplicate || replacesWholeLongField) {
      rejected += 1;
      continue;
    }
    value = `${value.slice(0, first)}${replacement}${value.slice(first + find.length)}`;
    applied += 1;
  }
  rejected += Math.max(0, rawEdits.length - EXACT_TEXT_EDITS_MAX);
  if (value.length > maxLength) {
    return { value: original, applied: 0, rejected: rejected + applied };
  }
  return { value, applied, rejected };
}

// Two stored values are the same edit-wise. `undefined` and `null` are one
// value here: an omitted field and an explicit null both mean "no change I can
// count", and the appliers treat them identically.
const sameStored = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Countdown repairs follow the same sparse, existing-ID contract as character
// transitions. A finding cannot delete the clock or replace its reminder list.
const CLOCK_PATCH_FIELDS = ['label', 'stakes', 'plantedAtArcPosition', 'dueAtArcPosition'];
function mergeTickingClockPatch(current, patch) {
  if (!current || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { value: current, changes: 0 };
  }
  const next = { ...current };
  for (const [field, max] of [['label', TICKING_CLOCK_LIMITS.LABEL_MAX], ['stakes', TICKING_CLOCK_LIMITS.STAKES_MAX]]) {
    if (typeof patch[field] === 'string' && patch[field].length <= max) next[field] = patch[field];
  }
  for (const field of ['plantedAtArcPosition', 'dueAtArcPosition']) {
    if (patch[field] === null || Number.isFinite(patch[field])) next[field] = patch[field];
  }
  const byId = new Map((Array.isArray(patch.reminders) ? patch.reminders : [])
    .filter((r) => r && typeof r.id === 'string').map((r) => [r.id, r]));
  next.reminders = (current.reminders || []).map((reminder) => {
    const edit = byId.get(reminder.id);
    if (!edit) return reminder;
    const updated = { ...reminder };
    if (edit.atIssue === null || Number.isFinite(edit.atIssue)) updated.atIssue = edit.atIssue;
    if (typeof edit.note === 'string' && edit.note.length <= TICKING_CLOCK_LIMITS.REMINDER_NOTE_MAX) updated.note = edit.note;
    // Clearing both fields would make the canonical sanitizer delete the row.
    return updated.atIssue == null && !updated.note.trim() ? reminder : updated;
  });
  const value = sanitizeTickingClock(next) || current;
  const changes = CLOCK_PATCH_FIELDS.filter((field) => !sameStored(value[field], current[field])).length
    + value.reminders.filter((reminder, index) => !sameStored(reminder, current.reminders[index])).length;
  return { value, changes };
}

// The fields a resolve response can change on the arc / on a volume — the same
// surface the two appliers below spread (`sanitizeArc` at the arc, the season
// patch inside `resolveVerifyIssues`), restated here because those do per-field
// coercion rather than list iteration. THEY MOVE TOGETHER: a newly patchable
// field the appliers accept but this list omits is a change the isolated bound
// cannot see. Long prose is paired `[direct, editsKey, limit]` because under
// `exact-text-v1` it lands ONLY through the `*Edits` array and a
// directly-returned string is ignored (and vice versa) — counting the ignored
// spelling would reject a candidate over an edit that was never going to be
// persisted.
const ARC_SHORT_FIELDS = Object.freeze(['logline', 'themes', 'shape', 'foreshadowing']);
const ARC_LONG_FIELDS = Object.freeze([
  ['summary', 'summaryEdits', ARC_LIMITS.SUMMARY_MAX],
  ['protagonistArc', 'protagonistArcEdits', ARC_LIMITS.PROTAGONIST_ARC_MAX],
]);
const SEASON_SHORT_FIELDS = Object.freeze(['title', 'number', 'logline', 'episodeCountTarget', 'themes']);
const SEASON_LONG_FIELDS = Object.freeze([
  ['synopsis', 'synopsisEdits', ARC_LIMITS.SEASON_SYNOPSIS_MAX],
  ['endingHook', 'endingHookEdits', ARC_LIMITS.SEASON_ENDING_HOOK_MAX],
]);

// ---------------------------------------------------------------------------
// Resolve-outcome accounting (#3843). `applied` says a pass wrote SOMETHING; it
// never said what, and the gate's telemetry reported only `episodesEdited` — a
// count the arc-SPINE resolver can never move, because that altitude may not
// touch episodes at all. A spine round that rewrote the arc and two volumes and
// took the blocking set from 5 to 2 therefore reported `episodesEdited: 0`,
// indistinguishable from a round that wrote nothing. These supply the missing
// halves: per-record counts of what landed, and a categorical reason when
// nothing did. Numbers and enum values only — it rides into the retained
// diagnosis log, which must never carry manuscript text or resolver prose.
// ---------------------------------------------------------------------------

// The arc surface a resolve pass can rewrite — derived from the two lists the
// isolated-candidate bound already keeps in step with the appliers, so a newly
// patchable field is counted the moment it is accepted rather than after
// someone remembers a third list. Countdown patches have their own sparse
// applier; readerMap and status are not resolver-authored fields.
const RESOLVE_ARC_FIELDS = Object.freeze([...ARC_SHORT_FIELDS, ...ARC_LONG_FIELDS.map(([direct]) => direct), 'tickingClock']);

const changedFieldCount = (next, prev, fields) => fields
  .filter((field) => !sameStored(next?.[field], prev?.[field])).length;

// Entries in `next` that match no entry in `prev` — i.e. minted or rewritten.
// Deletion is not reachable on either list this counts (volumes ride through as
// a sparse patch, character arcs merge in place), so added/changed is a complete
// account of the pass's writes.
const changedEntryCount = (next, prev) => {
  const before = new Set((prev || []).map((entry) => JSON.stringify(entry)));
  return (next || []).filter((entry) => !before.has(JSON.stringify(entry))).length;
};

const NO_MUTATIONS = Object.freeze({
  arcFieldsEdited: 0, volumesEdited: 0, characterArcsEdited: 0, episodesEdited: 0,
});

/**
 * Why a resolve pass wrote nothing, as ONE of these values. Categorical so the
 * stall diagnosis can separate the cases it kept conflating: the resolver
 * answered but its anchors no longer matched (`exact-edits-rejected`), it
 * answered at an altitude this gate forbids (`edits-out-of-scope`), or it
 * declined to propose anything at all (`no-edits-returned`) — a content-level
 * refusal no amount of extra rounds will fix. Exported because the diagnosis
 * prompts have to explain every value they can be handed; the contract test in
 * `arcPlanner.test.js` fails when a value is missing from that legend.
 */
export const RESOLVE_NO_CHANGE_REASONS = Object.freeze([
  'no-findings',
  'isolated-candidate-rejected',
  'exact-edits-rejected',
  'edits-matched-existing',
  'edits-out-of-scope',
  'edits-named-no-finding',
  'no-edits-returned',
]);

const noChangeReasonFor = (edits, rejectedExactEdits) => {
  if (rejectedExactEdits > 0) return 'exact-edits-rejected';
  const proposed = (edits.arc ? 1 : 0) + edits.characterArcs.length + edits.seasons.length + edits.episodes.length;
  // Something survived selection and was applied, yet the store did not move:
  // the resolver re-authored text the plan already held.
  if (proposed > 0) return 'edits-matched-existing';
  if (edits.episodesOutOfScope > 0) return 'edits-out-of-scope';
  const dropped = (edits.arcDropped ? 1 : 0) + edits.characterArcsDropped + edits.seasonsDropped + edits.episodesDropped;
  if (dropped > 0) return 'edits-named-no-finding';
  return 'no-edits-returned';
};

// How many stored values a patch would actually change. Echoed fields that
// already match the record do not count: the resolve prompt asks for `id` and
// `number` to be repeated, so "field present" is not "field changed". Exact-text
// replacements are counted by running the real applier — one `{find, replace}`
// pair is one causal change, and an anchor `applyExactTextEdits` would reject
// (missing, ambiguous, over-limit) is none, so the count is the patch's
// persisted effect rather than the size of what the model asked for.
function countFieldChanges(patch, current, { shortFields, longFields = [], exactTextMode = false }) {
  let changes = 0;
  for (const field of shortFields) {
    if (patch?.[field] === undefined) continue;
    if (!sameStored(patch[field], current?.[field])) changes += 1;
  }
  for (const [direct, editsKey, limit] of longFields) {
    if (exactTextMode) {
      changes += applyExactTextEdits(current?.[direct] || '', patch?.[editsKey], limit).applied;
    } else if (typeof patch?.[direct] === 'string' && !sameStored(patch[direct], current?.[direct] ?? '')) {
      changes += 1;
    }
  }
  return changes;
}

// Same accounting one altitude down, for a per-character arc patch: changed
// top-level fields plus ONE per patched existing transition (a transition is the
// causal unit — correcting its label and its issue anchor together is one
// milestone repair). Transitions the merge would discard anyway (no `id`, or an
// id no stored transition carries) are not changes.
function countCharacterArcChanges(patch, current) {
  let changes = countFieldChanges(patch, current, { shortFields: CHARACTER_ARC_PATCH_FIELDS });
  const byId = new Map((current?.transitions || []).map((t) => [t.id, t]));
  for (const raw of (Array.isArray(patch?.transitions) ? patch.transitions : [])) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') continue;
    const existing = byId.get(raw.id);
    if (!existing) continue;
    if (raw.delete === true) { changes += 1; continue; }
    if (TRANSITION_PATCH_FIELDS.some((f) => raw[f] !== undefined && !sameStored(raw[f], existing[f]))) changes += 1;
  }
  return changes;
}

/**
 * Decide whether an isolated (single-finding) resolve candidate is bounded
 * enough to persist. Pure. Returns a short rejection reason, or null when the
 * candidate is exactly ONE causal patch: one owner record, one changed field on
 * it — one exact-text replacement, one short scalar, or one existing
 * character-transition patch.
 *
 * This is what makes the arc gate's per-finding fallback (#3780) bounded.
 * Isolating the FINDING never isolated the EDIT: every entry in a single-finding
 * response trivially names that finding, so `selectFindingKeyedEdits` passed
 * whole-arc rewrites and each "isolated" attempt regressed the blocking set
 * exactly like the whole-set pass it escalated from.
 *
 * Checked BEFORE anything is written, so an over-reaching candidate costs its
 * own resolve call and nothing else: no rewrite to undo, and no verification
 * round billed to discover that the rewrite was worse. The post-apply verifier
 * and rollback in the gate stay exactly as they are — this is a narrower net in
 * front of them, not a replacement for them.
 *
 * Counting is against the STORED record, not the response's shape: an echoed
 * `id`/`number`/title is not a change, and an edit the appliers would discard
 * (an unmatched character arc, a transition with no id, an unanchored exact-text
 * replacement, the ignored spelling of a long prose field) is not one either —
 * rejecting on those would fail candidates that were already going to be no-ops.
 */
export function isolatedCandidateRejection(edits, { exactTextMode = false, series = {}, matchedSeasons, issues = [] } = {}) {
  const touched = [];
  if (edits.arc) {
    const changes = countFieldChanges(edits.arc, series.arc || {}, {
      shortFields: ARC_SHORT_FIELDS, longFields: ARC_LONG_FIELDS, exactTextMode,
    }) + mergeTickingClockPatch(series.arc?.tickingClock, edits.arc.tickingClock).changes;
    if (changes) touched.push({ label: 'the arc', changes });
  }
  if (edits.characterArcs.length) {
    const arcByKey = new Map(sanitizeCharacterArcList(series.characterArcs).map((a) => [characterArcKey(a), a]));
    for (const patch of edits.characterArcs) {
      // An unmatched key mints nothing (mergeCharacterArcPatches drops it), so
      // it is not a record this candidate touches.
      const existing = arcByKey.get(characterArcKey(patch));
      if (!existing) continue;
      const changes = countCharacterArcChanges(patch, existing);
      if (changes) touched.push({ label: `character arc ${existing.characterId || 'unkeyed'}`, changes });
    }
  }
  const matched = matchedSeasons || matchProposedSeasons(series.seasons, edits.seasons);
  for (let idx = 0; idx < edits.seasons.length; idx += 1) {
    const existing = matched[idx];
    // An unmatched volume proposal MINTS one. A new volume is never the minimal
    // causal patch for a single finding, and it is the one edit here that can't
    // be undone by putting a field back.
    if (!existing) return 'it would add a new volume instead of patching one';
    const changes = countFieldChanges(edits.seasons[idx], existing, {
      shortFields: SEASON_SHORT_FIELDS, longFields: SEASON_LONG_FIELDS, exactTextMode,
    });
    if (changes) touched.push({ label: `volume ${existing.number ?? '?'}`, changes });
  }
  // Shaped by the applier's own admission rule, so an entry `applyEpisodeResolutions`
  // would drop (no integer episode number, past its cap) is not counted as a
  // record this candidate touches.
  for (const episode of shapeEpisodeResolutions(edits.episodes)) {
    // A custom profile and its two targets are one indivisible length choice.
    const existing = matchIssueForEpisodeEdit(issues, seasonIdByNumberOf(series), episode);
    const changes = Number(Boolean(episode.synopsis) && (!existing || episode.synopsis !== existing.stages?.idea?.input))
      + Number('arcRole' in episode && (!existing || episode.arcRole !== existing.arcRole))
      + Number('lengthProfile' in episode && (!existing || EPISODE_METADATA_FIELDS.slice(1)
        .some((field) => Object.hasOwn(episode, field) && episode[field] !== existing[field])));
    if (!changes) continue;
    touched.push({ label: `episode ${episode.episodeNumber}`, changes });
  }
  if (touched.length === 0) return 'it changed nothing this gate would persist';
  if (touched.length > 1) {
    return `it edits ${touched.length} records (${touched.map((t) => t.label).join(', ')}) — an isolated repair may change only one`;
  }
  const [only] = touched;
  if (only.changes > 1) {
    return `it changes ${only.changes} fields on ${only.label} — an isolated repair may change only one`;
  }
  return null;
}


/** Say what `selectFindingKeyedEdits` discarded from a resolve response. */
function reportDroppedResolveEdits(edits) {
  // Only worth saying when there is actually something to apply unkeyed — a
  // response that proposed NO edits reads as legacy too, and warning about a
  // stale prompt there would be a lie.
  if (edits.legacy && (edits.arc || edits.characterArcs.length || edits.seasons.length || edits.episodes.length)) {
    console.log(`⚠️ arc-resolve: response carries no resolves[] — applying it unkeyed (installed pipeline-arc-resolve.md predates #3724)`);
  }
  if (edits.arcDropped) {
    console.log(`⚠️ arc-resolve: dropped the arc-level edit — it named no input finding`);
  }
  if (edits.characterArcsDropped || edits.seasonsDropped || edits.episodesDropped) {
    console.log(`⚠️ arc-resolve: dropped ${edits.characterArcsDropped} character arc + ${edits.seasonsDropped} volume + ${edits.episodesDropped} episode edit(s) naming no input finding`);
  }
  if (edits.episodesOutOfScope) {
    console.log(`⚠️ arc-resolve: discarded ${edits.episodesOutOfScope} episode edit(s) — the arc-spine gate resolves at arc/volume scope only`);
  }
}

/**
 * The arc after a resolve round: the resolver's value for each field it
 * authored, else the stored one — never wiping a field the resolve prompt
 * doesn't author. In exact-text mode the summary and protagonist arc take
 * exact-text edits, and `rejected` counts the ones that did not apply.
 */
function mergeResolvedArc(storedArc, arcEdit, { exactTextMode }) {
  const arcSummary = exactTextMode
    ? applyExactTextEdits(storedArc.summary || '', arcEdit?.summaryEdits, ARC_LIMITS.SUMMARY_MAX)
    : { value: arcEdit?.summary || storedArc.summary || '', applied: 0, rejected: 0 };
  const protagonistArc = exactTextMode
    ? applyExactTextEdits(storedArc.protagonistArc || '', arcEdit?.protagonistArcEdits, ARC_LIMITS.PROTAGONIST_ARC_MAX)
    : { value: arcEdit?.protagonistArc ?? storedArc.protagonistArc ?? '', applied: 0, rejected: 0 };
  const arc = sanitizeArc({
    logline: arcEdit?.logline || storedArc.logline || '',
    summary: arcSummary.value,
    themes: arcEdit?.themes ?? storedArc.themes,
    protagonistArc: protagonistArc.value,
    shape: arcEdit?.shape ?? storedArc.shape ?? null,
    // The resolve prompt doesn't author the reader map — preserve any existing
    // one so auto-resolve never silently wipes a reader map the user already
    // built on the next step. Mirrors `generateArcOverview` above.
    seriesDesign: storedArc.seriesDesign,
    readerMap: storedArc.readerMap ?? null,
    // A sparse repair can move existing countdown beats without replacing them.
    tickingClock: mergeTickingClockPatch(storedArc.tickingClock, arcEdit?.tickingClock).value ?? null,
    // The resolve prompt doesn't author the foreshadowing ledger — take it if
    // present, else preserve any existing one so auto-resolve never wipes it.
    foreshadowing: arcEdit?.foreshadowing ?? storedArc.foreshadowing ?? null,
    status: 'draft',
  });
  return { arc, rejected: arcSummary.rejected + protagonistArc.rejected };
}

// Character arcs are patched in place by existing IDs; episode (issue) records
// are never CREATED or DELETED here, and their drafted scripts are never
// clobbered — a full-arc round may rewrite an episode's planning synopsis or
// an unproduced issue's role/length (see `applyEpisodeResolutions`). If a
// finding's only actionable resolution would require deleting issues, the LLM
// is told to flag that in the response's `notes` field rather than executing it.
// `options.findings` empty / omitted = re-run verify first and resolve
// everything it returns. `options.avoid` is the optional "a previous attempt at
// these same findings authored THESE and was reverted" list (see
// buildResolveContext) — set only by a corrective pass.
// `options.spineOnly` mirrors verifyArc's pre-episode arc-spine mode: the
// resolver sees the same episode-empty editable tree and may only patch the series arc,
// per-character arcs, and volumes (#3789). It is a PAIRING constraint, not an independent knob — it
// must match the verify that produced `options.findings`, or the resolver
// answers at an altitude the gate never judged. Episode-synopsis corrections
// stay available for the later full arc gate. Existing episode plans are
// read-only references here so a summary repair preserves their established
// events; their presence does not expand this checkpoint's write scope.
export async function resolveVerifyIssues(seriesId, options = {}) {
  const spineOnly = options.spineOnly === true;
  const isolated = options.isolated === true;
  const series = await getSeries(seriesId);
  if (!series.arc) {
    throw new ServerError(
      'Series has no arc to resolve — run /arc/generate first',
      { status: 400, code: 'PIPELINE_NO_ARC' },
    );
  }
  // Resolve rewrites arc + seasons in place, so the lock gates this too.
  // Verify (read-only) stays enabled — the user can act on findings manually.
  if (series.locked?.arc === true) {
    throw new ServerError(
      'Arc is locked — unlock it before rewriting the arc',
      { status: 400, code: ERR_VALIDATION },
    );
  }

  // Load the world once and thread it through verify + resolve so the
  // refresh-then-resolve path doesn't hit the filesystem twice for the same
  // world.
  const world = await resolveWorldContext(series);

  let findings = shapeFindings(options.findings);
  if (!findings.length) {
    // The spread is load-bearing: it carries `spineOnly` into the refresh, which
    // is the one path where the verify and the resolve it feeds are the same
    // call and so must not drift apart in altitude.
    const fresh = await verifyArc(seriesId, { ...options, preloadedWorld: world });
    findings = fresh.issues || [];
    if (!findings.length) {
      return {
        series,
        applied: false,
        notes: 'No findings to resolve',
        findings: [],
        mutations: NO_MUTATIONS,
        noChangeReason: 'no-findings',
      };
    }
  }

  // `options.avoid` carries the findings a reverted earlier attempt at these
  // same findings authored, so a corrective pass is told what NOT to re-create
  // instead of re-running the identical prompt and regressing identically.
  const ctx = await buildResolveContext(series, findings, world, { avoid: options.avoid, spineOnly, isolated });
  const { content, runId, providerId, model } = await runStagedLLM(
    'pipeline-arc-resolve',
    ctx,
    {
      providerOverride: options.providerOverride,
      providerDefault: options.providerDefault,
      modelOverride: options.modelOverride,
      modelDefault: options.modelDefault,
      effortDefault: options.effortDefault,
      onRunCreated: options.onRunCreated,
      onRunSettled: options.onRunSettled,
      returnsJson: true,
      source: 'pipeline-arc-resolve',
    },
  );

  // Keep only the edits that name a finding this round was handed (#3724). An
  // untargeted rewrite is pure blast radius: it can't close anything, and every
  // volume it touches is a chance to author the contradiction the next verify
  // files as a brand-new blocker.
  const edits = selectFindingKeyedEdits(content, findings, { spineOnly });
  const exactTextMode = content?.patchMode === EXACT_TEXT_PATCH_MODE;
  reportDroppedResolveEdits(edits);

  // What every return below carries regardless of whether the candidate landed.
  const runMeta = {
    notes: typeof content?.notes === 'string' ? content.notes.trim().slice(0, 2000) : '',
    findings,
    runId,
    providerId,
    model,
  };

  // Which existing volume each proposal rewrites. Resolved once: the isolated
  // check needs it to tell a patch from a mint, and the season merge below needs
  // the same answer.
  const matchedExisting = matchProposedSeasons(series.seasons, edits.seasons);

  // The isolated fallback's candidate is judged BEFORE anything is written: a
  // candidate that spans records or fields is discarded whole, so it costs its
  // own resolve call and neither a rewrite to undo nor a verification round to
  // discover the damage. Reported as a plain unapplied result — the shape the
  // gate already reads for "nothing was written" — with the bound it broke as
  // the reason. The post-apply verifier and rollback still judge everything that
  // DOES get through.
  const isolationRejected = isolated
    ? isolatedCandidateRejection(edits, {
      exactTextMode, series, matchedSeasons: matchedExisting,
      issues: edits.episodes.length ? await listIssues({ seriesId }) : [],
    })
    : null;
  if (isolationRejected) {
    console.log(`⚠️ arc-resolve: discarded an isolated repair candidate — ${isolationRejected}`);
    return {
      series,
      applied: false,
      reason: isolationRejected,
      patchMode: exactTextMode ? 'exact-text-v1' : null,
      rejectedExactEdits: 0,
      episodesResolved: [],
      mutations: NO_MUTATIONS,
      noChangeReason: 'isolated-candidate-rejected',
      ...runMeta,
    };
  }


  const merged = mergeResolvedArc(series.arc, edits.arc, { exactTextMode });
  const { arc } = merged;
  let rejectedExactEdits = merged.rejected;

  // Round-trip the LLM's seasons through `buildSeason` if they include a
  // brand-new entry (no `id`), otherwise preserve the existing `id` so child
  // issues still join their season cleanly. The sanitizer enforces the
  // canonical shape regardless.
  //
  // `seasons[]` is a SPARSE PATCH LIST (#3724), not the full volume lineup: the
  // response carries only the volumes the resolver actually edited, and every
  // existing volume it left out rides through untouched below. That removes the
  // old "omit a volume and it is deleted" footgun — deletion is now an explicit
  // `notes` recommendation, matching how episode deletion already worked.
  const proposedSeasons = edits.seasons;
  // `matchedExisting` (resolved above) pairs each proposal with the existing
  // record it rewrites BEFORE minting. The resolve prompt frequently returns a
  // rewritten volume WITHOUT echoing its `id`; matching on id alone read that as
  // a brand-new season and minted one. With `preserveDroppedSeasons` on (the
  // autopilot's unlock-for-run mode) the original was then re-inserted alongside
  // the mint — so every auto-resolve round ADDED a duplicate "Volume 1" instead
  // of clearing a finding, and arc-verify could never converge. See the
  // divergence pause on 2026-08-09.
  // Patched rewrites keyed by the record they land on, plus the genuinely-new
  // volumes to append. Untouched existing volumes are carried through verbatim.
  const patchedById = new Map();
  const mintedSeasons = [];
  proposedSeasons.forEach((raw, idx) => {
    const existing = matchedExisting[idx];
    if (existing) {
      const synopsis = exactTextMode
        ? applyExactTextEdits(existing.synopsis || '', raw.synopsisEdits, ARC_LIMITS.SEASON_SYNOPSIS_MAX)
        : { value: typeof raw.synopsis === 'string' ? raw.synopsis : existing.synopsis, applied: 0, rejected: 0 };
      const endingHook = exactTextMode
        ? applyExactTextEdits(existing.endingHook || '', raw.endingHookEdits, ARC_LIMITS.SEASON_ENDING_HOOK_MAX)
        : { value: typeof raw.endingHook === 'string' ? raw.endingHook : existing.endingHook, applied: 0, rejected: 0 };
      if (synopsis.rejected || endingHook.rejected) {
        console.log(`⚠️ arc-resolve: skipped ${synopsis.rejected + endingHook.rejected} ambiguous or over-limit exact text edit(s) for volume ${existing.number}`);
      }
      rejectedExactEdits += synopsis.rejected + endingHook.rejected;
      patchedById.set(existing.id, sanitizeSeason({
        ...existing,
        title: typeof raw.title === 'string' ? raw.title : existing.title,
        number: Number.isFinite(raw.number) ? raw.number : existing.number,
        logline: typeof raw.logline === 'string' ? raw.logline : existing.logline,
        synopsis: synopsis.value,
        endingHook: endingHook.value,
        episodeCountTarget: Number.isFinite(raw.episodeCountTarget)
          ? raw.episodeCountTarget
          : existing.episodeCountTarget,
        themes: Array.isArray(raw.themes) ? raw.themes : existing.themes,
      }));
      return;
    }
    const minted = buildSeason({
      number: raw?.number,
      title: raw?.title,
      logline: raw?.logline,
      synopsis: raw?.synopsis,
      endingHook: raw?.endingHook,
      episodeCountTarget: raw?.episodeCountTarget,
    });
    if (minted) mintedSeasons.push(minted);
  });

  const seasons = sanitizeSeasonList([
    ...(series.seasons || []).map((s) => patchedById.get(s.id) || s),
    ...mintedSeasons,
  ]);

  // `preserveDroppedSeasons` (autopilot unlock-for-run) rides through so an
  // auto-resolve can rewrite a volume but never delete one — see the option's
  // contract on commitSeasonsWithRemap.
  const arcOrSeasonsChanged = JSON.stringify(arc) !== JSON.stringify(series.arc)
    || JSON.stringify(seasons) !== JSON.stringify(series.seasons || []);
  const { series: updated } = arcOrSeasonsChanged
    ? await commitSeasonsWithRemap(
      series,
      { arc, seasons },
      { preserveDroppedSeasons: options.preserveDroppedSeasons === true },
    )
    : { series };

  const characterArcs = mergeCharacterArcPatches(updated.characterArcs, edits.characterArcs);
  const characterArcsChanged = !sameStored(characterArcs, updated.characterArcs || []);
  const resolvedSeries = characterArcsChanged
    ? await updateSeries(seriesId, { characterArcs })
    : updated;

  // Apply any episode-level synopsis corrections the resolver returned. This is
  // the heal capability that lets episode-scoped findings converge: when a
  // contradiction originates inside one episode's planning synopsis (e.g. it
  // stages an event a later volume reserves as its own "first"), the only fix is
  // to rewrite that episode — the volume/arc layer can't make it go away. Done
  // here (after the arc+season commit) against the freshest issue set.
  const episodesResolved = await applyEpisodeResolutions(
    seriesId,
    resolvedSeries,
    shapeEpisodeResolutions(edits.episodes),
  );

  const episodesChanged = episodesResolved.some((entry) => !entry.skipped);
  const applied = arcOrSeasonsChanged || characterArcsChanged || episodesChanged;
  if (!applied && rejectedExactEdits) {
    console.log(`⚠️ arc-resolve: response made no applicable change after ${rejectedExactEdits} exact text edit(s) were rejected`);
  }

  // What this pass actually wrote, per record kind — the whole account in one
  // place, so a fifth record kind is added here and nowhere else. `series.*` is
  // the state as it stood BEFORE the commit above, so these describe this call's
  // writes and nothing else, and the two `*Changed` flags gate the counting: a
  // pass that moved nothing needs no per-record comparison to prove it.
  // Episodes ride the same manifest the rollback is driven by, so an edit that
  // was skipped or failed is never counted as written.
  const mutations = {
    arcFieldsEdited: arcOrSeasonsChanged ? changedFieldCount(arc, series.arc, RESOLVE_ARC_FIELDS) : 0,
    volumesEdited: arcOrSeasonsChanged ? changedEntryCount(seasons, series.seasons) : 0,
    characterArcsEdited: characterArcsChanged ? changedEntryCount(characterArcs, updated.characterArcs) : 0,
    episodesEdited: resolvedEpisodeEdits({ episodesResolved }).length,
  };

  return {
    series: resolvedSeries,
    applied,
    patchMode: exactTextMode ? 'exact-text-v1' : null,
    rejectedExactEdits,
    episodesResolved,
    mutations,
    noChangeReason: applied ? null : noChangeReasonFor(edits, rejectedExactEdits),
    ...runMeta,
  };
}

/**
 * Apply the auto-resolve pass's episode planning corrections to the canonical
 * issue records. Each correction targets one issue by its series-global episode
 * number (with `seasonNumber` as a disambiguating cross-check). Writes the new
 * synopsis to the issue's `idea.input` seed. If that issue already has expanded
 * beats (`idea.output`) — only possible on a resume where beats ran in a prior
 * pass — they are cleared and the stage reset to `empty` so the beat-sheet step
 * regenerates them from the corrected synopsis instead of leaving stale beats
 * that still encode the contradiction.
 *
 * Role/length changes are limited to unproduced issues and clear expanded beats.
 * Metadata and beat invalidation share one owning-service write.
 * A locked `idea` stage is left untouched (the user froze it) and reported as
 * skipped. Returns entries with the written `idea` and/or sparse `metadata`, plus
 * identity, `clearedBeats`, and an optional `skipped` reason
 * for the conductor to surface; never throws — a bad match is dropped, not fatal.
 *
 * `idea` is the stage AS THIS CALL LEFT IT, and it is what makes the entry a
 * mutation manifest rather than a report: rollback restores an episode only when
 * the resolver is on record as having written it AND the value it wrote is still
 * standing (see `restoreArcState`). A write that failed is reported skipped —
 * counting it as an applied edit told the gate a synopsis had changed when the
 * store still held the old one.
 */
export async function applyEpisodeResolutions(seriesId, series, episodes) {
  if (!Array.isArray(episodes) || episodes.length === 0) return [];
  const issues = await listIssues({ seriesId });
  const seasonIdByNumber = seasonIdByNumberOf(series);
  const applied = [];
  for (const edit of shapeEpisodeResolutions(episodes)) {
    // Season match required when the named season resolves, else series-global
    // number; fail-safe to no-match on a numbering-scheme mismatch (see
    // matchIssueForEpisodeEdit). A bad match is logged below, never fatal.
    const issue = matchIssueForEpisodeEdit(issues, seasonIdByNumber, edit);
    if (!issue) {
      // A correction we can't land is a silent path to non-convergence — log it
      // so a number-scheme mismatch (per-season vs series-global) is diagnosable.
      console.log(`⚠️ arc-resolve: no issue matched episode correction (season ${edit.seasonNumber}, episode ${edit.episodeNumber})`);
      applied.push({ seasonNumber: edit.seasonNumber, episodeNumber: edit.episodeNumber, skipped: 'no-match' });
      continue;
    }
    if (issue.stages?.idea?.locked === true) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'locked' });
      continue;
    }
    const metadata = Object.fromEntries(EPISODE_METADATA_FIELDS
      .filter((field) => Object.hasOwn(edit, field) && edit[field] !== issue[field])
      .map((field) => [field, edit[field]]));
    const metadataChanged = Object.keys(metadata).length > 0;
    const hasSynopsis = typeof edit.synopsis === 'string' && edit.synopsis.trim().length > 0;
    if (!metadataChanged && !hasSynopsis) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'unchanged' });
      continue;
    }
    // This repair owns the plan, not regeneration of an existing manuscript or
    // page layout. A length/role change after production needs explicit review.
    const pages = issue.stages?.comicPages;
    if (metadataChanged && (MANUSCRIPT_TYPES.some((stage) => {
      const value = issue.stages?.[stage];
      return value?.output?.trim() || value?.input?.trim();
    }) || pages?.pages?.length || ['cover', 'backCover'].some((slot) => pages?.[slot]?.proofImage || pages?.[slot]?.finalImage))) {
      applied.push({ issueId: issue.id, number: issue.number, seasonNumber: edit.seasonNumber, skipped: 'existing-production' });
      continue;
    }
    const hadBeats = Boolean(issue.stages?.idea?.output?.trim());
    const ideaPatch = {
      ...(hasSynopsis ? { input: edit.synopsis } : {}),
      ...(hadBeats ? { output: '', status: 'empty', errorMessage: '' } : {}),
    };
    const writesIdea = Object.keys(ideaPatch).length > 0;
    // Metadata and any resulting beat invalidation belong to one stored write.
    const write = metadataChanged
      ? updateIssue(issue.id, { ...metadata, ...(writesIdea ? { stages: { idea: ideaPatch } } : {}) })
      : updateStageWithLatest(issue.id, 'idea', () => ideaPatch).then((result) => result.issue);
    const written = await write.catch((err) => {
      console.log(`⚠️ arc-resolve: episode ${edit.episodeNumber} planning edit failed: ${err.message}`);
      return null;
    });
    applied.push({
      issueId: issue.id,
      number: issue.number,
      seasonNumber: edit.seasonNumber,
      clearedBeats: hadBeats,
      ...(written ? {
        ...(writesIdea ? { idea: ideaSnapshotOf(written.stages?.idea) } : {}),
        ...(metadataChanged ? {
          metadata: Object.fromEntries(Object.keys(metadata).map((field) => [field, written[field]])),
          metadataGuard: episodeMetadataOf(written),
        } : {}),
      } : { skipped: 'write-failed' }),
    });
  }
  if (applied.length) {
    const fixed = applied.filter((a) => !a.skipped).length;
    console.log(`📝 arc-resolve: corrected ${fixed} episode synopsis(es) for series ${seriesId.slice(0, 12)}`);
  }
  return applied;
}
