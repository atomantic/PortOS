/**
 * Pipeline — Manuscript Fix generation + accept
 *
 * Turns a "Finish the draft" comment into a surgical, anchored edit. The LLM
 * returns `{ find, replace }` where `find` is a verbatim excerpt of the issue's
 * drafted stage text and `replace` is that excerpt rewritten to close the gap.
 * The user can edit `replace` before accepting; accept applies the find/replace
 * to the issue's stage output through the serialized stage-write path (which
 * snapshots the prior text into runHistory).
 *
 * Read this alongside manuscriptReview.js (where the comment + fix persist) and
 * arcPlanner.js (which owns the completeness pass that creates the comments).
 */

import { randomUUID } from 'crypto';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { getSeries, MANUSCRIPT_TYPES } from './series.js';
import { getIssue, updateStageWithLatest } from './issues.js';
import { collectManuscriptSections, stageVersionsOf } from './arcPlanner.js';
import { getComment, updateComment } from './manuscriptReview.js';

export const ERR_VALIDATION = 'PIPELINE_MANUSCRIPT_FIX_VALIDATION';
export const ERR_NOT_FOUND = 'PIPELINE_MANUSCRIPT_FIX_NOT_FOUND';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Output before input: the drafted artifact wins over the upstream seed.
// Mirrors arcPlanner's stageTextOf (inlined there to avoid an import cycle).
const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

// Resolve which issue+stage a comment edits. Prefer the ids stored on the
// comment at seed time; fall back to matching issueNumber against the current
// manuscript sections (the manuscript may have grown since the comment was
// created). Returns { issueId, stageId } or throws ERR_VALIDATION.
async function resolveTarget(seriesId, comment) {
  if (comment.issueId && comment.stageId) {
    return { issueId: comment.issueId, stageId: comment.stageId };
  }
  const sections = await collectManuscriptSections(seriesId);
  const section = comment.issueNumber != null
    ? sections.find((s) => s.number === comment.issueNumber)
    : null;
  if (!section) {
    throw makeErr(
      'This comment is not anchored to a specific issue — edit the manuscript directly to address it',
      ERR_VALIDATION,
    );
  }
  return { issueId: section.issueId, stageId: section.stageId };
}

async function loadStageText(issueId, stageId) {
  const issue = await getIssue(issueId).catch(() => null);
  if (!issue) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
  return stageTextOf(issue.stages?.[stageId]);
}

// Locate the `find` span to replace. `indexOf` alone edits the FIRST match,
// which silently corrupts the wrong spot when `find` recurs in the issue. When
// it's ambiguous, disambiguate by the finding's `anchorQuote` — pick the
// occurrence nearest the anchor — so the edit lands where the comment points.
// Returns the start index, or -1 if `find` isn't present at all.
function locateFind(text, find, anchorQuote) {
  const first = text.indexOf(find);
  if (first === -1) return -1;
  if (text.indexOf(find, first + 1) === -1) return first; // unique — no ambiguity
  const anchorIdx = anchorQuote ? text.indexOf(anchorQuote) : -1;
  if (anchorIdx === -1) return first; // can't disambiguate — first match
  let best = first;
  let bestDist = Math.abs(first - anchorIdx);
  for (let i = text.indexOf(find, first + 1); i !== -1; i = text.indexOf(find, i + 1)) {
    const dist = Math.abs(i - anchorIdx);
    if (dist < bestDist) { best = i; bestDist = dist; }
  }
  return best;
}

// Shape one manuscript section response from a freshly-written stage.
const sectionFrom = (issue, stageId, stage) => ({
  issueId: issue.id,
  number: issue.number,
  title: issue.title || '',
  stageId,
  content: stageTextOf(stage),
  versions: stageVersionsOf(stage),
});

/**
 * Free-text manuscript edit, versioned. Writes `output` to the issue's stage and
 * snapshots the PRIOR text into runHistory (via `snapshotPrior`) so every saved
 * edit is revertible — including the first edit of an imported stage that never
 * had a run id. A fresh `lastRunId` makes the new version itself restorable.
 */
export async function saveManuscriptSection(seriesId, { issueId, stageId, output } = {}) {
  if (!MANUSCRIPT_TYPES.includes(stageId)) {
    throw makeErr(`Not an editable manuscript stage: ${stageId}`, ERR_VALIDATION);
  }
  const { issue, stage } = await updateStageWithLatest(
    issueId,
    stageId,
    () => ({ output, status: 'edited', lastRunId: `edit-${randomUUID()}` }),
    { snapshotPrior: true },
  );
  return { section: sectionFrom(issue, stageId, stage) };
}

/**
 * Generate an anchored find/replace fix for a comment and persist it on the
 * comment (status stays `open` — the user still has to accept). When the LLM's
 * `find` can't be located verbatim in the current stage text, the fix is
 * flagged `fuzzy: true` so the client falls back to manual editing rather than
 * a write that would silently miss.
 */
export async function generateManuscriptFix(seriesId, { commentId, providerOverride, modelOverride } = {}) {
  const series = await getSeries(seriesId);
  const comment = await getComment(seriesId, commentId);
  if (!comment) throw makeErr(`Comment not found: ${commentId}`, ERR_NOT_FOUND);

  const { issueId, stageId } = await resolveTarget(seriesId, comment);
  const manuscript = await loadStageText(issueId, stageId);
  if (!manuscript) {
    throw makeErr('That issue has no drafted text to edit', ERR_VALIDATION);
  }

  const arc = series.arc || {};
  const ctx = {
    series: { name: series.name, logline: series.logline, premise: series.premise },
    arc: {
      logline: arc.logline || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
    },
    manuscript,
    finding: {
      category: comment.category,
      severity: comment.severity,
      problem: comment.problem,
      suggestion: comment.suggestion,
      anchorQuote: comment.anchorQuote,
    },
  };

  const { content, runId } = await runStagedLLM('pipeline-manuscript-fix', ctx, {
    providerOverride,
    modelOverride,
    returnsJson: true,
    source: 'pipeline-manuscript-fix',
  });

  const find = typeof content?.find === 'string' ? content.find : '';
  const replace = typeof content?.replace === 'string' ? content.replace : '';
  // The accept path locates the edit by `find` (schema requires it non-empty),
  // and the UI only lets the user edit `replace` — so a fix missing `find`
  // would be shown but could never be applied. Reject it as unusable.
  if (!find || !replace) throw makeErr('The model did not return a usable fix — try again', ERR_VALIDATION);
  const fix = { find, replace };
  // A `find` that isn't present verbatim can't be applied surgically; mark it
  // so the UI offers manual editing instead of a no-op accept.
  if (find && !manuscript.includes(find)) fix.fuzzy = true;

  const updated = await updateComment(seriesId, commentId, { fix });
  return { comment: updated, fix, runId };
}

/**
 * Apply an (optionally user-edited) find/replace to the issue's stage output and
 * mark the comment accepted. Serialized through `updateStageWithLatest`, which
 * snapshots the prior output into runHistory when a fresh run id is stamped.
 * Returns the refreshed manuscript section + the accepted comment.
 */
export async function acceptManuscriptFix(seriesId, { commentId, find, replace } = {}) {
  const comment = await getComment(seriesId, commentId);
  if (!comment) throw makeErr(`Comment not found: ${commentId}`, ERR_NOT_FOUND);
  const { issueId, stageId } = await resolveTarget(seriesId, comment);

  const { issue, stage } = await updateStageWithLatest(issueId, stageId, (cur) => {
    const text = stageTextOf(cur);
    const idx = locateFind(text, find, comment.anchorQuote);
    if (idx === -1) {
      throw makeErr('Anchor text is no longer present in the manuscript — regenerate the fix', ERR_VALIDATION);
    }
    const next = text.slice(0, idx) + replace + text.slice(idx + find.length);
    // Fresh run id + snapshotPrior so the pre-fix text is preserved in history
    // and this accepted version is itself revertible later.
    return { output: next, status: 'edited', lastRunId: `fix-${randomUUID()}` };
  }, { snapshotPrior: true });

  const updated = await updateComment(seriesId, commentId, { status: 'accepted' });
  return { comment: updated, section: sectionFrom(issue, stageId, stage) };
}
