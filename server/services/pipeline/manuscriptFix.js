/**
 * Pipeline — Manuscript Fix generation + accept
 *
 * Turns a "Finish the draft" comment into one or more anchored edits. The LLM
 * returns `{ edits: [{ issueNumber, find, replace }] }` where each `find` is a
 * verbatim excerpt of an issue's drafted stage text and `replace` is that
 * excerpt rewritten to close the gap. The user can edit or skip each suggested
 * replacement before accepting; accept applies the selected edits through the
 * serialized stage-write path (which snapshots the prior text into runHistory).
 *
 * Read this alongside manuscriptReview.js (where the comment + fix persist) and
 * arcPlanner.js (which owns the completeness pass that creates the comments).
 */

import { randomUUID } from 'crypto';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { getSeries, MANUSCRIPT_TYPES } from './series.js';
import { getIssue, updateStageWithLatest, updateStagesWithLatest } from './issues.js';
import { collectManuscriptSections, stageVersionsOf } from './arcPlanner.js';
import { getComment, updateComment } from './manuscriptReview.js';

export const ERR_VALIDATION = 'PIPELINE_MANUSCRIPT_FIX_VALIDATION';
export const ERR_NOT_FOUND = 'PIPELINE_MANUSCRIPT_FIX_NOT_FOUND';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

// Output before input: the drafted artifact wins over the upstream seed.
// Mirrors arcPlanner's stageTextOf (inlined there to avoid an import cycle).
const stageTextOf = (stage) => (stage?.output?.trim() || stage?.input?.trim() || '');

async function loadStageText(issueId, stageId) {
  const issue = await getIssue(issueId).catch(() => null);
  if (!issue) throw makeErr(`Issue not found: ${issueId}`, ERR_NOT_FOUND);
  return stageTextOf(issue.stages?.[stageId]);
}

const manuscriptSectionHeader = (s) => `# Issue ${s.number}${s.title ? ` — ${s.title}` : ''} (${s.stageId})`;

function manuscriptTextOf(sections) {
  return sections
    .map((s) => `${manuscriptSectionHeader(s)}\n\n${s.content || ''}`)
    .join('\n\n---\n\n');
}

function sectionLabel(s) {
  return `Issue ${s.number}${s.title ? ` — ${s.title}` : ''}`;
}

// Resolve the manuscript sections a comment may edit. Narrow comments still
// get their one issue, while unanchored or story-level comments get the whole
// drafted manuscript so the model can produce multiple concrete insertions.
async function resolveTargets(seriesId, comment) {
  const sections = await collectManuscriptSections(seriesId);
  if (comment.issueId && comment.stageId) {
    const current = sections.find((s) => s.issueId === comment.issueId && s.stageId === comment.stageId);
    if (current) return [current];
    return [{
      issueId: comment.issueId,
      stageId: comment.stageId,
      number: comment.issueNumber,
      title: '',
      content: await loadStageText(comment.issueId, comment.stageId),
    }];
  }
  if (comment.issueNumber != null) {
    const section = sections.find((s) => s.number === comment.issueNumber);
    if (section) return [section];
    throw makeErr(
      'This comment points to an issue that no longer has drafted manuscript text — regenerate the editorial review',
      ERR_VALIDATION,
    );
  }
  if (sections.length) return sections;
  throw makeErr('No drafted manuscript text is available to edit', ERR_VALIDATION);
}

function normalizeModelEdits(content) {
  if (Array.isArray(content?.edits)) return content.edits;
  if (typeof content?.find === 'string' || typeof content?.replace === 'string') {
    return [{ find: content.find || '', replace: content.replace || '' }];
  }
  return [];
}

function resolveEditSection(raw, targets) {
  const issueNumber = Number.isInteger(raw?.issueNumber) ? raw.issueNumber : null;
  if (issueNumber != null) {
    const byNumber = targets.find((s) => s.number === issueNumber);
    if (byNumber) return byNumber;
  }
  if (targets.length === 1) return targets[0];
  const find = typeof raw?.find === 'string' ? raw.find : '';
  if (find) {
    const matches = targets.filter((s) => (s.content || '').includes(find));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function normalizeFix(content, targets) {
  const edits = normalizeModelEdits(content)
    .map((raw) => {
      const find = typeof raw?.find === 'string' ? raw.find : '';
      const replace = typeof raw?.replace === 'string' ? raw.replace : '';
      if (!find || !replace) return null;
      const section = resolveEditSection(raw, targets);
      if (!section) return null;
      const edit = {
        issueNumber: section.number,
        issueId: section.issueId,
        stageId: section.stageId,
        title: section.title || '',
        find,
        replace,
      };
      if (typeof raw.note === 'string' && raw.note.trim()) edit.note = raw.note.trim().slice(0, 1000);
      if (!(section.content || '').includes(find)) edit.fuzzy = true;
      return edit;
    })
    .filter(Boolean);
  if (edits.length === 0) return null;
  const fix = { edits };
  if (edits.length === 1) {
    fix.find = edits[0].find;
    fix.replace = edits[0].replace;
    if (edits[0].fuzzy) fix.fuzzy = true;
  }
  return fix;
}

function editsFromAcceptRequest({ comment, find, replace, edits }) {
  if (Array.isArray(edits) && edits.length) {
    return edits.map((e) => ({
      issueId: typeof e.issueId === 'string' ? e.issueId : null,
      stageId: typeof e.stageId === 'string' ? e.stageId : null,
      issueNumber: Number.isInteger(e.issueNumber) ? e.issueNumber : null,
      find: typeof e.find === 'string' ? e.find : '',
      replace: typeof e.replace === 'string' ? e.replace : '',
    })).filter((e) => e.find);
  }
  if (find) {
    if (typeof replace !== 'string') {
      throw makeErr('replace is required when find is provided', ERR_VALIDATION);
    }
    return [{
      issueId: comment.issueId,
      stageId: comment.stageId,
      issueNumber: comment.issueNumber,
      find,
      replace,
    }];
  }
  return [];
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

async function resolveMissingEditTargets(seriesId, comment, edits) {
  const targets = await resolveTargets(seriesId, comment);
  const targetByKey = new Map(targets.map((s) => [`${s.issueId}:${s.stageId}`, s]));
  return edits.map((edit) => {
    const hasExplicitTarget = edit.issueId && edit.stageId;
    const section = hasExplicitTarget ? targetByKey.get(`${edit.issueId}:${edit.stageId}`) : resolveEditSection(edit, targets);
    if (hasExplicitTarget && !section) return { ...edit, issueId: null, stageId: null };
    return section
      ? { ...edit, issueId: section.issueId, stageId: section.stageId, issueNumber: section.number }
      : edit;
  });
}

async function planEditsBySection(edits, comment) {
  const groups = new Map();
  for (const edit of edits) {
    const key = `${edit.issueId}:${edit.stageId}`;
    if (!groups.has(key)) groups.set(key, { issueId: edit.issueId, stageId: edit.stageId, edits: [] });
    groups.get(key).edits.push(edit);
  }

  const planned = [];
  for (const group of groups.values()) {
    const issue = await getIssue(group.issueId).catch(() => null);
    if (!issue) throw makeErr(`Issue not found: ${group.issueId}`, ERR_NOT_FOUND);
    const originalText = stageTextOf(issue.stages?.[group.stageId]);
    const spans = [];
    for (const edit of group.edits) {
      const idx = locateFind(originalText, edit.find, comment.anchorQuote);
      if (idx === -1) {
        throw makeErr('Anchor text is no longer present in the manuscript — regenerate the fix', ERR_VALIDATION);
      }
      const span = { start: idx, end: idx + edit.find.length, replace: edit.replace };
      if (spans.some((other) => span.start < other.end && other.start < span.end)) {
        throw makeErr('Selected edits overlap in the manuscript — regenerate the fix', ERR_VALIDATION);
      }
      spans.push(span);
    }
    let output = originalText;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      output = output.slice(0, span.start) + span.replace + output.slice(span.end);
    }
    planned.push({ ...group, originalText, output });
  }
  return planned;
}

async function applyPlannedEdits(seriesId, planned) {
  const sections = [];
  const updates = planned.map((group) => ({
    issueId: group.issueId,
    stageId: group.stageId,
    computeFn: (cur) => {
      if (stageTextOf(cur) !== group.originalText) {
        throw makeErr('Manuscript changed while applying the fix — regenerate the fix', ERR_VALIDATION);
      }
      return { output: group.output, status: 'edited', lastRunId: `fix-${randomUUID()}` };
    },
  }));
  const updated = await updateStagesWithLatest(seriesId, updates, { snapshotPrior: true });
  for (let i = 0; i < updated.length; i += 1) {
    const group = planned[i];
    const { issue, stage } = updated[i];
    sections.push(sectionFrom(issue, group.stageId, stage));
  }
  return sections;
}

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
 * Generate anchored fix edits for a comment and persist them on the comment
 * (status stays `open` — the user still has to accept). When an edit's `find`
 * can't be located verbatim in the current stage text, that edit is flagged
 * `fuzzy: true` so the client can warn before apply.
 */
export async function generateManuscriptFix(seriesId, { commentId, providerOverride, modelOverride } = {}) {
  const series = await getSeries(seriesId);
  const comment = await getComment(seriesId, commentId);
  if (!comment) throw makeErr(`Comment not found: ${commentId}`, ERR_NOT_FOUND);

  const targets = await resolveTargets(seriesId, comment);
  if (targets.every((s) => !s.content)) {
    throw makeErr('There is no drafted text to edit', ERR_VALIDATION);
  }

  const arc = series.arc || {};
  const manuscript = manuscriptTextOf(targets);
  const ctx = {
    series: { name: series.name, logline: series.logline, premise: series.premise },
    arc: {
      logline: arc.logline || '',
      themesCsv: Array.isArray(arc.themes) ? arc.themes.join(', ') : '',
    },
    scope: targets.length === 1 ? sectionLabel(targets[0]) : 'Full manuscript',
    sections: targets.map((s) => ({
      issueNumber: s.number,
      title: s.title || '',
      stageId: s.stageId,
      manuscript: s.content || '',
    })),
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

  const fix = normalizeFix(content, targets);
  if (!fix) throw makeErr('The model did not return a usable fix — try again', ERR_VALIDATION);

  const updated = await updateComment(seriesId, commentId, { fix });
  return { comment: updated, fix, runId };
}

/**
 * Apply selected, optionally user-edited fix edits to manuscript stage output
 * and mark the comment accepted. Serialized through `updateStageWithLatest`,
 * which snapshots the prior output into runHistory when a fresh run id is
 * stamped. Returns refreshed manuscript sections + the accepted comment.
 */
export async function acceptManuscriptFix(seriesId, { commentId, find, replace, edits } = {}) {
  const comment = await getComment(seriesId, commentId);
  if (!comment) throw makeErr(`Comment not found: ${commentId}`, ERR_NOT_FOUND);
  const acceptedEdits = await resolveMissingEditTargets(
    seriesId,
    comment,
    editsFromAcceptRequest({ comment, find, replace, edits }),
  );
  if (acceptedEdits.length === 0) {
    throw makeErr('No applicable edits were selected', ERR_VALIDATION);
  }
  if (acceptedEdits.some((e) => !e.issueId || !e.stageId || !e.find)) {
    throw makeErr('One selected edit is not anchored to a manuscript section — regenerate the fix', ERR_VALIDATION);
  }

  const planned = await planEditsBySection(acceptedEdits, comment);
  const sections = await applyPlannedEdits(seriesId, planned);
  const updated = await updateComment(seriesId, commentId, { status: 'accepted' });
  return { comment: updated, section: sections[0] || null, sections };
}
