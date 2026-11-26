/** Commits confirmed imports into canon, series, and issues with resumable issue plans. */

import { createHash, randomUUID } from 'crypto';
import { getUniverse, updateUniverse } from '../universeBuilder.js';
import { getSeries, updateSeries } from '../pipeline/series.js';
import { deleteIssue, ensureIssueWithId, listIssues } from '../pipeline/issues.js';
import { reformatManuscriptText } from '../pipeline/manuscriptFix.js';
import { sanitizeArc, sanitizeSeasonList, buildSeason } from '../../lib/storyArc.js';
import { mergeExtractedBible, BIBLE_KIND } from '../../lib/storyBible.js';
import { isStr } from '../../lib/textUtils.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { recordImportProgress, withImportLock, SESSION_STATUS } from '../importerSessions.js';
import { codedError } from '../../lib/codedError.js';
import {
  ERR_VALIDATION,
  ERR_LOCKED,
  ERR_PARTIAL_COMMIT_ISSUES,
  ERR_IMPORT_IN_PROGRESS,
} from './importerErrors.js';
import { resolveImportSession } from './importerSessionState.js';
import { makeImporterProgressEmitter } from '../importerEvents.js';

// Which text stage an issue's verbatim excerpt seeds at commit. A content type
// that is ALREADY in a script form seeds that script stage (ready) so the
// pipeline renders the user's verbatim text instead of regenerating it; prose
// types seed `stages.prose`. One table row per structured type. The scene
// extractor (`extractScenes`) already adapts a verbatim teleplay into
// storyboards via the `pipeline-extract-scenes` prompt, so a screenplay needs
// no parser work — unlike the comic path, which had to teach `parseComicScript`
// the bare PAGE/PANEL form.
const CONTENT_TYPE_SEED_STAGE = Object.freeze({
  'comic-script': 'comicScript',
  'screenplay': 'teleplay',
});
const DEFAULT_SEED_STAGE = 'prose';
const seedStageFor = (contentType) => CONTENT_TYPE_SEED_STAGE[contentType] || DEFAULT_SEED_STAGE;

/**
 * Best-effort AI cleanup of seeded excerpts at import time (issue #1335). The
 * importer seeds each issue's verbatim `proseExcerpt` straight into its seed
 * stage — which is exactly the PDF/paste-mangled text the editor's Reformat
 * button repairs. Running it through the SAME `reformatManuscriptText` pass at
 * import time lets manuscripts arrive already-clean instead of needing a
 * per-section Reformat pass afterward.
 *
 * Opt-in (caller passes `cleanupFormatting`) because it's one LLM call per
 * issue — a 20+ issue import would otherwise add minutes to commit. The seed
 * stage id (prose / comicScript / teleplay — every `seedStageFor` value is a
 * valid manuscript reformat type) selects the reformat's format label, so
 * comic-script and screenplay imports route through too.
 *
 * Best-effort: a failed or integrity-guard-rejected reformat (the guard rejects
 * any pass that altered wording) falls back to the verbatim excerpt so import
 * never breaks. Emits importer progress frames (one checklist row per cleaned
 * issue) so the blocking commit can show live status. Returns a NEW array;
 * never mutates the caller's input.
 */
export async function reformatSeededExcerpts(issues, { contentType = null } = {}) {
  const stageId = seedStageFor(contentType);
  const targets = (Array.isArray(issues) ? issues : []).filter((p) => p?.proseExcerpt);
  if (targets.length === 0) return issues;
  const { emitProgress: emit } = makeImporterProgressEmitter();
  // Index cleaned text by the original proposal reference so the returned array
  // can be rebuilt without mutating the input objects.
  const cleaned = new Map();
  emit({
    type: 'start',
    stages: targets.map((p, idx) => ({ id: `reformat-${idx}`, label: `Clean up formatting: ${p.title}` })),
  });
  // Sequential on purpose: one provider call at a time keeps a 20+ issue import
  // from fanning out concurrent LLM calls (rough on a local model) and lets the
  // checklist fill in reading order.
  for (let idx = 0; idx < targets.length; idx++) {
    const proposal = targets[idx];
    emit({ type: 'stage', id: `reformat-${idx}`, status: 'running' });
    const result = await reformatManuscriptText(proposal.proseExcerpt, { stageId }).catch((err) => {
      // Best-effort: keep the verbatim excerpt so import never breaks on an LLM
      // error, empty output, or the integrity guard rejecting a word-altering
      // reformat. The stage row shows 'error' (warning icon) to flag the fallback.
      console.error(`❌ importer reformat fell back to verbatim for "${proposal.title}": ${err.message}`);
      return null;
    });
    if (result?.text) cleaned.set(proposal, result.text);
    // Clean outcomes → 'done', the verbatim fallback → 'error' (the warning icon
    // that flags "not cleaned"), reusing the client's existing status icon set.
    emit({ type: 'stage', id: `reformat-${idx}`, status: result ? 'done' : 'error' });
  }
  emit({ type: 'done' });
  return issues.map((p) => (cleaned.has(p) ? { ...p, proseExcerpt: cleaned.get(p) } : p));
}

// that ceiling here so the auto-assign path can't silently land a value
// the schema wouldn't accept on direct entry.
const SEASON_NUMBER_MAX = 99;
// Wire schema (importerIssueEntry) caps arcPosition at 9999 — mirror so
// the service-side auto-assign can't drift above it.
const ARC_POSITION_MAX = 9999;

/**
 * Merge incoming seasons with the existing `series.seasons[]` array,
 * matching by `number`. Pure function — no I/O. Extracted so the merge
 * logic (used number set, auto-assign for omitted numbers, update vs
 * create per number, change-aware updatedAt bump, union back with
 * retained existing) can be reasoned about + unit-tested in isolation.
 *
 * Contract:
 *   - Incoming seasons with an explicit integer `number >= 1` keep it.
 *   - Incoming seasons that omit `number` are assigned the next free
 *     integer above the union of existing + already-assigned numbers;
 *     throws ERR_VALIDATION if that would exceed SEASON_NUMBER_MAX (99).
 *   - Where the assigned number matches an existing season, the existing
 *     season's id (+ timestamps) are preserved — re-import is a metadata
 *     refresh, not a new season. **String-field merge follows AGENTS.md's
 *     "absent vs intentionally empty" rule**: `undefined`/`null` preserves
 *     the existing value; an empty string `""` is treated as an intentional
 *     clear and applied. `updatedAt` bumps when any tracked field
 *     (title / logline / synopsis / endingHook / episodeCountTarget)
 *     actually changed, including a clear.
 *   - Existing seasons not touched by this merge are retained as-is.
 *   - Caller is responsible for `sanitizeSeasonList` on the result.
 */
export function mergeSeasons(existingSeasons, incomingSeasons, buildSeasonImpl = buildSeason) {
  const existingByNumber = new Map(
    existingSeasons.filter((s) => Number.isFinite(s.number)).map((s) => [s.number, s]),
  );
  // Dedup-check + ceiling-check explicit incoming numbers — commitImport's
  // route path Zod gates against both, but a direct caller (a future
  // internal consumer of the pure helper, or a test) would otherwise
  // silently collapse two incoming seasons sharing a number into one merge
  // target, or land a number > SEASON_NUMBER_MAX that the wire wouldn't
  // accept. Auto-assign path enforces the ceiling below; the explicit
  // path enforces it here for symmetry.
  const seenIncomingNumbers = new Set();
  for (const s of incomingSeasons) {
    if (Number.isInteger(s?.number) && s.number >= 1) {
      if (s.number > SEASON_NUMBER_MAX) {
        throw codedError(
          `mergeSeasons: explicit season number ${s.number} exceeds the max of ${SEASON_NUMBER_MAX}.`,
          ERR_VALIDATION,
        );
      }
      if (seenIncomingNumbers.has(s.number)) {
        throw codedError(
          `mergeSeasons: duplicate explicit season number ${s.number} in incoming list — caller must pre-dedupe.`,
          ERR_VALIDATION,
        );
      }
      seenIncomingNumbers.add(s.number);
    }
  }
  const usedNumbers = new Set([...existingByNumber.keys(), ...seenIncomingNumbers]);
  // Jump-past-max rather than gap-fill: if existing seasons are [1, 5],
  // auto-assign lands at 6 (not 2). Two reasons: (1) gap-fill could
  // silently re-occupy a slot the user intentionally deleted (e.g.
  // removed season 3 to retire it; new content shouldn't land at slot 3
  // with a totally different premise); (2) "new = appended" matches the
  // user's mental model of how multi-pass imports extend the world.
  let nextFreeNumber = (usedNumbers.size === 0) ? 1 : Math.max(...usedNumbers) + 1;
  const nowIso = new Date().toISOString();
  // String-field merge: absent (`undefined`/`null`) preserves the existing
  // value; everything else — including `""` — is the user's intent and is
  // applied verbatim. Mirrors the AGENTS.md "distinguish absent vs
  // intentionally empty" rule so a Review-phase blank-out actually clears.
  const mergeStr = (incoming, existing) => (incoming == null ? (existing ?? '') : incoming);
  const incomingBuilt = incomingSeasons.map((s) => {
    let num;
    if (Number.isInteger(s?.number) && s.number >= 1) {
      num = s.number;
    } else {
      if (nextFreeNumber > SEASON_NUMBER_MAX) {
        throw codedError(
          `Cannot auto-assign season number — next free slot (${nextFreeNumber}) exceeds the max of ${SEASON_NUMBER_MAX}. Free up a season slot or set season.number explicitly.`,
          ERR_VALIDATION,
        );
      }
      num = nextFreeNumber++;
    }
    const existing = existingByNumber.get(num);
    if (existing) {
      // Apply the same `|| Season N` default to BOTH sides of the title
      // comparison so a legacy season with `title: undefined` doesn't
      // churn updatedAt on every no-op re-import: without normalizing
      // the existing-side default, `'Season N' !== undefined` always
      // resolves truthy and bumps updatedAt even when nothing changed.
      const titleDefault = `Season ${num}`;
      const nextTitle = mergeStr(s.title, existing.title) || titleDefault;
      const nextLogline = mergeStr(s.logline, existing.logline);
      const nextSynopsis = mergeStr(s.synopsis, existing.synopsis);
      const nextEndingHook = mergeStr(s.endingHook, existing.endingHook);
      const nextEpisodeCount = s.episodeCountTarget ?? existing.episodeCountTarget ?? 0;
      const anyChanged = nextTitle !== (existing.title || titleDefault)
        || nextLogline !== (existing.logline ?? '')
        || nextSynopsis !== (existing.synopsis ?? '')
        || nextEndingHook !== (existing.endingHook ?? '')
        || nextEpisodeCount !== (existing.episodeCountTarget ?? 0);
      return {
        ...existing,
        title: nextTitle,
        logline: nextLogline,
        synopsis: nextSynopsis,
        endingHook: nextEndingHook,
        episodeCountTarget: nextEpisodeCount,
        ...(anyChanged ? { updatedAt: nowIso } : {}),
      };
    }
    return buildSeasonImpl({
      number: num,
      title: s.title || `Season ${num}`,
      logline: s.logline || '',
      synopsis: s.synopsis || '',
      endingHook: s.endingHook || '',
      episodeCountTarget: s.episodeCountTarget ?? 0,
      status: 'draft',
    });
  });
  // Union: existing seasons NOT in the incoming set + the (updated or
  // freshly built) incoming entries. Caller runs sanitizeSeasonList.
  // Filter retained to the same finite-numbered subset the map above
  // operates on — a malformed existing entry (number undefined/NaN)
  // would otherwise always slip through (since incomingNumbers only
  // contains valid integers), surviving the merge unreachable by id.
  // sanitizeSeasonList downstream coerces those to 0 and may drop
  // them, but filtering here removes the ambiguity at the source.
  const incomingNumbers = new Set(incomingBuilt.map((s) => s.number));
  const retained = existingSeasons.filter((s) =>
    Number.isFinite(s.number) && !incomingNumbers.has(s.number),
  );
  return [...retained, ...incomingBuilt];
}

// Binds an issue plan to the payload it was made for (#10762): the fields that
// decide what each planned issue is. Canon/arc/seasons are left out — a resume
// drops them server-side — and so is `cleanupFormatting`, which only changes
// how the excerpts of the issues still to be created get cleaned.
function hashIssuePayload(issues, contentType) {
  const shape = issues.map((p) => [
    p?.title ?? null, p?.arcPosition ?? null, p?.arcRole ?? null, p?.seasonNumber ?? null,
    p?.proseExcerpt ?? null, p?.logline ?? null, p?.synopsis ?? null,
  ]);
  return createHash('sha256').update(JSON.stringify([contentType ?? null, shape])).digest('hex');
}

/**
 * Promote any import-draft shell once its import's issues all exist (issue
 * #727). analyzeImport creates brand-new universe/series records as import
 * drafts (`ephemeral` + `importDraft`) so an abandoned analyze leaves no
 * syncing orphan; a finished commit turns them into normal records by clearing
 * BOTH flags. Clearing `ephemeral` must go through updateUniverse/updateSeries
 * (they wire the ephemeral→non-ephemeral peer re-subscribe), so the same patch
 * clears `importDraft` too. Gate STRICTLY on `importDraft` — committing an
 * import onto a user's pre-existing private (`ephemeral`-only) record must NOT
 * silently un-privatize it.
 */
async function promoteImportDrafts(universe, series) {
  const promotedUniverse = universe.importDraft === true
    ? await updateUniverse(universe.id, { ephemeral: false, importDraft: false })
    : universe;
  const promotedSeries = series.importDraft === true
    ? await updateSeries(series.id, { ephemeral: false, importDraft: false })
    : series;
  return { universe: promotedUniverse, series: promotedSeries };
}

// The issues exist, so failing to record that must not fail the commit. With
// the issue plan still on disk a retry finishes the receipt without creating
// anything (#10762), so logging is enough.
function recordCommittedReceipt(importId, createdIssueIds, remappedIssues) {
  return recordImportProgress(importId, {
    status: SESSION_STATUS.COMMITTED,
    createdIssueIds,
    remappedIssues,
    plan: null,
  }).catch((err) => console.error(`❌ importer session ${importId} not marked committed (its issue plan stays resumable): ${err.message}`));
}

/**
 * Phase 2: commit. Merges the user-confirmed canon into the universe,
 * writes the arc + seasons onto the series, then creates one issue per
 * proposal with prose pre-seeded. Validates the locked-arc guard one more
 * time (the series could have been locked between analyze + commit).
 *
 * `importId` (from analyze, #9943) makes the commit resumable: its server-side
 * session records how far an earlier attempt got, so a repeat — a double click,
 * a second tab, a retry after a reload dropped the client's own markers —
 * replays the recorded result or resumes at the issues instead of re-sending
 * canon/arc and duplicating the issue set. Absent, the commit behaves as before.
 *
 * Every commit into a series — any importId, a same-id retry, or an older
 * client sending none — is admitted one at a time per series (#10763). The
 * position checks read the series' issue inventory and allocate from it; two
 * manuscripts committed side by side would otherwise both pass against the
 * same snapshot and land duplicate arcPositions.
 */
export async function commitImport(args = {}) {
  const { importId = null } = args;
  return importId ? withImportLock(importId, () => commitImportOnce(args)) : commitImportOnce(args);
}

// Per-series commit admission (#10763). Held from the inventory read through
// the last issue write, so the collision checks and the positions the plan
// allocates stay true until the issues are published. Different series run
// concurrently. Never re-entered from inside a commit, and the import lock is
// always taken outside it, so the two cannot deadlock.
const seriesCommitQueue = createKeyCachedQueue();

async function commitImportOnce(args) {
  const { universeId, seriesId, issues, contentType = null, cleanupFormatting = false } = args;
  // Payload-only checks — no reads — so a malformed commit fails before it
  // queues behind another import or spends an LLM call.
  if (!isStr(universeId)) throw codedError('universeId is required', ERR_VALIDATION);
  if (!isStr(seriesId)) throw codedError('seriesId is required', ERR_VALIDATION);
  if (!Array.isArray(issues) || issues.length === 0) {
    throw codedError('At least one issue is required', ERR_VALIDATION);
  }
  let formattedExcerpts = null;
  if (cleanupFormatting) {
    // The optional AI cleanup (issue #1335) is one LLM call per issue — minutes
    // for a long manuscript. Check the commit against current state first so a
    // doomed or already-committed import never burns those calls, then run them
    // OUTSIDE the series admission so one slow import doesn't hold up every
    // other commit into the series. Admission re-checks fresh state and takes
    // only the cleaned excerpts from here — never the positions this precheck
    // saw, which may be stale by then.
    const precheck = await admitAndCommit(args, { precheck: true });
    if (!precheck.replay) {
      const cleaned = await reformatSeededExcerpts(precheck.pendingProposals, { contentType });
      formattedExcerpts = cleaned.map((proposal) => proposal?.proseExcerpt);
    }
  }
  return seriesCommitQueue(seriesId, () => admitAndCommit(args, { formattedExcerpts }));
}

// Where a commit stands against the earlier attempts at the same import — one
// reading, made before any write, that every later step switches on (#11111).
const IMPORT_PHASE = Object.freeze({
  // An already-committed import seen by the precheck pass: it writes nothing.
  REPLAY_PRECHECK: 'replay-precheck',
  // An already-committed import: answer with the recorded ids.
  REPLAY: 'replay',
  // An unfinished plan for this same issue list: finish it.
  RESUME: 'resume',
  // No usable session: plan everything, positions checked against the series.
  FRESH: 'fresh',
  // Destructive replace: wipe the series' issues and rewrite it.
  REPLACE: 'replace',
});

/**
 * The single admission decision for a commit (#11111): which phase it is in,
 * read from the on-disk import session. Reads only — it writes nothing, so a
 * commit is refused (or replayed) before any canon or issue write.
 *
 * - `arcPersisted`: an earlier attempt already wrote canon/arc/seasons
 *   (`ARC_PERSISTED`), so this commit must not resend them.
 * - `resumePlan` / `resumeLive`: the unfinished plan and the planned issues
 *   that already exist — kept as they are now, never re-created.
 */
async function resolveImportAdmission({ importId, replaceMode, precheck, series, payloadHash }) {
  const admission = { arcPersisted: false, resumePlan: null, resumeLive: new Set() };
  // Replace mode wipes and rewrites the series, so it is idempotent by
  // construction and never consults the session (#9943); additive mode would
  // duplicate, so it does.
  if (replaceMode) return { ...admission, phase: IMPORT_PHASE.REPLACE };
  const session = importId ? await resolveImportSession(importId, series.id) : null;
  if (session?.status === SESSION_STATUS.COMMITTED) {
    if (precheck) return { ...admission, phase: IMPORT_PHASE.REPLAY_PRECHECK };
    const { createdIssueIds, remappedIssues, receiptPending = false } = session;
    return { ...admission, phase: IMPORT_PHASE.REPLAY, createdIssueIds, remappedIssues, receiptPending };
  }
  if (session?.status !== SESSION_STATUS.ARC_PERSISTED) return { ...admission, phase: IMPORT_PHASE.FRESH };
  // The issue plan an earlier attempt left unfinished (#10762), when this retry
  // carries the same issue list.
  if (session.plan?.payloadHash === payloadHash) {
    return {
      phase: IMPORT_PHASE.RESUME,
      arcPersisted: true,
      resumePlan: session.plan,
      resumeLive: new Set(session.liveIssueIds),
    };
  }
  if (session.plan && session.liveIssueIds.length > 0) {
    const k = session.liveIssueIds.length;
    throw codedError(
      `An earlier attempt at this import already created ${k} of its ${session.plan.items.length} issues from a different issue list. Resubmit that issue list to finish it, or delete ${k === 1 ? 'that issue' : 'those issues'} (${session.liveIssueIds.join(', ')}) to start over with this one.`,
      ERR_IMPORT_IN_PROGRESS,
    );
  }
  // None of the old plan's issues exist, so nothing is owned and a changed
  // issue list simply plans afresh — but canon/arc/seasons are still on disk.
  return { ...admission, phase: IMPORT_PHASE.FRESH, arcPersisted: true };
}

// A replayed commit writes nothing new. A receipt lost after the last issue
// landed (#10762) is completed here: promote the draft shells, then record it.
async function replayCommittedImport(importId, admission, records) {
  let replayedRecords = records;
  if (admission.receiptPending) {
    replayedRecords = await promoteImportDrafts(records.universe, records.series);
    await recordCommittedReceipt(importId, admission.createdIssueIds, admission.remappedIssues);
  }
  return {
    ...replayedRecords,
    createdIssueIds: admission.createdIssueIds,
    remappedIssues: admission.remappedIssues,
    replayed: true,
  };
}

// Thread C fix — fail-fast validation BEFORE any state mutation. Run every
// issue through all gates that createIssue enforces so that a bad payload is
// rejected here, before the universe + series are written. `createIssue` also
// requires `seriesId` (supplied later) and generates its own `id`, so those
// two fields don't need pre-checking. Returns the explicit arcPositions, which
// the auto-assign pass must not reuse.
function rejectInvalidIssueProposals(issues) {
  for (let i = 0; i < issues.length; i++) {
    const proposal = issues[i];
    if (!isStr(proposal?.title) || !proposal.title.trim()) {
      throw codedError(
        `Issue at position ${i + 1} is missing a title — commit refused before any state changed.`,
        ERR_VALIDATION,
      );
    }
    // arcPosition is the issue's slot in the series — Zod enforces
    // int 1..ARC_POSITION_MAX at the route layer, but commitImport is
    // also called directly from tests + future internal callers; mirror
    // both the floor and the ceiling here so the service contract holds
    // regardless of caller. Allow undefined — an auto-assign pass
    // picks the next free slot. Reject anything that isn't a valid
    // integer in [1, ARC_POSITION_MAX].
    if (proposal.arcPosition !== undefined && proposal.arcPosition !== null
        && (!Number.isInteger(proposal.arcPosition)
            || proposal.arcPosition < 1
            || proposal.arcPosition > ARC_POSITION_MAX)) {
      throw codedError(
        `Issue at position ${i + 1} has invalid arcPosition (must be integer 1..${ARC_POSITION_MAX}) — commit refused before any state changed.`,
        ERR_VALIDATION,
      );
    }
    // When proseExcerpt is present it must be non-empty after trim —
    // mirrors the route Zod `.refine` so a whitespace-only excerpt from
    // a direct caller doesn't seed `stages.prose` with garbage.
    if (proposal.proseExcerpt !== undefined && proposal.proseExcerpt !== null) {
      if (!isStr(proposal.proseExcerpt) || !proposal.proseExcerpt.trim()) {
        throw codedError(
          `Issue at position ${i + 1} has invalid proseExcerpt (must be non-empty when present) — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
    }
  }
  // Reject duplicate explicit arcPosition values across the incoming
  // issues array — downstream sorting collapses ties to insertion order
  // and the renumber pass would silently re-key, leaving the user
  // wondering why issue #3 became #4.
  const seenArcPositions = new Set();
  for (let i = 0; i < issues.length; i++) {
    const pos = issues[i]?.arcPosition;
    if (Number.isInteger(pos) && pos >= 1) {
      if (seenArcPositions.has(pos)) {
        throw codedError(
          `Duplicate arcPosition ${pos} at issue position ${i + 1} — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
      seenArcPositions.add(pos);
    }
  }
  return seenArcPositions;
}

/**
 * Every incoming issue with its arcPosition, refused when a position would
 * collide with an issue already on the series.
 *
 * - `resume` keeps the positions its plan fixed — auto-assigning again would
 *   start past this import's own survivors and shift every missing issue. It
 *   still owes the series unique positions: since the earlier attempt, a new
 *   issue — or one of this import's survivors, moved — may have taken a slot
 *   the plan reserved for a missing issue. Survivors left where the plan put
 *   them never collide: the plan's positions are distinct.
 * - `fresh` refuses an explicit position an existing issue holds, and seeds
 *   auto-assign from the UNION of explicit incoming and existing positions —
 *   createIssue doesn't enforce uniqueness, so a collision would silently land
 *   on disk and the renumber pass would arbitrarily order the ties.
 * - `replace` wipes the existing issues first, so their positions are free.
 *
 * Auto-assign is capped at ARC_POSITION_MAX (matching the wire schema's
 * `.max(9999)`) so a value the wire wouldn't accept can't reach createIssue.
 */
function assignIssuePositions({ phase, resumePlan, resumeLive }, issues, existingIssues, explicitPositions) {
  if (phase === IMPORT_PHASE.RESUME) {
    const taken = new Set(existingIssues.map((ex) => ex.arcPosition).filter(Number.isInteger));
    resumePlan.items.forEach((item, i) => {
      if (!resumeLive.has(item.issueId) && taken.has(item.arcPosition)) {
        throw codedError(
          `Issue at position ${i + 1} was planned for arcPosition ${item.arcPosition}, which another issue now occupies — commit refused before any state changed. Move or delete that issue, then retry to finish this import.`,
          ERR_VALIDATION,
        );
      }
    });
    return issues.map((proposal, i) => ({ ...proposal, arcPosition: resumePlan.items[i].arcPosition }));
  }
  const existingArcPositions = new Set();
  if (phase === IMPORT_PHASE.FRESH) {
    for (const ex of existingIssues) {
      if (Number.isInteger(ex.arcPosition) && ex.arcPosition >= 1) existingArcPositions.add(ex.arcPosition);
    }
    for (let i = 0; i < issues.length; i++) {
      const pos = issues[i]?.arcPosition;
      if (Number.isInteger(pos) && pos >= 1 && existingArcPositions.has(pos)) {
        throw codedError(
          `Issue at position ${i + 1} explicit arcPosition ${pos} collides with an existing issue on the series — commit refused before any state changed. Either renumber the incoming issue or omit arcPosition to auto-assign.`,
          ERR_VALIDATION,
        );
      }
    }
  }
  const allUsedArcPositions = new Set([...explicitPositions, ...existingArcPositions]);
  let nextFreeArcPos = (allUsedArcPositions.size === 0) ? 1 : Math.max(...allUsedArcPositions) + 1;
  return issues.map((proposal) => {
    if (Number.isInteger(proposal.arcPosition) && proposal.arcPosition >= 1) return proposal;
    if (nextFreeArcPos > ARC_POSITION_MAX) {
      throw codedError(
        `Cannot auto-assign arcPosition — next free slot (${nextFreeArcPos}) exceeds the max of ${ARC_POSITION_MAX}. Free up a position or set issue.arcPosition explicitly.`,
        ERR_VALIDATION,
      );
    }
    return { ...proposal, arcPosition: nextFreeArcPos++ };
  });
}

// Same contract for seasons: route Zod enforces `number: int 1..99`,
// commitImport mirrors both the floor AND the ceiling so the service is
// safe under direct calls. Also reject duplicate season numbers — the
// merge keys by `number`, so two incoming seasons sharing one would
// silently collapse into a single entry post sanitizeSeasonList.
function rejectInvalidSeasons(seasons) {
  const seenSeasonNumbers = new Set();
  for (let i = 0; i < seasons.length; i++) {
    const s = seasons[i];
    if (s?.number !== undefined && s?.number !== null) {
      if (!Number.isInteger(s.number) || s.number < 1 || s.number > SEASON_NUMBER_MAX) {
        throw codedError(
          `Season at position ${i + 1} has invalid number (must be integer 1..${SEASON_NUMBER_MAX}) — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
      if (seenSeasonNumbers.has(s.number)) {
        throw codedError(
          `Duplicate season number ${s.number} at position ${i + 1} — commit refused before any state changed.`,
          ERR_VALIDATION,
        );
      }
      seenSeasonNumbers.add(s.number);
    }
  }
}

// Replace mode's wipe, run BEFORE universe + series writes so any delete
// failure aborts the commit cleanly — universe canon + series arc are still in
// their pre-import state, and no new issues have been created yet. Without
// this ordering, a swallowed delete failure would leave us writing new issues
// alongside undeleted old ones; replace mode skips the collision check, so
// reused arcPositions would silently produce duplicates on disk that additive
// mode explicitly rejects.
//
// Abort on the FIRST delete failure (not after looping through all of them) to
// minimize the destructive surface — deletes already landed are
// unrecoverable, so the fewer that completed before the throw, the more of the
// user's pre-import state survives. The error message names the succeeded vs
// remaining sets explicitly so the user can audit what's gone before
// retrying. Universe + series writes are idempotent, so re-running the import
// after the user fixes the underlying error (and accepts the partially-deleted
// state) is safe.
async function deleteIssuesForReplace(existingIssues) {
  const deletedIds = [];
  for (const ex of existingIssues) {
    let failed = null;
    await deleteIssue(ex.id).catch((delErr) => {
      console.error(`❌ commitImport replace: failed to delete existing issue ${ex.id}: ${delErr.message}`);
      failed = delErr;
    });
    if (failed) {
      // The "still on disk" set includes BOTH the failed-to-delete issue AND
      // the untouched issues that come after it in the loop — all of them are
      // unaffected on disk and will be wiped on retry. Reporting them as one
      // set keeps the count honest: total still-on-disk == remainingIds.length.
      const deletedSet = new Set(deletedIds);
      const remainingIds = existingIssues.map((e) => e.id).filter((id) => !deletedSet.has(id));
      const deletedMsg = deletedIds.length > 0
        ? ` ${deletedIds.length} issue${deletedIds.length === 1 ? '' : 's'} were already deleted before the failure (${deletedIds.join(', ')}) and cannot be recovered.`
        : '';
      const remainingMsg = ` ${remainingIds.length} issue${remainingIds.length === 1 ? '' : 's'} remain on disk (${remainingIds.join(', ')}, including the failed one); retry will wipe them.`;
      throw codedError(
        `Replace mode aborted on first delete failure — issue ${ex.id} could not be deleted (${failed.message}). No universe, series, or new-issue writes were performed.${deletedMsg}${remainingMsg} Resolve the underlying error and retry.`,
        ERR_VALIDATION,
      );
    }
    deletedIds.push(ex.id);
  }
}

// Additive bible fill (the logline/premise/issueCountTarget the Arc Canvas
// sidebar reads): only fields the series doesn't already have, so a re-import
// never clobbers a hand-edited bible. The issue-count target is the POST-import
// total (issues already on the series plus the ones being added) — adding 3
// issues to a series that already has 2 should target 5, not 3. Evaluated only
// against the freshest persisted record, inside the series write (#11111).
function fillEmptySeriesBible(latest, { arcLogline, arcPremise, priorIssueCount, issueCount }) {
  const patch = {};
  if (arcLogline && !(latest.logline || '').trim()) patch.logline = arcLogline;
  if (arcPremise && !(latest.premise || '').trim()) patch.premise = arcPremise;
  const additiveTotal = priorIssueCount + issueCount;
  if (additiveTotal > 0 && !(latest.issueCountTarget > 0)) patch.issueCountTarget = additiveTotal;
  return patch;
}

// Wire field, BIBLE_KIND, and storage field collapsed to one row per kind so a
// future schema change updates one tuple instead of three call sites.
const CANON_KIND_MAP = [
  ['characters', BIBLE_KIND.CHARACTER, 'characters'],
  ['places',     BIBLE_KIND.PLACE,     'places'],
  ['objects',    BIBLE_KIND.OBJECT,    'objects'],
];

/**
 * Writes the import's universe canon and the series arc, seasons and bible.
 * Universe canon always merges additively (it's shared across series, so a
 * per-series destructive replace would be too coarse). Replace overwrites the
 * series; every other phase merges into it.
 *
 * Both writes use the mutator form of `updateUniverse`/`updateSeries` where
 * they merge (issue #8453): the series admission keeps other importer commits
 * out of this series, but NOT edits made outside the importer, and the
 * universe is shared across series — so the up-front snapshots can already be
 * stale. `mergeExtractedBible`/`mergeSeasons` rebuild the whole array from
 * their base list, so merging against a snapshot would silently drop a
 * concurrent edit. Merging against `latest` — the freshest persisted record,
 * read inside the write queue — closes that race.
 */
async function applyImportedCanon({ phase, universe, series, canonSelections, arc, seasons, priorIssueCount, issueCount }) {
  // Only merge kinds the user actually supplied entries for — calling
  // mergeExtractedBible with an empty list still rebuilds the array and
  // re-stamps timestamps, churning the file write for no behavior change. An
  // arc-only import skips the updateUniverse round-trip entirely.
  const selectedKindMap = CANON_KIND_MAP
    .filter(([selectionKey]) => (canonSelections[selectionKey] || []).length > 0);
  const updatedUniverse = selectedKindMap.length > 0
    ? await updateUniverse(universe.id, (latest) => Object.fromEntries(
        selectedKindMap.map(([selectionKey, kind, storageKey]) => [
          storageKey,
          mergeExtractedBible(latest[storageKey] || [], canonSelections[selectionKey], kind, { source: 'imported' }),
        ]),
      ))
    : universe;

  // Bible top-level fields come from the extracted arc + the count of issues
  // being created — so a freshly-imported series doesn't show a blank bible.
  const sanitizedArc = sanitizeArc(arc);
  const arcLogline = sanitizedArc?.logline || '';
  const arcPremise = sanitizedArc?.summary || sanitizedArc?.protagonistArc || '';

  if (phase === IMPORT_PHASE.REPLACE) {
    // A user-confirmed full overwrite: null arc + empty seasons are clears (in
    // additive mode the same values mean "preserve"), and the bible fields are
    // written unconditionally, INCLUDING empty strings, so an import whose arc
    // lacks a logline/summary clears the prior work's bible rather than leaving
    // stale text beside the freshly-replaced arc + seasons.
    const updatedSeries = await updateSeries(series.id, {
      arc: sanitizedArc,
      seasons: sanitizeSeasonList(seasons),
      logline: arcLogline,
      premise: arcPremise,
      issueCountTarget: issueCount,
    });
    return { universe: updatedUniverse, series: updatedSeries };
  }

  // Returning null skips the write when there is nothing to change. Seasons are
  // only rebuilt when the caller sent some — otherwise an arc-only re-import
  // rewrites the array byte-for-byte identical, a wasted disk write.
  const updatedSeries = await updateSeries(series.id, (latest) => {
    const patch = {
      ...(sanitizedArc ? { arc: sanitizedArc } : {}),
      ...(seasons.length > 0
        ? { seasons: sanitizeSeasonList(mergeSeasons(Array.isArray(latest.seasons) ? latest.seasons : [], seasons)) }
        : {}),
      ...fillEmptySeriesBible(latest, { arcLogline, arcPremise, priorIssueCount, issueCount }),
    };
    return Object.keys(patch).length > 0 ? patch : null;
  });
  return { universe: updatedUniverse, series: updatedSeries };
}

// The stage seeds bundled into an issue's create payload, so the serialized
// write tail handles one write per issue instead of create +
// updateStage(prose) + updateStage(idea).
function buildIssueSeedStages(proposal, contentType) {
  const stages = {};
  if (proposal.proseExcerpt) {
    // Route the verbatim excerpt to the stage that matches the source form
    // (see CONTENT_TYPE_SEED_STAGE): a script-form type seeds its script stage
    // ready (comic-script → comicScript, screenplay → teleplay) so the pipeline
    // renders the user's verbatim script instead of regenerating it;
    // prose-like types seed stages.prose.
    stages[seedStageFor(contentType)] = { status: 'ready', output: proposal.proseExcerpt };
  }
  const ideaSeed = [
    proposal.logline && `Logline: ${proposal.logline}`,
    proposal.synopsis && `Synopsis: ${proposal.synopsis}`,
  ].filter(Boolean).join('\n\n');
  if (ideaSeed) {
    // `idea` is seeded with input only — the user/LLM still needs to run the
    // idea stage to produce `output`. `isStageReady` requires both
    // `status in {'ready','edited'}` AND non-empty output, so marking 'ready'
    // here would mislabel it to status-only consumers while failing readiness
    // predicates downstream. 'empty' matches the actual state.
    stages.idea = { status: 'empty', input: ideaSeed };
  }
  return stages;
}

/**
 * Plans every issue's identity, records the plan, creates the issues, and
 * writes the receipt. Canon, arc and seasons are already on disk.
 */
async function createPlannedIssues({
  importId, payloadHash, admission, issuesToCreate, contentType, universe, series,
}) {
  const { resumePlan, resumeLive } = admission;
  // seasonNumber → season-record map; missing seasonNumber falls through to
  // the LOWEST-NUMBERED season (not array-position [0]), or null when no
  // seasons exist. mergeSeasons returns `[...retained, ...incomingBuilt]` —
  // retained existing seasons come first regardless of number, so an import
  // that adds season 1 to a series already holding [2, 3] would otherwise
  // pick season 2 as "first" and surprise the user.
  const seasonByNumber = new Map();
  for (const s of (series.seasons || [])) {
    if (Number.isFinite(s.number)) seasonByNumber.set(s.number, s);
  }
  const sortedSeasons = [...(series.seasons || [])]
    .filter((s) => Number.isFinite(s.number))
    .sort((a, b) => a.number - b.number);
  const fallbackSeason = sortedSeasons[0] || null;
  const fallbackSeasonId = fallbackSeason?.id || null;

  // Plan every issue's identity BEFORE creating any (#10762): one stable id,
  // position and season per proposal. A replay recognizes these ids instead of
  // minting a second batch, and a planned id that never landed (or was rolled
  // back or deleted since) gets a fresh one here, so a stale tombstone is never
  // resurrected.
  const liveSeasonIds = new Set((series.seasons || []).map((s) => s.id));
  const remappedIssues = resumePlan ? [...resumePlan.remappedIssues] : [];
  const planItems = issuesToCreate.map((proposal, i) => {
    const prior = resumePlan?.items[i];
    if (prior) {
      if (resumeLive.has(prior.issueId)) return prior;
      const keepSeason = !prior.seasonId || liveSeasonIds.has(prior.seasonId);
      return { ...prior, issueId: `iss-${randomUUID()}`, seasonId: keepSeason ? prior.seasonId : fallbackSeasonId };
    }
    let seasonId = fallbackSeasonId;
    if (proposal.seasonNumber != null) {
      const matched = seasonByNumber.get(proposal.seasonNumber);
      if (matched) {
        seasonId = matched.id;
      } else {
        // Surface season-remap events so the UI can warn "issue 3 wanted season
        // 5 but landed in S2 — Diaspora." Each entry carries the actual landed
        // season's number + title so the client toast can be specific, not
        // just "first season" (which can lie when seasons are sparsely numbered).
        remappedIssues.push({
          title: proposal.title,
          arcPosition: proposal.arcPosition,
          requestedSeasonNumber: proposal.seasonNumber,
          actualSeasonId: fallbackSeasonId,
          actualSeasonNumber: fallbackSeason?.number ?? null,
          actualSeasonTitle: fallbackSeason?.title ?? null,
        });
      }
    }
    return { issueId: `iss-${randomUUID()}`, arcPosition: proposal.arcPosition, seasonId };
  });

  // Canon, arc and seasons are on disk; record that together with the plan
  // BEFORE the issue loop and let a failure here stop the commit: issues
  // created without a durable record of their ids are exactly what a retry
  // would duplicate.
  if (importId) {
    await recordImportProgress(importId, {
      universeId: universe.id,
      seriesId: series.id,
      status: SESSION_STATUS.ARC_PERSISTED,
      plan: { payloadHash, items: planItems, remappedIssues },
    });
  }

  // Issues this attempt wrote — the only ones a failure rolls back. Survivors
  // of an earlier attempt belong to the plan and keep any edits made since.
  const createdThisAttempt = [];

  // Thread C fix — issue-loop with rollback on failure. The universe + series
  // are already written. If an issue write throws mid-loop (e.g. transient FS
  // error) we delete what this attempt created and re-throw, leaving the
  // universe + series in their updated state. The universe + series writes are
  // kept because they represent user-confirmed data. With an importId the plan
  // stays on disk, so the retry recreates only what is missing under fresh
  // planned ids.
  try {
    for (let i = 0; i < issuesToCreate.length; i++) {
      const item = planItems[i];
      if (resumeLive.has(item.issueId)) continue;
      const proposal = issuesToCreate[i];
      // The series admission keeps other imports out, but not an ordinary
      // issue create; ensureIssueWithId re-checks the planned position against
      // the live issues inside the series write queue and refuses one taken
      // since the inventory read (#10763), so the race fails here loudly and
      // rolls back instead of landing a duplicate position.
      const { created } = await ensureIssueWithId(item.issueId, {
        seriesId: series.id,
        title: proposal.title,
        seasonId: item.seasonId,
        arcPosition: item.arcPosition,
        arcRole: proposal.arcRole,
        stages: buildIssueSeedStages(proposal, contentType),
      });
      if (created) createdThisAttempt.push(item.issueId);
    }
  } catch (issueErr) {
    // Roll back what this attempt created. A delete that fails leaves its
    // issue in place: it is reported by id rather than claimed as removed,
    // and with an importId the plan still owns it, so the retry keeps it.
    const survivingIssueIds = [];
    for (const id of createdThisAttempt) {
      await deleteIssue(id).catch((delErr) => {
        console.error(`❌ commitImport rollback: failed to delete issue ${id}: ${delErr.message}`);
        survivingIssueIds.push(id);
      });
    }
    const n = issuesToCreate.length;
    const rolledBack = createdThisAttempt.length - survivingIssueIds.length;
    const plural = (k) => `${k} issue${k === 1 ? '' : 's'}`;
    const notes = [`${plural(rolledBack)} created by this attempt ${rolledBack === 1 ? 'was' : 'were'} rolled back.`];
    if (survivingIssueIds.length > 0) {
      const one = survivingIssueIds.length === 1;
      notes.push(`${plural(survivingIssueIds.length)} could not be removed (${survivingIssueIds.join(', ')}) and ${one ? 'remains' : 'remain'} ${importId
        ? `part of this import — a retry keeps ${one ? 'it' : 'them'} instead of creating a duplicate.`
        : 'in the series.'}`);
    }
    if (resumeLive.size > 0) notes.push(`${plural(resumeLive.size)} from an earlier attempt ${resumeLive.size === 1 ? 'is' : 'are'} kept.`);
    // `context.arcAlreadyPersisted` tells the client to drop arc + seasons +
    // canon from the retry payload — otherwise the retry overwrites any edits
    // (parallel tab, collaborator) made to the persisted state after the
    // failure. `skipArcOnRetry` is the imperative form of the same signal.
    throw Object.assign(
      new Error(
        `The universe and series were updated successfully, but creating ${n === 1 ? 'the issue' : `the ${n} issues`} failed. ${notes.join(' ')} Retry to create the remaining issues. (Original error: ${issueErr.message})`,
      ),
      {
        code: ERR_PARTIAL_COMMIT_ISSUES,
        context: {
          universeId: universe.id,
          seriesId: series.id,
          arcAlreadyPersisted: true,
          skipArcOnRetry: true,
          survivingIssueIds,
        },
      },
    );
  }

  // Done after the issue loop so a rolled-back commit leaves the draft shells
  // GC-eligible.
  const promoted = await promoteImportDrafts(universe, series);

  const createdIssueIds = planItems.map((item) => item.issueId);
  if (importId) await recordCommittedReceipt(importId, createdIssueIds, remappedIssues);

  return {
    universe: promoted.universe,
    series: promoted.series,
    createdIssueIds,
    remappedIssues,
  };
}

// Validates and plans the commit against fresh state, then writes it. Runs
// inside the series admission, except for the `precheck` pass (a fail-fast
// before formatting, which writes nothing): that returns `{ replay: true }`
// for an import already committed, else `{ pendingProposals }` — the excerpts
// the formatting pass should clean. `formattedExcerpts[i]` (from that pass)
// replaces proposal i's excerpt when it is still to be created.
//
// Payload fields: `canonSelections`, `arc`, `seasons`, `issues`; `contentType`
// drives which stage each issue's verbatim excerpt seeds (absent →
// prose-seed); `replaceMode` is the destructive replace — it wipes existing
// issues and overwrites arc + seasons (default false).
async function admitAndCommit(payload = {}, { precheck = false, formattedExcerpts = null } = {}) {
  const { universeId, seriesId, importId = null, issues = [], contentType = null, replaceMode = false } = payload;
  // Read for validation (universeId/seriesId linkage, lock checks, the
  // arcPosition/season-number gates) and for the up-front counts used to size
  // auto-assigned positions and the additive issue-count target. Not the
  // source of truth the universe/series writes merge against (#8453) — see
  // applyImportedCanon.
  const universe = await getUniverse(universeId);
  const series = await getSeries(seriesId);

  // Defensive: refuse commit when series.universeId is set AND differs,
  // OR when series.universeId is missing entirely. A legacy series
  // persisted before universeId became standard would otherwise silently
  // be re-homed to whichever universe the caller routed through. createSeries
  // sets universeId today, so a missing value implies hand-edited / pre-link
  // legacy data — flag it so the caller decides rather than silently linking.
  if (series.universeId !== universe.id) {
    if (series.universeId) {
      throw codedError(
        `Series "${series.name}" is linked to a different universe — commit refused to avoid cross-linking.`,
        ERR_VALIDATION,
      );
    }
    throw codedError(
      `Series "${series.name}" has no universeId — commit refused. Link the series to a universe explicitly before importing.`,
      ERR_VALIDATION,
    );
  }

  const payloadHash = hashIssuePayload(issues, contentType);
  const admission = await resolveImportAdmission({ importId, replaceMode, precheck, series, payloadHash });
  // A replay is answered before the locked-arc gate: nothing new is written,
  // so a lock added since the commit cannot turn a recorded success into an
  // error.
  if (admission.phase === IMPORT_PHASE.REPLAY_PRECHECK) return { replay: true };
  if (admission.phase === IMPORT_PHASE.REPLAY) return replayCommittedImport(importId, admission, { universe, series });

  if (series.locked?.arc === true) {
    throw codedError(
      `Series "${series.name}" has a locked arc — commit refused. Unlock the arc to import.`,
      ERR_LOCKED,
    );
  }

  // The server kept canon/arc/seasons from an attempt whose issues did not
  // finish. Resending them would overwrite edits made since, so the server
  // drops them itself rather than trusting the client to have remembered.
  const { canonSelections = {}, arc = null, seasons = [] } = admission.arcPersisted ? {} : payload;

  const explicitPositions = rejectInvalidIssueProposals(issues);
  const existingIssues = await listIssues({ seriesId: series.id });
  const issuesWithPositions = assignIssuePositions(admission, issues, existingIssues, explicitPositions);
  rejectInvalidSeasons(seasons);

  // Optional AI cleanup of the seeded excerpts (issue #1335) runs between the
  // precheck pass and admission (see commitImportOnce): AFTER all the cheap
  // fail-fast validation above (so a bad payload never burns LLM calls) but
  // BEFORE any destructive write. Best-effort — `reformatSeededExcerpts` falls
  // back to the verbatim excerpt per issue, so import never breaks.
  // A resume only reformats the issues it still has to create — the excerpt is
  // dropped from a surviving one so it costs no LLM call (it is never re-written).
  const { resumePlan, resumeLive } = admission;
  const pendingProposals = resumePlan
    ? issuesWithPositions.map((proposal, i) => (resumeLive.has(resumePlan.items[i].issueId)
      ? { ...proposal, proseExcerpt: undefined }
      : proposal))
    : issuesWithPositions;
  if (precheck) return { pendingProposals };
  // An issue that became pending only since the precheck (a survivor deleted in
  // between) has no cleaned excerpt and keeps its verbatim one.
  const issuesToCreate = formattedExcerpts
    ? pendingProposals.map((proposal, i) => (proposal.proseExcerpt && isStr(formattedExcerpts[i])
      ? { ...proposal, proseExcerpt: formattedExcerpts[i] }
      : proposal))
    : pendingProposals;

  if (admission.phase === IMPORT_PHASE.REPLACE) await deleteIssuesForReplace(existingIssues);

  const records = await applyImportedCanon({
    phase: admission.phase,
    universe,
    series,
    canonSelections,
    arc,
    seasons,
    // Issues already on the series that this import does not own — the base
    // for the additive issue-count target.
    priorIssueCount: existingIssues.filter((ex) => !resumeLive.has(ex.id)).length,
    issueCount: issuesWithPositions.length,
  });

  return createPlannedIssues({
    importId, payloadHash, admission, issuesToCreate, contentType, ...records,
  });
}
