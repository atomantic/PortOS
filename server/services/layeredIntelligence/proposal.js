/**
 * Layered Intelligence — reasoner-output validation & hand-off shaping
 * (#2842 split of layeredIntelligence.js).
 *
 * Validates the model's JSON into an `{ analysis, proposal, pause, invalidFields }`
 * result (the usable triple plus the malformed-field report, #4166), resolves
 * the pause target, and decides whether/how a filed proposal becomes an autonomous
 * CoS hand-off task. Also the tracker→filer dispatch table.
 */

import { normalizeDispatchEffort, normalizeDispatchModel, normalizeIssueHardwareRequirements, HELP_WANTED_NON_REQUIREMENT_REASONS } from '../../lib/dispatchLabels.js';
import { PROPOSAL_SCOPES, PROPOSAL_COMPLEXITIES, HANDOFF_COMPLEXITY } from './constants.js';
import { normalizeSlug } from './dedup.js';

/**
 * Validate + normalize the reasoner's JSON. Returns
 * `{ analysis, proposal, pause, invalidFields }` with invalid pieces dropped
 * (never throws):
 *   - `analysis` kept only when it is a string.
 *   - `proposal` kept only when it has a recognized scope + a normalizable slug
 *     + a non-empty title. `slug` is normalized in place.
 *   - `pause` kept only when it has a reason AND a resolvable target: an integer
 *     issue number, or `"this"` WITH a surviving proposal to block on. A
 *     `pause.blockOnIssue: "this"` with a null proposal is invalid → dropped.
 *
 * `invalidFields` (#4166) names every envelope key that was SUPPLIED (present and
 * non-null) but could not be used — the sentinel that separates "the reasoner
 * emitted the wrong shape" from "the reasoner had nothing to say". Dropping is
 * still lenient (callers that only want the usable pieces can ignore it), but a
 * caller deciding whether a run was malformed must not have to re-derive per-field
 * validity: `{"analysis": 7}` reads as a legitimate empty answer without this.
 * `null`/`undefined` is ABSENT, not wrong-typed — an explicit `proposal: null` is
 * the documented "nothing to propose" answer and never lands here. Deliberately
 * ONLY `null`: the prompt documents `null` for "not proposing"/"not pausing", so a
 * model emitting `false` or `"none"` instead is a wrong-typed field and is reported
 * (this already matched the pre-#4166 treatment of a `false` proposal).
 */
export function validateReasonerResponse(parsed) {
  const out = { analysis: '', proposal: null, pause: null, invalidFields: [] };
  if (!parsed || typeof parsed !== 'object') return out;
  if (typeof parsed.analysis === 'string') out.analysis = parsed.analysis;
  else if (parsed.analysis != null) out.invalidFields.push('analysis');

  const p = parsed.proposal;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const hardwareRequirements = normalizeIssueHardwareRequirements(p.hardwareRequirements, p);
    const slug = normalizeSlug(p.slug);
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (PROPOSAL_SCOPES.includes(p.scope) && slug && title && hardwareRequirements) {
      out.proposal = {
        scope: p.scope,
        slug,
        title,
        body: typeof p.body === 'string' ? p.body : '',
        value: typeof p.value === 'string' ? p.value : '',
        // Hand-off signals. `complexity` normalizes to a known level or null
        // (unknown → never trivial → never auto-handed-off); `safe` is a strict
        // boolean so only an explicit `true` opens the hand-off path.
        complexity: PROPOSAL_COMPLEXITIES.includes(p.complexity) ? p.complexity : null,
        safe: p.safe === true,
        // Optional slashdo dispatch hints — independent of each other AND of
        // `complexity`. Unknown / absent → omit the axis (null), never invent
        // a default and never copy complexity onto them.
        model: normalizeDispatchModel(p.model),
        effort: normalizeDispatchEffort(p.effort),
        // Contributor labels. Strict boolean like `safe` — only explicit true
        // applies. Independent of model:light (a wide mechanical sweep is not
        // a good first issue).
        goodFirstIssue: p.goodFirstIssue === true,
        helpWanted: p.helpWanted === true,
        hardwareRequirements,
        helpWantedReason: HELP_WANTED_NON_REQUIREMENT_REASONS.includes(p.helpWantedReason) ? p.helpWantedReason : null
      };
    }
  }
  if (p != null && !out.proposal) out.invalidFields.push('proposal');

  const pause = parsed.pause;
  // A well-formed `blockOnIssue: "this"` pause is dropped as COLLATERAL when the
  // proposal it pointed at was itself supplied-but-invalid. The pause isn't the
  // malformed part, so it doesn't earn its own `invalidFields` entry — one root
  // cause, one report. With no proposal supplied at all, `"this"` points at nothing
  // and the pause IS malformed. Either way `invalidFields` is already non-empty, so
  // this only sharpens the report, never the malformed/clean verdict.
  let pauseCollateral = false;
  if (pause && typeof pause === 'object' && !Array.isArray(pause)) {
    const reason = typeof pause.reason === 'string' ? pause.reason.trim() : '';
    const target = pause.blockOnIssue;
    const isThis = target === 'this';
    const num = Number.isInteger(target) ? target : (typeof target === 'string' && /^\d+$/.test(target) ? Number(target) : null);
    // "this" requires a surviving proposal to block on; else an explicit issue number.
    if (reason && ((isThis && out.proposal) || num)) {
      out.pause = { blockOnIssue: isThis ? 'this' : num, reason };
    } else if (reason && isThis) {
      pauseCollateral = out.invalidFields.includes('proposal');
    }
  }
  if (pause != null && !out.pause && !pauseCollateral) out.invalidFields.push('pause');

  return out;
}

/**
 * Resolve `pause.blockOnIssue` to a concrete issue number. `"this"` maps to the
 * number of the issue just filed from the proposal; an integer passes through.
 * Returns null when it can't resolve (e.g. `"this"` but nothing was filed).
 */
export function resolveBlockOnIssue(pause, filedIssueNumber) {
  if (!pause) return null;
  if (pause.blockOnIssue === 'this') return filedIssueNumber ?? null;
  return Number.isInteger(pause.blockOnIssue) ? pause.blockOnIssue : null;
}

/**
 * Whether a filed proposal qualifies for the optional Engine-A hand-off — i.e.
 * the loop should enqueue a coding agent to implement it now, not just file it.
 * Requires ALL of: hand-off enabled in the app's config, an issue actually filed
 * (a concrete `filed` ref for the agent to work), and the reasoner marking the
 * proposal both trivial AND safe. Any missing/false signal falls through to
 * file-only. Pure — the handler feeds it the filed ref.
 */
export function isHandoffEligible({ proposal, config, filed } = {}) {
  if (filed == null || filed === '' || filed === false) return false;
  if (!config?.handoff?.enabled) return false;
  if (!proposal || typeof proposal !== 'object') return false;
  return proposal.complexity === HANDOFF_COMPLEXITY && proposal.safe === true;
}

/**
 * Build the CoS task payload that hands a filed proposal to an Engine-A coding
 * agent. Deterministic (no I/O) so it's unit-tested; the handler passes the
 * result to `addTask(..., 'internal')`. The task is APPROVAL-GATED — an agent
 * writing code straight from the loop shouldn't run unattended (mirrors
 * autoFixer's every code-editing task). The description leads with a stable
 * `LI hand-off:` prefix so addTask's per-app dedup suppresses a re-enqueue while
 * the same proposal's task is still pending/in-flight.
 */
export function buildHandoffTask({ app, proposal, issueRef, recordExecution = false } = {}) {
  const ref = typeof issueRef === 'number' ? `#${issueRef}` : String(issueRef ?? '').trim();
  const context = [
    '# Layered Intelligence hand-off',
    '',
    `The Layered Intelligence loop identified a TRIVIAL, SAFE improvement for **${app?.name || app?.id || 'this app'}** and filed it as ${ref}.`,
    '',
    '## Task',
    `Implement the change described in ${ref} end-to-end: read the issue, make the fix, run the app's tests, and open a PR that closes ${ref}.`,
    'If — once you dig in — the change turns out to be non-trivial or carries any regression/data-loss risk, STOP and leave a comment on the issue explaining why instead of forcing it. Filing was the safe fallback; a half-done risky change is worse than none.',
    '',
    '## Proposal',
    `- **Title:** ${proposal?.title || ''}`,
    `- **Value:** ${proposal?.value || '(not provided)'}`,
    '',
    proposal?.body || ''
  ].join('\n');
  const task = {
    description: `LI hand-off: ${proposal?.title || ref}`,
    priority: 'MEDIUM',
    context,
    app: app?.id,
    approvalRequired: true
  };
  // Per-proposal-domain execution tracking (#2765): stamp the proposal's identity +
  // domain onto the task so, when this agent run completes, recordTaskCompletion can
  // attribute the execution success/failure back to the proposal's DOMAIN (not the
  // generic `internal-task` bucket this hand-off would otherwise land in). addTask
  // allowlists this top-level field into `metadata.liProposal`, and registerAgent
  // projects it onto `agent.metadata.taskLiProposal`. Kept a dedicated key (not any of
  // the extractTaskType-recognized metadata fields) so it never reclassifies the task's
  // own byTaskType bucket.
  //
  // Gated on `recordExecution` — the caller passes true ONLY when the outcomes source is
  // on AND the tracker is outcomes-capable, the SAME gate that governs recordFiledProposal.
  // Without this, a hand-off filed while outcomes-tracking is OFF would still carry the
  // marker, and recordProposalExecution's missing-record fallback would create an outcome
  // row — recording a proposal the source toggle says isn't tracked (codex P2). Omitting
  // the marker keeps filing and execution-recording consistent with the one toggle.
  if (recordExecution) {
    task.liProposal = {
      appId: app?.id ?? null,
      slug: proposal?.slug ?? null,
      scope: proposal?.scope ?? null
    };
  }
  return task;
}

/**
 * Which filing path a resolved work tracker uses. Branches the handler up front
 * so a `plan` app never hits the forge-only label/issue paths.
 *   github / gitlab → 'forge'   (gh / glab issue create + labels)
 *   jira            → 'jira'     (createTicket + description slug marker)
 *   plan (fallback) → 'plan'     (append slug-tagged PLAN.md checklist item)
 */
export function filerForTracker(resolved) {
  if (resolved === 'github' || resolved === 'gitlab') return 'forge';
  if (resolved === 'jira') return 'jira';
  return 'plan';
}

/** Whether a resolved tracker supports pause (an issue to block on). `plan` doesn't. */
export function trackerSupportsPause(resolved) {
  return filerForTracker(resolved) !== 'plan';
}
