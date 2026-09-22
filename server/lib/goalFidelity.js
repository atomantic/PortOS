/**
 * Goal-fidelity review contract (#5994) — pure.
 *
 * PortOS's reviewers answer "is this diff good code?". None of them can answer
 * "is this the code that was asked for?", because none of them ever see the
 * request: `CODE_REVIEW_SYSTEM_PROMPT` hands the model a unified diff and
 * nothing else. The result is a real failure mode — an agent ships a PR that is
 * clean, reviewed, and green, and does something other than the task the user
 * wrote. The run-level evidence gate (`evaluateSuccessCriteria`) proves changes
 * exist and shipped; nothing proves they are the REQUESTED changes.
 *
 * This module owns the value half of that second review: the verdict
 * vocabulary, the objective composition, and the parse/validate of the model's
 * structured answer. The request itself lives in `services/codeReview.js`
 * beside the other tool-free local-LLM prompts, and the completion gate in
 * `services/agentFinalization.js`.
 *
 * Pure and I/O-free so the gate, the settings resolver, and the tests can share
 * one definition of what a verdict is.
 */

import { LOCAL_LLM_REVIEWERS, normalizeReviewerEffort, normalizeReviewerModel } from './reviewerConfig.js';
import { taskContextBlock } from './cosTaskPrompt.js';

/**
 * The three answers the review may return, ordered least → most disruptive.
 *
 * - `ship`      — the diff delivers the objective; nothing is missing or smuggled in.
 * - `fix-first` — it mostly delivers it, but something named is missing or unrequested.
 * - `rethink`   — it does something other than what was asked.
 *
 * Only `rethink` gates a run (see `goalFidelityHoldsRun`). `fix-first` is
 * recorded and surfaced but does NOT downgrade a run: the quality-review chain
 * and CI already ran, the PR is open, and holding every partially-complete run
 * would turn an advisory signal into a queue stall.
 */
export const GOAL_FIDELITY_VERDICTS = Object.freeze(['ship', 'fix-first', 'rethink']);

/** The verdict that downgrades an otherwise-successful run to needs-attention. */
export const GOAL_FIDELITY_HOLD_VERDICT = 'rethink';

/** `errorAnalysis.category` for a run held by this gate. */
export const GOAL_FIDELITY_CATEGORY = 'goal-fidelity-rethink';

/** cosEvents topic the Review Hub bridges into a review alert. */
export const GOAL_FIDELITY_HOLD_EVENT = 'agent:goal-fidelity-hold';

/**
 * Hard caps on what crosses into the reviewer's context.
 *
 * A finished run's accumulated diff is unbounded (a dependency bump can be
 * megabytes), and a local model has a fixed window — an oversized request does
 * not degrade, it fails or silently truncates mid-token. Bounding here, in the
 * value layer, means the gate declines with a reason instead of dispatching a
 * request that cannot fit.
 */
export const MAX_OBJECTIVE_CHARS = 8_000;
export const MAX_FIDELITY_DIFF_CHARS = 60_000;

/** Cap on how many named items are kept from either list. */
const MAX_ITEMS = 10;
/** Cap on one item's / the evidence note's length. */
const MAX_ITEM_CHARS = 400;

/**
 * The objective this run is judged against: the task's own statement of what
 * was asked, never the agent's transcript.
 *
 * Fresh context is the whole mechanism — a reviewer handed the transcript
 * inherits the assumptions that produced the drift. So this reads the TASK
 * (`description` plus the prompt/note block), which is operator-authored and
 * fixed before the run started.
 *
 * Returns `null` when the task states no objective — absent, not empty: a task
 * with nothing to judge against must skip the gate rather than be judged
 * against "".
 */
export function taskObjective(task) {
  const description = typeof task?.description === 'string' ? task.description.trim() : '';
  const context = taskContextBlock(task);
  const parts = [description, typeof context === 'string' ? context.trim() : '']
    .filter(part => part !== '');
  if (!parts.length) return null;
  const joined = parts.join('\n\n');
  if (joined.length <= MAX_OBJECTIVE_CHARS) return joined;
  // Bounded INCLUDING the marker, so the cap means what it says to a caller that
  // re-checks it (same rule as `runWindowDiff`).
  const marker = '\n…[objective truncated]';
  return `${joined.slice(0, MAX_OBJECTIVE_CHARS - marker.length)}${marker}`;
}

/**
 * The audit-note-only shape from #7899: exactly the two summary fields in an
 * existing DEPS document. It cannot evidence forge queries or scanner runs.
 * This is NOT an audit pass: the caller must also establish empty forge
 * inventories before declining diff-only review. Any other edit, file, mode
 * change, or truncated diff stays subject to ordinary fidelity review.
 */
export function isDependencyAuditSummaryDiff({ diff, truncated }) {
  if (truncated || typeof diff !== 'string') return false;
  const header = /^diff --git a\/docs\/DEPS\.md b\/docs\/DEPS\.md\nindex [a-f\d]+\.\.[a-f\d]+ 100644\n--- a\/docs\/DEPS\.md\n\+\+\+ b\/docs\/DEPS\.md\n/;
  if (!header.test(diff)) return false;
  const lines = diff.replace(header, '').trimEnd().split('\n');
  if (!lines[0]?.startsWith('@@ ')) return false;
  const changed = [];
  for (const line of lines) {
    if (line.startsWith(' ') || /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) continue;
    const field = line.match(/^([+-])\*\*(Last audited|Verdict):\*\* .+/);
    if (!field) return false;
    changed.push(`${field[1]}${field[2]}`);
  }
  return changed.length === 4 && new Set(changed).size === 4;
}

/**
 * Resolve the goal-fidelity settings block into `{ enabled, backend, model,
 * effort }`, or `null` when the gate cannot run.
 *
 * The gate runs INSIDE `finalizeAgent`, in the server process, as one
 * synchronous request — so its reviewer has to be one PortOS can call itself.
 * That is the local-LLM set (`lmstudio` / `ollama` / `mtplx`); the CLI
 * reviewers are invoked by the follow-up agent from a prompt and have no
 * server-side entry point. A configured backend outside that set resolves to
 * `null` rather than being silently swapped for one the user did not pick.
 *
 * `enabled` defaults TRUE, but a resolve still needs a backend: with none
 * configured the gate is inert, which is why turning it on cannot surprise an
 * install that has never set up a local model. `backend` falls back to the
 * first local-LLM reviewer already in the quality-review chain, so a user who
 * configured `ollama` as a reviewer gets the fidelity review on the same model
 * without configuring it twice; `model`/`effort` fall back to that reviewer's
 * own `<backend>Model` / `<backend>Effort` scalars for the same reason.
 *
 * @param {Object|null} codeReview - the raw `settings.codeReview` block.
 * @param {string[]} [chain] - the resolved quality-review reviewer chain.
 */
export function resolveGoalFidelityConfig(codeReview, chain = []) {
  const raw = codeReview && typeof codeReview === 'object' ? codeReview.goalFidelity : null;
  if (raw?.enabled === false) return null;
  const chainBackend = (Array.isArray(chain) ? chain : []).find(r => LOCAL_LLM_REVIEWERS.includes(r)) || null;
  const configuredBackend = typeof raw?.backend === 'string' ? raw.backend : null;
  // An explicitly configured backend that is not callable server-side is a
  // decline, not a reason to reach past it for the chain's — the user named a
  // reviewer, and quietly running a different one is worse than not running.
  if (configuredBackend && !LOCAL_LLM_REVIEWERS.includes(configuredBackend)) return null;
  const backend = configuredBackend || chainBackend;
  if (!backend) return null;
  const model = normalizeReviewerModel(raw?.model, backend)
    || normalizeReviewerModel(codeReview?.[`${backend}Model`], backend)
    || null;
  const effort = normalizeReviewerEffort(raw?.effort, backend)
    || normalizeReviewerEffort(codeReview?.[`${backend}Effort`], backend)
    || null;
  return { enabled: true, backend, model, effort };
}

/**
 * One free-text item, trimmed and capped. Non-strings and blanks drop out.
 *
 * The `](` separator is broken apart because these strings are model-authored
 * text derived from an UNTRUSTED diff, and the Review Hub renders an alert
 * description through PortOS's markdown renderer — where `[text](url)` and
 * `![alt](url)` become a clickable link and an embedded image. Both forms
 * require that exact sequence, so splitting it renders the URL as the visible
 * prose it is instead of a destination a reader can click. Targeted rather than
 * stripping brackets wholesale, which would mangle ordinary prose like
 * `retry(3)`.
 */
function normalizeItem(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\]\(/g, '] (');
  if (!trimmed) return null;
  return trimmed.length > MAX_ITEM_CHARS ? `${trimmed.slice(0, MAX_ITEM_CHARS)}…` : trimmed;
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeItem).filter(Boolean).slice(0, MAX_ITEMS);
}

/**
 * Validate + normalize a parsed goal-fidelity response.
 *
 * Returns `null` for anything that is not a usable verdict. That sentinel is
 * deliberate and load-bearing: an unreadable answer means NOTHING judged the
 * run, which must never collapse into `ship` (a free pass) OR into `rethink`
 * (a run held because a local model returned prose). The gate's caller reads
 * `null` as inconclusive and leaves the run's verdict untouched.
 *
 * `missing` / `unrequested` are model-authored free text derived from an
 * untrusted diff, so they are capped and trimmed here and rendered as text
 * everywhere — never interpolated into a command, a path, or a prompt.
 */
export function normalizeGoalFidelityVerdict(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.trim().toLowerCase() : '';
  if (!GOAL_FIDELITY_VERDICTS.includes(verdict)) return null;
  return {
    verdict,
    missing: normalizeItems(parsed.missing),
    unrequested: normalizeItems(parsed.unrequested),
    evidence: normalizeItem(parsed.evidence) || '',
  };
}

/** Does this verdict hold an otherwise-successful run? */
export function goalFidelityHoldsRun(review) {
  return review?.verdict === GOAL_FIDELITY_HOLD_VERDICT;
}

/**
 * Marker for the one-line verdict log. A checkmark is only for `ship`.
 * `fix-first` still records the run as a success, but it found something
 * missing — logging it with the same mark as a clean ship reads as "all good".
 */
export function goalFidelityLogMarker(review) {
  if (goalFidelityHoldsRun(review)) return '🎯';
  if (review?.verdict === 'ship') return '✅';
  return '🧩';
}

/**
 * One-line human summary of a verdict, for a log line, an agent card, or the
 * Review Hub alert. Counts rather than the items themselves — the items are
 * untrusted free text and belong in a rendered list, not in a log line.
 */
export function formatGoalFidelitySummary(review) {
  if (!review?.verdict) return 'Goal-fidelity review returned no verdict';
  const counts = [
    review.missing?.length ? `${review.missing.length} missing` : null,
    review.unrequested?.length ? `${review.unrequested.length} unrequested` : null,
  ].filter(Boolean);
  return counts.length
    ? `Goal-fidelity verdict: ${review.verdict} (${counts.join(', ')})`
    : `Goal-fidelity verdict: ${review.verdict}`;
}

/**
 * `review.source` for a verdict established from FORGE STATE rather than from a
 * model's read of a diff. Rendered in place of the reviewer model, so "this run
 * delivered" is never mistaken for a local model's opinion. Mirrored as a literal
 * in `client/src/components/cos/tabs/AgentCard.jsx`, alongside the verdict keys.
 */
export const GOAL_FIDELITY_SOURCE_FORGE = 'forge-outcome';

/**
 * The change request a task's objective is to LAND, or `null` when the task's
 * objective is ordinary code.
 *
 * A review-loop follow-up (`metadata.reviewLoopFollowUp`, queued by
 * `agentWorktreeCleanup.js` or the PR page's resolve button) is asked for a
 * STATE CHANGE on a change request — "resolve and merge PR #N" — not for a
 * feature. Nothing in `git diff` evidences a merge, so the diff-reading gate is
 * structurally unable to answer it, and it answers anyway: PR #7653 merged, and
 * its run was then graded `rethink` on the unrelated `main` commits the branch
 * had absorbed, failing the run and re-queueing the task against an
 * already-merged PR.
 *
 * `reviewLoopLeaveOpen` follow-ups are excluded on purpose: their objective is
 * to address review feedback and LEAVE the PR open, so a merge proves nothing
 * about them and their fix commits are ordinary diff the normal gate can read.
 */
export function mergeOutcomeObjective(task) {
  const metadata = task?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  // Stored Markdown metadata may carry booleans as strings.
  const truthy = (value) => value === true || value === 'true';
  if (!truthy(metadata.reviewLoopFollowUp) || truthy(metadata.reviewLoopLeaveOpen)) return null;
  const number = Number(metadata.reviewLoopPRNumber);
  const branch = typeof metadata.reviewLoopPRBranch === 'string' ? metadata.reviewLoopPRBranch.trim() : '';
  // Both are required: the number is what the forge is asked about, and the
  // branch is what a forge without a cheap by-number state read is asked about.
  if (!Number.isSafeInteger(number) || number <= 0 || !branch) return null;
  return { number, branch };
}

/**
 * The verdict a probed change-request state establishes, or `null` for one that
 * establishes none.
 *
 * ONLY `MERGED` produces a verdict, and it is always `ship`. The polarity is
 * deliberate and matches the module's fail-open doctrine: a merge is positive
 * proof the objective landed, while `OPEN` and `CLOSED` are not proof it did
 * not. A review loop legitimately leaves a PR open when a required review is
 * blocked or CI never went green, and a PR closed as superseded can be a
 * correct resolution — both are owned by the merge-gate contract, the repo-state
 * audit, and pr-watcher, none of which this gate should second-guess.
 */
export function mergeOutcomeReview({ number, prState }) {
  if (String(prState || '').toUpperCase() !== 'MERGED') return null;
  return {
    verdict: 'ship',
    missing: [],
    unrequested: [],
    evidence: `The forge reports #${number} MERGED — this run's objective is established by forge state, not by reading a diff.`,
    source: GOAL_FIDELITY_SOURCE_FORGE,
  };
}
