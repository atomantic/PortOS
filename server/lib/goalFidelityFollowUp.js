/**
 * Goal-fidelity FOLLOW-UP contract — pure.
 *
 * `goalFidelity.js` owns the second review's verdict ("did this run ship what
 * was asked?"). This module owns what happens NEXT when that review found a
 * problem: file the finding on the project's own tracker so it outlives the run
 * record, and/or queue an agent to go fix it.
 *
 * Both are off by default and independent of each other. A user who wants a
 * durable backlog entry but no unattended follow-up run gets one; a user who
 * wants the fix attempted immediately without cluttering the tracker gets the
 * other; turning both on files the issue first so the queued task can name it.
 *
 * The dedup identity lives here rather than in the filer because THREE parties
 * have to agree on it — the forge search that decides "already filed", the
 * issue body that carries the marker that search reads back, and the CoS task
 * fingerprint that stops a second follow-up run for the same finding. A
 * scheduled task regenerates with a fresh id every cadence, so keying on the
 * task id alone would re-file the same finding forever; the key is instead
 * `taskType` + app + a slug of the objective's first line, which is stable
 * across those regenerations and distinct between genuinely different work.
 *
 * Pure and I/O-free: the settings resolver, the filer, the queue producer, and
 * the tests share one definition of what a follow-up IS.
 *
 * DEPENDENCY-FREE by design. `cosValidation.js` imports this for the settings
 * enum, and it is reached by most of the server suite — so the obvious edge
 * here (`investigationTasks.js`, for its `investigationFingerprint` formatter)
 * put five modules on ~80 suites' closures and blew the import budget for one
 * three-segment template string. The format is inlined instead, and
 * `goalFidelityFollowUp.test.js` pins it against the real
 * `investigationFingerprint` so the two cannot drift: the test pays the import,
 * production does not. See server/AGENTS.md "Import scoping".
 */

/**
 * Which verdicts trigger a follow-up.
 *
 * - `rethink`     — only the verdict that already holds the run. The default:
 *                   it is the one the gate itself treats as "this built the
 *                   wrong thing", so filing on it can't bury a tracker.
 * - `any-finding` — `rethink` OR `fix-first`. `fix-first` deliberately does NOT
 *                   downgrade a run (see `goalFidelityHoldsRun`), so on an
 *                   install that wants those recorded, an issue is the only
 *                   thing that carries them past the run record.
 *
 * `ship` never triggers a follow-up under either setting — there is no finding.
 */
export const GOAL_FIDELITY_FOLLOW_UP_TRIGGERS = Object.freeze(['rethink', 'any-finding']);

/** The trigger an install gets when it has configured none. */
export const DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER = 'rethink';

/** The verdicts each trigger fires on. */
const TRIGGER_VERDICTS = Object.freeze({
  rethink: Object.freeze(['rethink']),
  'any-finding': Object.freeze(['rethink', 'fix-first']),
});

/** Marker label every goal-fidelity-filed issue carries, so the backlog is readable by origin. */
export const GOAL_FIDELITY_ISSUE_LABEL = 'goal-fidelity';

/** `{ color, description }` for the marker label, created lazily before the file. */
export const GOAL_FIDELITY_ISSUE_LABEL_SPEC = Object.freeze({
  color: 'B60205',
  description: 'Filed by the PortOS goal-fidelity review',
});

/** `category` segment of the shared `category:kind:scope` fingerprint. */
export const GOAL_FIDELITY_FINGERPRINT_CATEGORY = 'goal-fidelity';

/** Longest objective slug folded into a fingerprint — long enough to read in a log line. */
const SUBJECT_SLUG_MAX = 80;

/** Bounds on what crosses into a world-readable issue. */
export const GOAL_FIDELITY_ISSUE_LIMITS = Object.freeze({
  titleChars: 160,
  bodyChars: 12_000,
  /** Items rendered as a bullet list; the review itself already caps at 10. */
  maxItems: 10,
});

/**
 * Resolve the follow-up half of the `goalFidelity` settings block.
 *
 * Reads the RAW block rather than the gate's resolved config, because the two
 * answer different questions: the gate's resolve returns `null` when no local
 * backend is callable, and a caller only reaches this code when a review
 * already produced a verdict. Threading the follow-up through that resolve
 * would make "which backend judged it" a precondition for "what do we do about
 * the answer", which it is not.
 *
 * Returns `null` when neither action is on — the caller's cheap "nothing to do"
 * check, distinct from an object with both flags false, which would read as
 * configured-and-inert.
 *
 * @param {Object|null} codeReview - the raw `settings.codeReview` block.
 * @returns {{ fileIssue: boolean, queueTask: boolean, trigger: string }|null}
 */
export function resolveGoalFidelityFollowUp(codeReview) {
  const raw = codeReview && typeof codeReview === 'object' ? codeReview.goalFidelity : null;
  // The gate being off takes every follow-up with it: no verdict is produced,
  // so a stored `fileIssue: true` under it describes an action nothing can
  // trigger. Resolving it to `null` keeps the UI and the runtime agreeing.
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
  const fileIssue = raw.fileIssue === true;
  const queueTask = raw.queueTask === true;
  if (!fileIssue && !queueTask) return null;
  const trigger = GOAL_FIDELITY_FOLLOW_UP_TRIGGERS.includes(raw.followUpOn)
    ? raw.followUpOn
    : DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER;
  return { fileIssue, queueTask, trigger };
}

/** Does this verdict fire the configured trigger? */
export function goalFidelityFollowUpApplies(review, trigger) {
  const verdicts = TRIGGER_VERDICTS[trigger] || TRIGGER_VERDICTS[DEFAULT_GOAL_FIDELITY_FOLLOW_UP_TRIGGER];
  return verdicts.includes(review?.verdict);
}

/** Lowercase `a-z0-9-` slug of free text, bounded. */
function subjectSlug(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SUBJECT_SLUG_MAX)
    .replace(/-+$/, '');
}

/** First non-blank line of a task description, trimmed. */
function firstLine(text) {
  return String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) || '';
}

/**
 * The durable dedup key for one goal-fidelity finding.
 *
 * Same three-segment `category:kind:scope` shape every other investigation key
 * uses, built by the same function, so the CoS task side participates in the
 * existing fingerprint dedup and loop policy for free.
 *
 * `scope` folds the app AND the objective slug, because one app runs many
 * different tasks and a per-app key would collapse every finding on that app
 * into one issue. The verdict is deliberately NOT in the key: a finding that
 * degrades from `rethink` to `fix-first` between runs is the same unfinished
 * work, and keying on it would file a second issue for it.
 */
export function goalFidelityFingerprint(task) {
  const app = subjectSlug(task?.metadata?.app);
  const subject = subjectSlug(firstLine(task?.description));
  const scope = app ? `${app}/${subject}` : subject;
  // The `category:kind:scope` shape of `investigationFingerprint`, inlined
  // rather than imported (see the module header) and pinned against it by test.
  return `${GOAL_FIDELITY_FINGERPRINT_CATEGORY}:${task?.taskType || 'task'}:${scope || 'none'}`;
}

/**
 * The exact string a duplicate search looks for in an existing issue.
 *
 * A single hyphenated token with no colons, spaces, or quotes: every forge's
 * full-text search treats `:` as a qualifier separator, so the raw
 * `goal-fidelity:user:…` fingerprint would be parsed as a query rather than
 * matched as text — and on GitHub an unknown qualifier fails the whole search.
 * The `portosgf-` prefix keeps it from colliding with ordinary prose.
 *
 * The search is only a NARROWING step. Every forge tokenizes on hyphens too, so
 * a search hit is a candidate; `issueMatchesGoalFidelityMarker` decides, by
 * substring, on the text the forge actually returned.
 */
export function goalFidelityIssueMarker(fingerprint) {
  const token = String(fingerprint ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `portosgf-${token}`;
}

/**
 * Does this issue carry our marker for `fingerprint`?
 *
 * Reads `body` or `description` because the three trackers spell the same field
 * two ways (`gh`/`glab` normalize to `body`; JIRA returns `description`), and a
 * dedup that silently looked at the wrong one would read every existing issue
 * as a non-match and re-file on every run.
 */
export function issueMatchesGoalFidelityMarker(issue, fingerprint) {
  const marker = goalFidelityIssueMarker(fingerprint);
  return `${issue?.title || ''}\n${issue?.summary || ''}\n${issue?.body || ''}\n${issue?.description || ''}`.includes(marker);
}

/** Bounded markdown bullet list, or a fallback sentence when the list is empty. */
function bulletList(items, empty) {
  const rows = (Array.isArray(items) ? items : [])
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, GOAL_FIDELITY_ISSUE_LIMITS.maxItems);
  return rows.length ? rows.map(item => `- ${item}`).join('\n') : empty;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Compose the issue this finding files.
 *
 * Every interpolated field is either operator-authored (the task's own first
 * line) or model-authored free text the review already trimmed and capped
 * (`missing` / `unrequested` / `evidence`). None of it is interpolated into a
 * command or a path, and the filer scrubs home-directory prefixes and
 * credential-shaped strings out of BOTH the title and the body before the CLI
 * sees them — a filed issue is world-readable the moment it lands.
 *
 * The body deliberately does not link the agent run: run ids are local to one
 * install, and the tracker is shared.
 */
export function buildGoalFidelityIssue({ task, review, fingerprint }) {
  const subject = firstLine(task?.description) || 'a CoS agent task';
  const title = truncate(`Goal-fidelity ${review?.verdict || 'finding'}: ${subject}`, GOAL_FIDELITY_ISSUE_LIMITS.titleChars);
  // The marker sits in the SECOND paragraph, not the last: a reader of this
  // issue gets it from a truncated body just as reliably as from a whole one,
  // and the open-issue fallback scan reads bodies the forge lister has already
  // capped at 8k. A marker parked at the bottom would drop out of exactly the
  // long issues most likely to be re-filed.
  const body = truncate([
    `A goal-fidelity review of a finished agent run returned **${review?.verdict}** — the change that shipped does not match what the task asked for.`,
    `Filed automatically by the PortOS goal-fidelity review. Re-filing is suppressed while an issue carrying this key exists: \`${goalFidelityIssueMarker(fingerprint)}\``,
    `## What was asked\n${subject}`,
    `## Named as missing\n${bulletList(review?.missing, '_The review named nothing specific as missing._')}`,
    `## Named as unrequested\n${bulletList(review?.unrequested, '_The review named nothing specific as unrequested._')}`,
    `## Reviewer evidence\n${review?.evidence ? review.evidence : '_The review recorded no evidence note._'}`,
    `## Review provenance\nJudged by \`${review?.backend || 'a local model'}\`${review?.model ? ` (\`${review.model}\`)` : ''}${review?.diffTruncated ? ', against a TRUNCATED diff — confirm the finding against the full change' : ''}.`,
  ].join('\n\n'), GOAL_FIDELITY_ISSUE_LIMITS.bodyChars);
  return { title, body };
}

/**
 * The CoS task body for the queued follow-up run.
 *
 * Two different jobs depending on whether an issue was filed: with one, the
 * agent claims that issue through the project's normal claim flow, which is
 * where the tracker's own conventions (labels, PR linkage, closing keywords)
 * already live. Without one, it works the finding directly from this body —
 * which is why the finding is restated here in full rather than pointing at an
 * issue that may not exist.
 */
export function buildGoalFidelityFollowUpTask({ task, review, fingerprint, issue = null }) {
  const subject = firstLine(task?.description) || 'a CoS agent task';
  const header = `[Auto] Reconcile goal-fidelity ${review?.verdict} [${fingerprint}]: ${subject}`;
  const claim = issue?.url
    ? `## What to do\nClaim ${issue.number ? `#${issue.number}` : 'the filed issue'} (${issue.url}) and ship the reconciliation through the project's normal claim flow.`
    : `## What to do\nRe-read the task above against what actually shipped, then reconcile the two. Ship the change through the project's normal PR flow.`;
  return [
    header,
    `## What happened\nA goal-fidelity review of the finished run for task \`${task?.id || 'unknown'}\` returned **${review?.verdict}**: the diff does not deliver the stated objective.`,
    `## Named as missing\n${bulletList(review?.missing, '_Nothing specific._')}`,
    `## Named as unrequested\n${bulletList(review?.unrequested, '_Nothing specific._')}`,
    claim,
  ].join('\n\n');
}

/** One-line human summary of what the follow-up actually did, for a log line. */
export function formatGoalFidelityFollowUpSummary(result) {
  const parts = [
    result?.issue?.duplicate ? `issue #${result.issue.number} already tracks it` : null,
    result?.issue && !result.issue.duplicate ? `filed ${result.issue.number ? `#${result.issue.number}` : 'an issue'}` : null,
    result?.issueError ? `issue not filed (${result.issueError})` : null,
    result?.task?.duplicate ? 'follow-up task already queued' : null,
    result?.task && !result.task.duplicate ? `queued follow-up task ${result.task.id}` : null,
    result?.taskError ? `follow-up task not queued (${result.taskError})` : null,
  ].filter(Boolean);
  return parts.length ? `Goal-fidelity follow-up: ${parts.join('; ')}` : 'Goal-fidelity follow-up: nothing to do';
}
