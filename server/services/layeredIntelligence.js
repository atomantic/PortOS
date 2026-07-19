/**
 * Layered Intelligence Loop — deterministic backbone.
 *
 * A perpetual, per-managed-app self-improvement loop (Engine B autonomous script
 * job). On a schedule the handler reads each enabled app's goals + telemetry,
 * asks a reasoning model (default: local LLM) for the single most-valuable
 * improvement, and this module's DETERMINISTIC helpers file that as a tracker
 * issue (GitHub / GitLab / Jira / PLAN.md) for a coding agent to pick up later.
 *
 * The reasoning model never touches code — it returns structured JSON only; every
 * side effect (dedup, scope-gating, pause, filing) is deterministic handler code
 * so the "model must not make direct code changes" contract holds by construction.
 *
 * The pure helpers (config defaults, scope-gating, slug/dedup, pause resolution,
 * reasoner-output validation, prompt building, filer dispatch) are side-effect-free
 * and unit-tested. The I/O functions (gather, forge/jira/plan filers) take injectable
 * deps so tests can drive them without a live LLM, `gh`, or filesystem.
 *
 * See docs/plans/2026-07-07-layered-intelligence-loop.md for the full design.
 */

import { spawn } from 'child_process';
import { join, resolve, relative, isAbsolute, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile, appendFile, realpath } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { DAY, tryReadFile, readJSONFile, safeJSONParse, PATHS } from '../lib/fileUtils.js';
import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { fetchPublicText } from '../lib/safeUrlFetch.js';
import { validateCommand } from '../lib/commandSecurity.js';
import { getSettings } from './settings.js';
import { createTicket, searchIssues, addLabels, escapeJql } from './jira.js';
import { computeWindowedStats, computeEffectiveSuccessRate, EFFECTIVE_RATE_MIN_WINDOW_SAMPLES, extractTaskType } from './taskLearning/store.js';
import { formatRejectionReasons, formatRejectionReason, REJECTION_REASONS } from './layeredIntelligenceRejections.js';
import { formatExecutionFailures, summarizeExecutionFailures, formatExecutionFailure } from './layeredIntelligenceExecutionFailures.js';

// Tracker labels + slug marker. The slug is the stable dedup key the reasoner
// chooses; it is embedded in each filed issue body so a later run (or the
// reasoner reading open issues) can self-avoid duplicates.
export const LI_LABEL = 'layered-intelligence';
export const LI_BLOCKING_LABEL = 'layered-intelligence:blocking';

// The tracker label marking an issue as work the user has COMMITTED to — the
// `plannedWork` source's filter (#2698). PortOS's own roadmap "lives entirely in
// the GitHub issue tracker" as `plan`-labeled issues, and that convention is the
// default for managed apps too.
export const PLANNED_WORK_LABEL = 'plan';

// How many planned-work items are surfaced to the reasoner. The point is to give
// it enough of the committed backlog to spot an overlap, not to reproduce the
// tracker — the count of the FULL set is always reported alongside, so a
// truncated list never reads as the whole picture.
export const PLANNED_WORK_MAX_ITEMS = 15;

// Character bound for the rendered plannedWork block, matching the other
// file-backed sources' 8000-char ceiling.
export const PLANNED_WORK_MAX_CHARS = 8000;

// The instruction buildPrompt attaches directly beneath the plannedWork block —
// the whole point of the source: turn "here is the backlog" into "so do not file
// against it".
export const PLANNED_WORK_GUIDANCE = 'Cross-reference your proposal against the user\'s actively-planned work above. If your proposal duplicates or conflicts with an active item, DO NOT file — return proposal: null. Only propose genuinely new work that does NOT overlap with what is already in scope.';

// The LI Proposal Playbook (#2763): standing, human-authored guidance distilling
// which proposals actually land vs. get rejected — scope selection, success/rejection
// pattern catalogs, task-type selection rules, and a goal-alignment check. Loaded
// once from the co-located markdown file so the prose stays reviewable-as-prose and
// buildPrompt can render it verbatim as the always-on `liPlaybook` block. It ships in
// the SOURCE tree (not seeded to data/prompts/), so it is code-versioned guidance that
// updates with the code — NOT a user-customizable stage prompt, and thus needs no
// PROMPT_VERSIONS bump or setup-data migration. Read synchronously at module load so
// the constant is ready before the first buildPrompt call; the file ships with the
// module, so a miss is a packaging bug worth surfacing loudly rather than swallowing.
export const LI_PROPOSAL_PLAYBOOK = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'layeredIntelligence.playbook.md'),
  'utf-8'
).trim();

// The instruction that frames the playbook block: apply it as a standing constraint,
// but let a live per-app data block (liOutcomes / liProposalExecution) override a
// general rule when it has real numbers that contradict it.
export const LI_PLAYBOOK_GUIDANCE = 'This playbook is the distilled, standing rule set for choosing WHAT to propose — apply it as a hard constraint on scope, task type, and goal alignment before you commit to a proposal. Where a live report above (liOutcomes / liProposalExecution) contradicts a general rule here with real data for THIS app, the live data wins; absent that data, follow the playbook.';

// Rendered when the tracker read SUCCEEDED and the app genuinely has no committed
// backlog. Says so explicitly rather than omitting the block, so "nothing planned"
// is legible to the reasoner as a real answer rather than a missing source.
export const PLANNED_WORK_NONE = 'No actively-planned work is currently tracked for this app. (The tracker was read successfully — this is a real "nothing is planned", not a failed read.)';

// Stable opening of the failed-read marker, so `hasPlannedWorkListing` can tell a
// sentinel from a real backlog listing without re-deriving the whole sentence.
export const PLANNED_WORK_UNAVAILABLE_PREFIX = 'Planned work could NOT be read';

// Jira labels can't contain spaces, and a ':' is unsafe on some Jira versions,
// so the Jira pause label swaps the ':' for a '-'. The base LI_LABEL is already
// Jira-safe (kebab, no colon) and is reused verbatim across all trackers.
export const LI_JIRA_BLOCKING_LABEL = 'layered-intelligence-blocking';

// Closed issues carrying a matching slug suppress a re-proposal for this long,
// so the loop doesn't immediately re-file something the user just resolved.
export const CLOSED_SUPPRESSION_MS = 30 * DAY;

// Cosine-similarity floor for the semantic (embedding) near-duplicate guard that
// layers atop the exact slug/label dedup. A proposal whose embedding is at least
// this close to an existing dedup-window issue is treated as the same work worded
// differently and suppressed. Deliberately conservative — only near-identical
// intent should trip it (768-dim local embeddings put genuine near-dups ≳0.9).
export const SEMANTIC_DEDUP_THRESHOLD = 0.9;

// Cap the number of existing issues embedded per run so a repo with a large LI
// backlog can't fan out into an unbounded embedding sweep. Open dedup-window
// issues should be few (the loop files ≤1/run), so this is a generous ceiling.
export const SEMANTIC_DEDUP_MAX_CANDIDATES = 50;

// The id of the RETIRED global autonomous-job that used to drive the whole loop
// (the cross-app sweep). Layered Intelligence is now a per-app handler-backed
// scheduled task (#2322), so this constant is kept ONLY so migration 184 can find
// and tombstone the legacy `data/cos/autonomous-jobs.json` record on installs that
// still carry it. Nothing dispatches on it anymore.
export const LI_JOB_ID = 'job-layered-intelligence';

// Every proposal scope the reasoner may return. The handler enforces WHERE each
// lands (see PROPOSAL_SCOPE_TARGETS) and gates meta/self scopes to PortOS only.
export const PROPOSAL_SCOPES = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];

// Scopes that may only be filed when the sweeping app IS the PortOS install
// itself (they extend / improve the loop, which lives in the PortOS repo).
export const PORTOS_ONLY_SCOPES = ['loop-meta', 'portos-self'];

// The reasoner's honest effort/risk estimate for a proposal. Only a `trivial`
// proposal is ever eligible for the optional Engine-A hand-off (below); anything
// unrecognized normalizes to null (unknown → not trivial → never auto-handed-off).
export const PROPOSAL_COMPLEXITIES = ['trivial', 'moderate', 'complex'];

// The single complexity level that (with `safe: true` and hand-off enabled)
// lets the loop enqueue a coding agent instead of only filing the issue.
export const HANDOFF_COMPLEXITY = 'trivial';

// Merge rate (as a %) below which computeOutcomesReport tells the reasoner its
// proposals are landing badly and points it at the plannedWork source (#2698).
// Measured over RESOLVED proposals only — see computeOutcomesReport.
export const LOW_MERGE_RATE_THRESHOLD = 20;

// Minimum RESOLVED proposals before the low-merge-rate alarm is allowed to fire.
// 0-of-1 and 0-of-50 are both "0%", but only the second is evidence: telling the
// loop its rate is "critically low" after a single early rejection biases it
// toward filing nothing, which is self-reinforcing — it can never earn a merge if
// it stops proposing. A rate needs a sample before it means anything.
export const LOW_MERGE_RATE_MIN_SAMPLE = 4;

// LI's SCHEDULE name (taskSchedule.js SELF_IMPROVEMENT_TASK_TYPES) — also the key
// the type-failure ledger uses. NOT the key its runs are recorded under.
export const LI_SCHEDULED_TASK_TYPE = 'layered-intelligence';

// The `learning.json` byTaskType key LI's own agent runs actually land under — the
// bucket computeSelfEvalSummary reads to judge whether the LI machinery ITSELF is
// healthy (as opposed to how its proposals fare downstream once filed).
//
// DERIVED, never restated: a scheduled LI task is generated with
// `metadata.analysisType = 'layered-intelligence'` (cosTaskGenerator's
// generateSelfImprovementTaskForType), and extractTaskType's FIRST branch turns any
// task carrying an analysisType into `self-improve:<type>` — so these runs are
// recorded under `self-improve:layered-intelligence`, not the bare schedule name.
// The bare name IS correct in two OTHER stores (the schedule map and the
// type-failure ledger), which makes this an easy and silent thing to get wrong:
// guessing it would leave the execution-health signal permanently reading "no LI
// runs recorded yet". Building the key with the same function the WRITER uses means
// it cannot drift out of sync with however task types are keyed later.
export const LI_TASK_TYPE = extractTaskType({ metadata: { analysisType: LI_SCHEDULED_TASK_TYPE } });

// LI-task success rate (%) below which selfEval reports the loop's own execution
// as DEGRADED (#2700) — a separate failure mode from a low merge rate: the merge
// rate says "the user rejects what I propose", this says "my own runs are
// failing". Kept at 50 (a coin flip) rather than the merge-rate's 20: a proposal
// being rejected is normal triage, an LI run outright failing is not.
export const LI_DEGRADED_SUCCESS_THRESHOLD = 50;

// Minimum recorded LI runs before the degraded-execution signal is allowed to
// fire, for the same reason as LOW_MERGE_RATE_MIN_SAMPLE: 0-of-1 and 0-of-50 are
// both "0%", but only the second is evidence. Below the floor the rate is
// reported as-is but is NOT treated as a confidence signal either way.
export const LI_DEGRADED_MIN_SAMPLE = 4;

// The resolved outcomes a filed proposal can reach (the feedback loop, #2428).
// A record with a null outcome is still open/unresolved. All three are
// auto-derived from the tracker's closed state by deriveOutcome: completed →
// merged, not_planned → rejected, and any other PRESENT close reason
// (duplicate/stale/etc.) → abandoned (#2620); a reason-less close falls back
// to merged for trackers that report no stateReason.
export const PROPOSAL_OUTCOMES = ['merged', 'rejected', 'abandoned'];

// The EXECUTION outcomes an LI proposal reaches once it is handed off to a coding
// agent and that agent's run completes (#2765). Distinct from PROPOSAL_OUTCOMES
// (the FILING fate — did the issue get merged/closed): execution is "did LI's own
// coding agent successfully implement the proposal it filed". Only populated for
// proposals that took the Engine-A hand-off path (config.handoff.enabled + a
// trivial+safe proposal); a filed-but-never-handed-off proposal keeps a null
// executionOutcome. Environmental failures (rate-limit/outage) are NOT recorded —
// they say nothing about the proposal's domain (same gate as #2618).
export const PROPOSAL_EXECUTION_OUTCOMES = ['success', 'failure'];

// Minimum recorded executions before a proposal DOMAIN's success rate is trusted
// for the per-domain avoid/prefer split (#2765). Lower than SCOPE_AWARENESS_MIN_SAMPLE
// (3) because each data point here is a REAL, high-signal LI-proposal execution — not
// install-wide task-type telemetry that a proposal only loosely maps onto — and the
// hand-off path is rare, so a floor of 2 lets a genuine per-domain signal surface
// without letting a single fluke mint a list.
export const PROPOSAL_EXECUTION_MIN_SAMPLE = 2;

// Scope-awareness thresholds (#2760). LI's own execution data shows several CoS
// task-type scopes it consistently fails at (e.g. self-improve:layered-intelligence,
// branch-reconcile, accessibility all sit at 0%) while others succeed reliably
// (plan-task, test-coverage, performance at ~100%). Since an LI proposal is later
// EXECUTED as a CoS task, proposing work that maps to a chronically-failing scope is
// systematic waste. These bound a deterministic, self-clearing classifier
// (computeScopeAwareness) that surfaces the avoid/prefer split to the reasoner so it
// can steer proposals toward scopes that actually execute.
//
// A scope is "avoid" when its effective (recency-windowed-or-lifetime) success rate is
// below AVOID and it has enough completed runs to be evidence; "prefer" when at/above
// PREFER with the same sample floor. Reusing the degraded-execution boundary (50%) for
// AVOID keeps LI's two success signals — its own loop health and per-scope
// executability — on the same coin-flip line. The classification is recomputed from
// fresh metrics every run and keyed on the windowed rate (once the window clears the
// scheduler's own EFFECTIVE_RATE_MIN_WINDOW_SAMPLES floor), so an "avoid" scope
// self-clears once it recovers in-window — no persisted avoid-list to go stale (the
// issue's "dynamic adjustment" requirement). See computeScopeAwareness for why the
// windowed rate, not the near-permanent lifetime rate, is the right basis.
export const SCOPE_AVOID_SUCCESS_THRESHOLD = LI_DEGRADED_SUCCESS_THRESHOLD; // < 50% → avoid
export const SCOPE_PREFER_SUCCESS_THRESHOLD = 75;                          // >= 75% → prefer

// Minimum completed runs before a scope's rate is trusted for avoid/prefer, mirroring
// LI_DEGRADED_MIN_SAMPLE's rationale (0-of-1 and 0-of-50 are both "0%", only the
// second is evidence). Set to 3 per #2760 — one below the degraded floor because the
// prompt guidance is advisory (it steers the reasoner, it does not hard-suppress a
// proposal), so a slightly lower bar to surface the signal is acceptable.
export const SCOPE_AWARENESS_MIN_SAMPLE = 3;

// Prompt-size bounds for the scope-awareness block, so a long-lived install with many
// task types (mission task keys embed an unbounded mission name) can't render an
// oversized block — the raw cosMetrics source is already char-capped for the same
// reason. Cap the entries surfaced per list (the lists are sorted sharpest-first, so
// the cap keeps the most decision-relevant scopes) and truncate any single task-type
// name so one pathological key can't blow the budget.
export const SCOPE_AWARENESS_MAX_PER_LIST = 12;
export const SCOPE_AWARENESS_MAX_TYPE_LEN = 80;

/**
 * The default per-app config. PortOS (isPortos) additionally gets the meta/self
 * scopes so the loop can extend itself; every other app is capped at its own
 * improvement + data-gap scopes. Off by default — the loop is a user-enabled
 * scheduled automation (AI-provider "no cold-bootstrap" policy).
 */
export function defaultLayeredIntelligenceConfig(isPortos = false) {
  return {
    enabled: false,
    intervalMs: DAY,
    providerId: null,
    model: null,
    sources: {
      goals: true,
      // The app's OWN performance metrics (a METRICS.md doc in the app repo): the
      // user-success / KPI / production-telemetry signals the app tracks about
      // itself. This is the PRIMARY signal for evaluating a managed app against
      // its own goals and purpose, so it's on by default for every app. See the
      // METRICS.md convention in docs/METRICS.md.
      appMetrics: true,
      // The autonomous coding-agent run stats this install records (learning.json).
      // For the PortOS install these ARE its own-performance metrics; for a MANAGED
      // app they describe how reliably PortOS's agents change the app (a tooling /
      // interaction signal), NOT the app's own product performance — so default it
      // on only for PortOS. A managed app measures itself through appMetrics/custom
      // sources instead; the user can still opt this on per-app.
      cosMetrics: isPortos,
      healthReport: true,
      planMd: true,
      openIssues: true,
      // The backlog the user has ALREADY committed to (#2698): `plan`-labeled
      // tracker issues / the app's prioritized Jira backlog / PLAN.md's unchecked
      // items. Open issues alone read as a flat list with no priority context, so
      // the reasoner had no way to tell "nobody has looked at this" from "the user
      // already scheduled this" — the top NOT_PLANNED rejection cause. On by
      // default for every app: cross-referencing against committed work is only
      // useful if it is there by default.
      plannedWork: true,
      // The self-feedback signal (#2428): past LI proposals + their tracker
      // outcomes, fed back so the reasoner calibrates on its own merge rate.
      // Default ON for the PortOS install (it improves itself), OFF for managed
      // apps — the user opts in per-app via the LI config UI.
      outcomes: isPortos,
      // The loop's self-awareness signal (#2700): a deterministic read of LI's OWN
      // record — proposal merge rate, how many of its proposals are already filed
      // and suppressed, and whether its own agent runs are succeeding — folded back
      // so the reasoner can judge its proposal quality BEFORE filing rather than
      // only learning from rejections after. Same PortOS-only default as `outcomes`:
      // it is built from LI's own history, which only the self-improving install
      // accumulates meaningfully; managed apps opt in per-app.
      selfEval: isPortos,
      custom: []
    },
    rules: '',
    allowedScopes: isPortos
      ? ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self']
      : ['app-improvement', 'app-data-gap'],
    // Engine-A hand-off. When enabled, a proposal the reasoner marks trivial+safe
    // is ALSO enqueued as a CoS coding-agent task (approval-gated) instead of only
    // being filed for later human triage. Off by default — letting an agent write
    // code from the loop unattended is an extra opt-in on top of enabling the loop.
    handoff: { enabled: false }
  };
}

/**
 * Merge an app record's stored `layeredIntelligence` over the defaults so a
 * partial config (or none) still yields a complete, safe config. `sources` is
 * merged one level deep so a stored `{ sources: { goals: false } }` doesn't wipe
 * the other source toggles.
 */
export function getEffectiveConfig(app) {
  const isPortos = !!app?.isPortos;
  const base = defaultLayeredIntelligenceConfig(isPortos);
  const stored = (app?.layeredIntelligence && typeof app.layeredIntelligence === 'object' && !Array.isArray(app.layeredIntelligence))
    ? app.layeredIntelligence
    : {};
  const merged = { ...base, ...stored };
  merged.sources = {
    ...base.sources,
    ...(stored.sources && typeof stored.sources === 'object' ? stored.sources : {})
  };
  // Merge handoff one level deep (like sources) so a partial `{ handoff: {} }`
  // doesn't wipe the default `enabled`.
  merged.handoff = {
    ...base.handoff,
    ...(stored.handoff && typeof stored.handoff === 'object' && !Array.isArray(stored.handoff) ? stored.handoff : {})
  };
  if (!Array.isArray(merged.sources.custom)) merged.sources.custom = [];
  if (!Array.isArray(merged.allowedScopes)) merged.allowedScopes = base.allowedScopes;
  return merged;
}

/**
 * Whether a proposal scope is allowed for this app. A hallucinated or
 * hand-edited scope cannot escape this gate: it must be a recognized scope, be
 * in the app's `allowedScopes`, and — for meta/self scopes — the app must BE the
 * PortOS install. Double-enforced regardless of what the prompt told the model.
 */
export function isScopeAllowed({ scope, allowedScopes = [], isPortos = false }) {
  if (!PROPOSAL_SCOPES.includes(scope)) return false;
  if (PORTOS_ONLY_SCOPES.includes(scope) && !isPortos) return false;
  return allowedScopes.includes(scope);
}

/** The HTML-comment slug marker embedded in a filed issue/ticket body. */
export function slugMarker(slug) {
  return `<!-- lil-slug: ${slug} -->`;
}

/** Extract a `lil-slug` marker's value from a body string (null if absent). */
export function extractSlugFromBody(body) {
  if (typeof body !== 'string') return null;
  const m = body.match(/<!--\s*lil-slug:\s*([a-z0-9][a-z0-9-]*)\s*-->/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Normalize a reasoner-chosen slug to a stable kebab id. Returns null for a
 * non-string or an input that reduces to empty (so a bad slug is a no-op, never
 * a mystery label).
 */
export function normalizeSlug(slug) {
  if (typeof slug !== 'string') return null;
  const norm = slug
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return norm || null;
}

/**
 * Whether an existing tracker issue is still within the dedup suppression window:
 * OPEN, or CLOSED within CLOSED_SUPPRESSION_MS. Only a closed-long-ago issue
 * falls out of the window so its work can be re-proposed. A closed issue with a
 * missing/unparseable `closedAt` is PERMANENTLY in-window (suppressed): the main
 * producer of that shape is a checked `- [x]` PLAN.md item (checkboxes carry no
 * timestamp), and a completed plan item never needs re-proposal — treating it as
 * "closed long ago" made the reasoner re-propose every done item on every run
 * (#2620). A tracker row missing its close time (e.g. a jira Done ticket with no
 * resolutiondate) is likewise suppressed rather than re-proposed — done work is
 * never worth re-reasoning. Shared by both the slug dedup and the semantic dedup
 * so the two guards agree on which issues still count.
 */
export function isIssueWithinDedupWindow(issue, now = Date.now()) {
  if ((issue?.state || '').toLowerCase() === 'open') return true;
  const closedAt = issue?.closedAt ? Date.parse(issue.closedAt) : NaN;
  if (!Number.isFinite(closedAt)) return true;
  return now - closedAt <= CLOSED_SUPPRESSION_MS;
}

/**
 * Deterministic dedup guard. Given the slug of the proposed item and the live
 * tracker's existing issues (each `{ slug, state, closedAt }`), suppress the
 * proposal when a match is open, OR closed within CLOSED_SUPPRESSION_MS.
 *
 * `slug` matching is case-insensitive on the normalized slug. `existingIssues`
 * may carry either a parsed `slug` or a raw `body`/`title` we extract from.
 */
export function isProposalDuplicate({ slug, existingIssues = [], now = Date.now() }) {
  const target = normalizeSlug(slug);
  if (!target) return false;
  for (const issue of existingIssues) {
    const issueSlug = issue.slug
      ? normalizeSlug(issue.slug)
      : extractSlugFromBody(issue.body) || extractSlugFromBody(issue.title);
    if (issueSlug !== target) continue;
    if (isIssueWithinDedupWindow(issue, now)) return true;
  }
  return false;
}

/**
 * Build the text to embed for a proposal OR an existing issue — title + body,
 * trimmed and length-capped so a single huge body can't blow the embedding
 * model's context. Both sides go through THIS helper so the proposal and the
 * candidates are embedded from the same seed shape (a fair comparison).
 */
export function issueEmbedSeed({ title = '', body = '' } = {}) {
  const parts = [title, body].map(s => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  return parts.join('\n\n').slice(0, 2000);
}

/** Cosine similarity of two equal-length numeric vectors. Returns 0 for a shape
 * mismatch, empty vector, or a zero-magnitude vector (nothing meaningful to
 * compare) rather than NaN, so a bad embedding can never trip the dedup guard. */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pure near-duplicate finder. Given the proposal's embedding and an array of
 * candidates (each `{ slug?, number?, title?, embedding }`), return the single
 * best candidate whose cosine similarity meets `threshold` (highest score wins),
 * or null when none qualify / the proposal embedding is unusable. Side-effect-free
 * and unit-tested; the I/O layer feeds it real embeddings.
 */
export function findSemanticDuplicate({ proposalEmbedding, candidates = [], threshold = SEMANTIC_DEDUP_THRESHOLD } = {}) {
  if (!Array.isArray(proposalEmbedding) || proposalEmbedding.length === 0) return null;
  let best = null;
  for (const c of candidates) {
    if (!Array.isArray(c?.embedding) || c.embedding.length === 0) continue;
    const score = cosineSimilarity(proposalEmbedding, c.embedding);
    if (score >= threshold && (!best || score > best.score)) {
      best = { slug: c.slug || null, number: c.number ?? null, title: c.title || '', score };
    }
  }
  return best;
}

/**
 * Whether the app is currently PARKED — i.e. has at least one OPEN blocking
 * issue. When parked, the sweep skips the app entirely (no gather, no reason),
 * resuming automatically once the blocking issue closes. Fully tracker-derived.
 */
export function isAppParked(blockingIssues = []) {
  return blockingIssues.some(i => (i.state || '').toLowerCase() === 'open');
}

/**
 * Validate + normalize the reasoner's JSON. Returns
 * `{ analysis, proposal, pause }` with invalid pieces dropped (never throws):
 *   - `proposal` kept only when it has a recognized scope + a normalizable slug
 *     + a non-empty title. `slug` is normalized in place.
 *   - `pause` kept only when it has a reason AND a resolvable target: an integer
 *     issue number, or `"this"` WITH a surviving proposal to block on. A
 *     `pause.blockOnIssue: "this"` with a null proposal is invalid → dropped.
 */
export function validateReasonerResponse(parsed) {
  const out = { analysis: '', proposal: null, pause: null };
  if (!parsed || typeof parsed !== 'object') return out;
  if (typeof parsed.analysis === 'string') out.analysis = parsed.analysis;

  const p = parsed.proposal;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const slug = normalizeSlug(p.slug);
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    if (PROPOSAL_SCOPES.includes(p.scope) && slug && title) {
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
        safe: p.safe === true
      };
    }
  }

  const pause = parsed.pause;
  if (pause && typeof pause === 'object' && !Array.isArray(pause)) {
    const reason = typeof pause.reason === 'string' ? pause.reason.trim() : '';
    const target = pause.blockOnIssue;
    const isThis = target === 'this';
    const num = Number.isInteger(target) ? target : (typeof target === 'string' && /^\d+$/.test(target) ? Number(target) : null);
    // "this" requires a surviving proposal to block on; else an explicit issue number.
    if (reason && ((isThis && out.proposal) || num)) {
      out.pause = { blockOnIssue: isThis ? 'this' : num, reason };
    }
  }
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

/**
 * Derive a resolved outcome for a filed proposal from its live tracker issue.
 * Pure — the reconciler feeds it a `{ state, stateReason, closedAt }` issue:
 *   - still open (or unknown state)     → null   (unresolved)
 *   - closed as "completed"             → 'merged'
 *   - closed as "not planned"           → 'rejected'
 *   - closed with any OTHER reason       → 'abandoned' (duplicate/stale/etc. —
 *                                          counting these as merged inflated the
 *                                          merge-rate calibration signal, #2620)
 *   - closed with NO reason              → 'merged' (graceful fallback: glab/jira
 *                                          and the plan filer report no stateReason,
 *                                          and their common close path IS a merge —
 *                                          absent ≠ other, per the sentinel rule)
 * GitHub reports `stateReason` ('completed' | 'not_planned' | 'reopened' | …);
 * other trackers omit it, so a bare closed issue reads as merged.
 */
export function deriveOutcome(issue) {
  if ((issue?.state || '').toLowerCase() !== 'closed') return null;
  const reason = (issue?.stateReason || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (reason === 'not_planned') return 'rejected';
  if (reason === '' || reason === 'completed') return 'merged';
  return 'abandoned';
}

/**
 * Tally a recorded-outcome list into the counts BOTH the outcomes report (#2428)
 * and the self-eval summary (#2700) reason over. Pure; the single place the
 * merge-rate math lives so the two blocks can never disagree about LI's record.
 *
 * `rawMergeRate` is measured over RESOLVED proposals only and is `null` when
 * nothing has resolved yet — the sentinel rule: "no proposal has been judged" must
 * not collapse into the same 0 as "every judged proposal was rejected". Callers
 * round only for display (rounding before a threshold compare would let 19.6%
 * read as 20% and suppress a warning that should fire).
 */
export function summarizeOutcomeStats(outcomes = []) {
  const filed = (Array.isArray(outcomes) ? outcomes : []).filter(o => o && typeof o === 'object');
  const total = filed.length;
  const count = (name) => filed.filter(o => o.outcome === name).length;
  const merged = count('merged');
  const rejected = count('rejected');
  const abandoned = count('abandoned');
  const resolved = merged + rejected + abandoned;
  return {
    filed,
    total,
    merged,
    rejected,
    abandoned,
    // Anything filed but not yet resolved — still awaiting triage, NOT a failure.
    pending: total - resolved,
    resolved,
    rawMergeRate: resolved > 0 ? (merged / resolved) * 100 : null
  };
}

/**
 * Format the LI outcome-feedback report (#2428) from this app's recorded
 * proposals + their reconciled outcomes. Pure + side-effect-free: the LI hook
 * loads the outcomes and passes them here, then feeds the string into buildPrompt.
 * Returns '' when there's nothing to report (no filed history) so the caller omits
 * the block entirely rather than injecting an empty section.
 */
export function computeOutcomesReport({ outcomes = [], hasPlannedWork = false } = {}) {
  const { filed, total, merged, rejected, abandoned, pending, resolved, rawMergeRate } =
    summarizeOutcomeStats(outcomes);
  if (total === 0) return '';
  const pct = (n) => Math.round((n / total) * 100);

  // Per-scope merge rate — the calibration signal the reasoner acts on.
  const scopes = new Map();
  for (const o of filed) {
    const s = o.scope || 'unknown';
    const agg = scopes.get(s) || { filed: 0, merged: 0 };
    agg.filed += 1;
    if (o.outcome === 'merged') agg.merged += 1;
    scopes.set(s, agg);
  }
  const scopeLines = [...scopes.entries()]
    .sort((a, b) => b[1].filed - a[1].filed)
    .map(([s, v]) => `- ${s}: ${v.filed} filed, ${v.merged} merged (${v.filed ? Math.round((v.merged / v.filed) * 100) : 0}%)`)
    .join('\n');

  // Structured diagnosis of every non-merged proposal (#2689), replacing the raw
  // tracker string this used to echo ('not_planned' merely restated the outcome).
  // '' when nothing has been closed unmerged — distinct from "closed, reason
  // unknown", which the line reports explicitly.
  const rejectionReasons = formatRejectionReasons(filed, 5);

  // Structured diagnosis of every FAILED hand-off (#2764 §1) — the "why" behind the
  // per-domain execution rate the liProposalExecution block reports (#2765). '' when
  // no hand-off has failed, so the line below is omitted rather than contradicting a
  // clean execution record.
  const executionFailures = formatExecutionFailures(filed, 5);

  // Low-merge-rate alarm (#2698). `rawMergeRate` is measured over RESOLVED
  // proposals only and is null when none have resolved — see summarizeOutcomeStats
  // for the sentinel rationale (pending ≠ rejected). A null rate stays silent
  // rather than alarming an app whose first proposal is simply still in flight.
  // The sample floor is the same idea one step further out: 0-of-1 is not evidence.
  const lowMergeWarning = (
    rawMergeRate !== null
    && resolved >= LOW_MERGE_RATE_MIN_SAMPLE
    && rawMergeRate < LOW_MERGE_RATE_THRESHOLD
  )
    ? [
      '',
      `WARNING: your merge rate is critically low — only ${merged} of ${resolved} resolved proposals (${Math.round(rawMergeRate)}%) were merged.`,
      // Only point at the plannedWork block when one was actually gathered — the
      // source is per-app-toggleable and yields nothing on an unresolvable
      // tracker, and citing a section that isn't in the prompt is just noise.
      hasPlannedWork
        ? 'Review the "plannedWork" source above: your proposals may be overlapping with work the user has already committed to. Propose only work that is clearly outside that committed backlog — and if you cannot find any, return proposal: null rather than filing something marginal.'
        : 'Your proposals may be overlapping with work the user has already committed to, or missing what they actually value. Hold a higher bar: return proposal: null rather than filing something marginal.'
    ]
    : [];

  return [
    'Recent LI proposals (all still-open, plus outcomes resolved within ~30 days):',
    `- Total filed: ${total}`,
    `- Merged/implemented: ${merged} (${pct(merged)}%)`,
    `- Rejected: ${rejected} (${pct(rejected)}%)`,
    `- Abandoned: ${abandoned} (${pct(abandoned)}%)`,
    `- Still open: ${pending} (${pct(pending)}%)`,
    '',
    'By scope:',
    scopeLines || '- (none)',
    '',
    `Why non-merged proposals were closed: ${rejectionReasons || 'nothing has been closed unmerged yet'}`,
    // Only emit the execution-failure line when a hand-off has actually failed —
    // an app whose proposals were never handed off (or all succeeded) shows nothing
    // here rather than a misleading "no failures" line.
    ...(executionFailures ? [`Why LI's own hand-offs failed when implemented: ${executionFailures}`] : []),
    ...lowMergeWarning
  ].join('\n');
}

// How many closed-but-still-suppressed proposals selfEval names before it
// summarizes the rest as a count. The block is a calibration aid, not a backlog
// dump — an unbounded list would crowd out the sources it exists to be weighed
// against, and past this many the reasoner has the pattern anyway.
export const SELF_EVAL_MAX_SUPPRESSED_LISTED = 8;

/**
 * Recover a suppressed issue's normalized dedup slug — the key the reasoner must
 * avoid re-using and the join key onto the outcome store's rejectionReason. Shapes
 * vary by tracker: forge/jira rows carry `{ number, title, body }` (the slug lives
 * in the body marker), while the `plan` filer yields bare `{ slug, state }`.
 * Normalized both ways so the value matches the outcome record's stored slug
 * (`normalizeSlug(slug)` at file time) exactly. Returns null when unrecoverable.
 */
export function suppressedIssueSlug(issue) {
  if (issue?.slug) return normalizeSlug(issue.slug);
  return normalizeSlug(extractSlugFromBody(issue?.body) || extractSlugFromBody(issue?.title));
}

/**
 * Build a `slug → rejectionReason` lookup from reconciled outcome records, so the
 * self-eval "recently closed" line can tell the reasoner not just WHICH proposals
 * to avoid but WHY each was closed — the feedback loop of #2689 (ask #4), closing
 * the loop with the taxonomy #2735 already persists rather than any new signal.
 *
 * Only a RESOLVED non-merged record carries a diagnosis, and only a REAL taxonomy
 * token (a member of REJECTION_REASONS) counts: a merged, unresolved, or
 * still-unclassified (`rejectionReason == null`) record contributes nothing, and so
 * does the `unknown-reason` SENTINEL — it means "we looked and found no signal",
 * which is not an actionable failure pattern to route around, so annotating a
 * suppressed proposal with "closed with no recorded reason" would add noise the
 * reasoner can't act on (and would contradict the promise that undiagnosed closures
 * stay unannotated). The annotation therefore appears only where a concrete reason
 * explains the closure. First diagnosed record per slug wins (records arrive
 * newest-filed-first). Pure.
 */
export function rejectionReasonBySlug(outcomes = []) {
  const map = new Map();
  for (const o of Array.isArray(outcomes) ? outcomes : []) {
    if (!o || (o.outcome !== 'rejected' && o.outcome !== 'abandoned')) continue;
    if (!REJECTION_REASONS.includes(o.rejectionReason)) continue;
    const slug = normalizeSlug(o.slug);
    if (slug && !map.has(slug)) map.set(slug, o.rejectionReason);
  }
  return map;
}

/**
 * Identify a suppressed proposal for the prompt: its slug (the actual dedup key the
 * reasoner must avoid re-using) plus its title for human-readable context. Returns
 * null when neither is recoverable — an unidentifiable entry is left to the count
 * rather than rendered as a mystery bullet the reasoner can't act on.
 *
 * When `reasonBySlug` (from rejectionReasonBySlug) holds this slug's diagnosis, it
 * is appended as glossed prose so the reasoner sees the specific failure pattern
 * that sank the earlier proposal (#2689), not merely a slug to route around. An
 * undiagnosed (null) or unmatched slug renders exactly as before.
 */
export function describeSuppressedIssue(issue, reasonBySlug = null) {
  const slug = suppressedIssueSlug(issue);
  const title = typeof issue?.title === 'string' ? issue.title.trim() : '';
  if (!slug && !title) return null;
  const ref = issue?.number ? `#${issue.number} ` : '';
  const reason = slug && reasonBySlug instanceof Map ? reasonBySlug.get(slug) : null;
  const why = reason ? ` — previously closed: ${formatRejectionReason(reason)}` : '';
  if (!slug) return `${ref}${title}${why}`.trim();
  return `${ref}[${slug}]${title ? ` ${title}` : ''}${why}`.trim();
}

/**
 * Format LI's self-evaluation block (#2700) — the loop's pre-filing quality check
 * on its OWN reasoning. Pure + side-effect-free and NO LLM call: every line is
 * derived from data the loop already has, so this never adds a provider round-trip
 * (the "no cold-bootstrap LLM calls" policy). The hook loads the inputs and feeds
 * the string to buildPrompt, exactly like computeOutcomesReport.
 *
 * Three independent self-signals, each of which is either PRESENT or explicitly
 * reported ABSENT — never silently defaulted, because "I have no data about myself"
 * and "the data says I am doing badly" demand opposite responses from the reasoner:
 *   1. Proposal merge rate      — do the user's triage decisions validate my picks?
 *   2. Already-filed proposals  — what have I said already that I must not repeat?
 *   3. LI execution health      — are my own agent runs even succeeding?
 *
 * Unlike computeOutcomesReport this ALWAYS returns a block when called: "you are
 * reasoning with no signal about yourself, hold a higher bar" is the single most
 * useful thing to tell a cold loop, so an empty-handed run is exactly when the
 * block matters most.
 *
 * @param {Object} args
 * @param {Array|null} args.outcomes - recorded proposals; `null` = NOT gathered
 *   (source off / outcomes-incapable tracker), `[]` = gathered and genuinely none.
 * @param {Array|null} args.existingIssues - LI-labeled tracker issues; `null` = the
 *   tracker read FAILED or never ran, `[]` = read fine and LI has filed nothing.
 *   The caller MUST pass null on a failed read: readIssues returns `[]` for a blown
 *   read, which would otherwise read as "nothing filed" and license a re-file.
 * @param {{ read: boolean, metrics: Object|null }|null} args.liTaskStats - from
 *   readLiTaskMetrics. `null`/`read:false` = the learning store was unreadable;
 *   `read:true, metrics:null` = read fine and LI has simply never run a task.
 * @param {number} [args.now] - clock seam for the suppression window.
 * @returns {string} the liSelfEval block body.
 */
export function computeSelfEvalSummary({
  outcomes = null,
  existingIssues = null,
  liTaskStats = null,
  now = Date.now()
} = {}) {
  const lines = [];

  // --- Signal 1: does the user actually merge what I propose? -----------------
  let mergeSignal = false;
  if (!Array.isArray(outcomes)) {
    lines.push('- Proposal merge rate: UNAVAILABLE — no outcome history was gathered this run (the outcomes source is off, or this tracker cannot report outcomes). You cannot see how your past proposals fared; do not assume they went well.');
  } else {
    const { total, merged, resolved, rawMergeRate, filed } = summarizeOutcomeStats(outcomes);
    if (total === 0) {
      lines.push('- Proposal merge rate: no proposals filed yet for this app — you have no track record here to calibrate against.');
    } else if (rawMergeRate === null) {
      lines.push(`- Proposal merge rate: ${total} filed, none resolved yet — rate unknown. Awaiting triage is NOT rejection; do not read this as failure.`);
    } else {
      mergeSignal = resolved >= LOW_MERGE_RATE_MIN_SAMPLE;
      // Same structured diagnosis as computeOutcomesReport (#2689) — one helper, so
      // the two blocks can never disagree about why proposals were closed. Gated on
      // the formatted string, not on `rejected`, because an `abandoned` proposal is
      // also a non-merge worth explaining.
      const reasons = formatRejectionReasons(filed, 3);
      lines.push(
        `- Proposal merge rate: ${merged} of ${resolved} resolved proposals merged (${Math.round(rawMergeRate)}%)`
        + `${resolved < LOW_MERGE_RATE_MIN_SAMPLE ? ' — too small a sample to read a rate from yet' : ''}.`
        + (reasons ? ` Why the rest were closed: ${reasons}.` : '')
      );
    }
  }

  // --- Signal 2: what have I already said? (dedup awareness) ------------------
  let trackerSignal = false;
  if (!Array.isArray(existingIssues)) {
    lines.push('- Your already-filed proposals: UNKNOWN — the tracker could not be read this run. You may be about to re-file something that already exists; hold a higher bar than usual.');
  } else {
    trackerSignal = true;
    const open = existingIssues.filter(i => (i?.state || '').toLowerCase() === 'open');
    // Closed but still inside the 30-day suppression window: re-proposing one of
    // these gets deterministically dropped downstream, so spending the run on it is
    // a wasted run. Surfaced so the reasoner can route around it BEFORE proposing.
    const closedSuppressed = existingIssues.filter(i =>
      (i?.state || '').toLowerCase() !== 'open' && isIssueWithinDedupWindow(i, now));
    lines.push(
      `- Your already-filed proposals: ${open.length} open`
      + `${closedSuppressed.length ? `, plus ${closedSuppressed.length} closed but still within the ${Math.round(CLOSED_SUPPRESSION_MS / DAY)}-day suppression window` : ''}.`
      + ` ${open.length + closedSuppressed.length
        ? 'Re-proposing any of these is deterministically suppressed — the run is wasted. Propose something genuinely new.'
        : 'Nothing is currently suppressed.'}`
    );
    // NAME the closed-but-suppressed ones. The open proposals are already listed in
    // full elsewhere in the prompt, but a closed issue appears NOWHERE else — so
    // without this the reasoner is told a number it cannot act on and can burn the
    // whole run re-proposing something the dedup guard silently drops. Capped so a
    // long tail can't crowd out the sources it is meant to be reasoning about.
    if (closedSuppressed.length) {
      // Join each suppressed proposal to its reconciled rejection reason (#2689),
      // so the "do NOT re-propose" line also carries WHY each was closed — a
      // no-extra-cost read of the outcome records selfEval already received. Empty
      // when outcomes weren't gathered this run (`outcomes` not an array), leaving
      // the line exactly as before.
      const reasonBySlug = rejectionReasonBySlug(Array.isArray(outcomes) ? outcomes : []);
      const named = closedSuppressed
        .map(i => describeSuppressedIssue(i, reasonBySlug))
        .filter(Boolean)
        .slice(0, SELF_EVAL_MAX_SUPPRESSED_LISTED);
      if (named.length) {
        lines.push(
          `  Recently closed (do NOT re-propose): ${named.join('; ')}`
          + `${closedSuppressed.length > named.length ? ` (+${closedSuppressed.length - named.length} more)` : ''}`
        );
      }
    }
  }

  // --- Signal 3: is the LI machinery itself healthy? --------------------------
  // Deliberately GLOBAL, not per-app: the learning store keys LI runs by task type
  // alone, so this bucket aggregates the loop's runs across every app. That is the
  // right scope for the question being asked — "is the LI machinery working?" is a
  // property of the shared loop, not of the app it happens to be pointed at — and
  // it mirrors the cosMetrics source, which is likewise install-wide.
  let taskSignal = false;
  let liDegraded = false;
  if (!liTaskStats?.read) {
    lines.push('- LI execution health: UNAVAILABLE — the CoS learning store could not be read.');
  } else if (!liTaskStats.metrics) {
    lines.push('- LI execution health: no LI runs recorded yet — this loop has no execution history.');
  } else {
    // Forward the clock seam: computeEffectiveSuccessRate age-filters the recent
    // ring, so without `now` this branch would read the real wall clock while the
    // suppression-window branch above uses the injected one — the same summary
    // reasoning against two different "nows", and a non-pure "pure" function.
    const { successRate, source, windowedCompleted } = computeEffectiveSuccessRate(liTaskStats.metrics, { now });
    const sample = source === 'windowed' ? windowedCompleted : (liTaskStats.metrics.completed || 0);
    if (successRate === null) {
      lines.push('- LI execution health: no completed LI runs recorded yet — success rate unknown.');
    } else {
      taskSignal = sample >= LI_DEGRADED_MIN_SAMPLE;
      liDegraded = taskSignal && successRate < LI_DEGRADED_SUCCESS_THRESHOLD;
      lines.push(
        `- LI execution health: ${successRate}% of ${sample} ${source} LI runs succeeded`
        + `${taskSignal ? '' : ' — too small a sample to judge'}${liDegraded ? ' — DEGRADED' : ''}.`
      );
    }
  }

  // --- Confidence: how much do I actually know about myself? ------------------
  // Purely a count of PRESENT signals — it rates the evidence available to the
  // reasoner, NOT whether that evidence is flattering. A loop with a well-measured
  // 0% merge rate has HIGH confidence in a bad result, which is precisely the state
  // where it should act decisively rather than hedge.
  const signalCount = [mergeSignal, trackerSignal, taskSignal].filter(Boolean).length;
  const confidence = signalCount >= 3 ? 'high' : signalCount === 2 ? 'medium' : 'low';

  const guidance = [];
  if (confidence === 'low') {
    guidance.push(
      '',
      `GUIDANCE — low self-confidence (${signalCount} of 3 self-signals available): you are reasoning about this app with little evidence about your own track record. Do NOT compensate by proposing something speculative or sweeping. Prefer a small, concretely-grounded proposal you can justify from the gathered sources alone, and return proposal: null rather than filing a guess.`
    );
  }
  if (liDegraded) {
    guidance.push(
      '',
      `GUIDANCE — your own execution is degraded (LI run success is under ${LI_DEGRADED_SUCCESS_THRESHOLD}%): the problem may be THIS LOOP, not the app. Favor a narrowly-scoped, low-risk proposal that a coding agent can finish, and do not mark anything trivial+safe for hand-off while your runs are failing this often. A loop-meta proposal that fixes the failure mode may be the highest-value item this run.`
    );
  }

  return [
    'LI self-evaluation (deterministic — computed from this loop\'s own record, not a model\'s opinion):',
    `- Reasoning confidence: ${confidence} (${signalCount} of 3 self-signals available)`,
    ...lines,
    ...guidance
  ].join('\n');
}

/**
 * Clamp a task-type / proposal-domain label so one pathological key (e.g. a mission
 * task type embedding an unbounded mission name) can't blow the scope-awareness block
 * budget. Shared by both avoid/prefer signals below.
 */
function clampScopeLabel(label) {
  return label.length > SCOPE_AWARENESS_MAX_TYPE_LEN
    ? `${label.slice(0, SCOPE_AWARENESS_MAX_TYPE_LEN - 1)}…`
    : label;
}

/**
 * Render an avoid/prefer prompt block from pre-classified item lists — the presentation
 * both scope-awareness signals share (#2760 install-wide task-type rates, #2765
 * per-proposal-domain execution rates). Owns the sort (worst-first avoid, best-first
 * prefer), the per-list cap + "…and N more" overflow, and the empty-guard, so a tweak
 * to any of those lands in one place. Callers supply their own classified `avoid`/
 * `prefer` lists, the per-item `fmt`, and the two headers — the only parts that
 * legitimately differ between the two signals. Returns '' when both lists are empty.
 */
function renderAvoidPreferSections({ avoid = [], prefer = [], fmt, avoidHeader, preferHeader }) {
  if (!avoid.length && !prefer.length) return '';
  avoid.sort((a, b) => a.rate - b.rate);  // worst-first — sharpest signal at the top
  prefer.sort((a, b) => b.rate - a.rate); // best-first
  const section = (header, items) => {
    const shown = items.slice(0, SCOPE_AWARENESS_MAX_PER_LIST);
    const more = items.length - shown.length;
    const lines = shown.map(fmt);
    if (more > 0) lines.push(`- …and ${more} more`);
    return `${header}\n${lines.join('\n')}`;
  };
  const sections = [];
  if (avoid.length) sections.push(section(avoidHeader, avoid));
  if (prefer.length) sections.push(section(preferHeader, prefer));
  return sections.join('\n\n');
}

/**
 * Scope-awareness report (#2760). Classifies each CoS task TYPE by its completion rate
 * into low-completion and high-completion lists, as directional context for the
 * reasoner. Pure — takes the already-parsed per-type metrics map (the `summary`
 * gatherSources builds from learning.byTaskType) and returns a report string, or ''
 * when no type has enough runs to qualify either way.
 *
 * IMPORTANT (codex P1): this is per-task-TYPE, install-wide completion telemetry — NOT
 * a per-proposal execution record. An LI proposal is later implemented through a
 * claim/plan/handoff task whose task type does NOT carry the proposal's domain (a
 * handoff becomes `internal-task`; a claimed issue runs under the claim task type), so
 * these buckets are populated by independently-scheduled jobs, not by LI's own
 * proposals bucketed by subject. The block is therefore framed as "work of this KIND
 * tends to (not) get finished here" — useful directional context (especially LI's own
 * reasoning-run type, self-improve:layered-intelligence, which IS LI's execution) — and
 * deliberately NOT a claim that a given proposal maps 1:1 onto a listed type. Proper
 * per-proposal-domain outcome correlation is tracked as a follow-up (#2765).
 *
 * `metricsByType[type] = { lifetimeSuccessRate, lifetimeCompleted, recentSuccessRate, recentCompleted, ... }`.
 *
 * Classification judges on the EFFECTIVE rate — the recency-windowed rate when the
 * window has enough samples, else lifetime — NOT the raw lifetime rate. This matters
 * for the issue's "dynamic adjustment" requirement: the lifetime rate barely decays
 * (an old failure burst depresses it near-permanently), so a scope that has actually
 * recovered would stay stuck on the avoid list for dozens of runs. Using the windowed
 * rate lets a recovered scope leave "avoid" promptly — and, critically, this uses the
 * SAME window floor as the scheduler's own skip logic
 * (EFFECTIVE_RATE_MIN_WINDOW_SAMPLES, the threshold in computeEffectiveSuccessRate /
 * isSkipCandidate): the window is trusted only at >= that many in-window runs, so a
 * single noisy recent result can't flip a lifetime-reliable scope to avoid (or vice
 * versa). Below that floor the lifetime rate governs, exactly as the scheduler does,
 * so this advisory list moves in the same direction the scheduler acts on. The base
 * sample floor still gates on LIFETIME completed: a scope needs enough TOTAL evidence
 * to be judged at all. Each rendered rate is paired with the run count of the SAME
 * basis (windowed count when the window governs, lifetime count otherwise) so the
 * "N% over M runs" line never mixes a windowed rate with a lifetime count.
 *
 * The thresholds (50/75) are deliberately NOT the scheduler's 30% hard-skip line: this
 * steering is advisory (it nudges what LI PROPOSES, it never suppresses execution), so
 * a wider, more cautious net is correct here. LI still MAY propose in an avoid scope
 * when it is genuinely the highest-value work — it just has to justify doing so.
 */
export function computeScopeAwareness({ metricsByType = {} } = {}) {
  const avoid = [];
  const prefer = [];
  for (const [type, m] of Object.entries(metricsByType || {})) {
    const lifetimeN = m?.lifetimeCompleted || 0;
    if (lifetimeN < SCOPE_AWARENESS_MIN_SAMPLE) continue; // not enough total evidence to judge
    // Effective rate: trust the recency window ONLY when it carries enough samples —
    // the same EFFECTIVE_RATE_MIN_WINDOW_SAMPLES floor the scheduler's
    // computeEffectiveSuccessRate uses — so one noisy recent run can't flip a
    // lifetime-reliable scope. Below the floor (including an empty window, where
    // recentSuccessRate is null, not 0 — #2460), lifetime governs. Pair the rate with
    // the count of its own basis so the rendered "N% over M runs" is truthful.
    const useWindow = m?.recentCompleted >= EFFECTIVE_RATE_MIN_WINDOW_SAMPLES
      && typeof m?.recentSuccessRate === 'number';
    const rate = useWindow ? m.recentSuccessRate : m?.lifetimeSuccessRate;
    if (typeof rate !== 'number') continue; // a never-run scope stays neutral
    const n = useWindow ? m.recentCompleted : lifetimeN;
    if (rate < SCOPE_AVOID_SUCCESS_THRESHOLD) avoid.push({ type, rate, n });
    else if (rate >= SCOPE_PREFER_SUCCESS_THRESHOLD) prefer.push({ type, rate, n });
  }
  // Honest framing (#2760, codex P1): these are per-task-TYPE completion rates for the
  // whole install — NOT a per-proposal execution record. An LI proposal is implemented
  // through a claim/plan/handoff task whose type does not carry the proposal's domain,
  // so this is directional context ("work of this kind tends to (not) get finished
  // here"), not a claim that a given proposal maps 1:1 onto a listed type.
  return renderAvoidPreferSections({
    avoid,
    prefer,
    fmt: ({ type, rate, n }) => `- ${clampScopeLabel(type)}: ${Math.round(rate)}% completed over ${n} runs`,
    avoidHeader: `LOW-COMPLETION task types — work of this kind is finished below ${SCOPE_AVOID_SUCCESS_THRESHOLD}% of the time on this install:`,
    preferHeader: `HIGH-COMPLETION task types — finished at or above ${SCOPE_PREFER_SUCCESS_THRESHOLD}%:`
  });
}

/**
 * Aggregate LI proposal EXECUTION outcomes by proposal DOMAIN (scope) (#2765).
 * Pure. Unlike computeScopeAwareness — which borrows install-wide CoS
 * per-task-TYPE completion rates that a proposal only loosely maps onto — this is a
 * TRUE per-proposal record: each data point is one of LI's OWN filed proposals that
 * was handed off and executed, keyed by the domain (scope) it was proposed under.
 *
 * `outcomes` is the app's outcome records (from listOutcomes); only records carrying
 * a resolved `executionOutcome` AND a `scope` contribute. Returns
 * `{ [scope]: { completed, succeeded, successRate, failureSummary } }` (empty when
 * nothing has been executed yet). The acceptance signal for #2765: after one proposal
 * in domain X is executed, only X's bucket moves.
 *
 * `failureSummary` (#2764 §3) carries the per-domain execution-FAILURE taxonomy tally
 * so a low execution rate no longer arrives without its cause: it is the shared
 * `summarizeExecutionFailures` engine run over ONLY this domain's records (the engine
 * itself keeps just the failures), the "filter per-domain, then reuse the existing
 * summariser" join #2764 §3 asks for. Every bucket carries one — a domain with zero
 * failed hand-offs simply reports `total: 0`, the honest "nothing to explain" reading.
 */
export function computeExecutionByDomain(outcomes = []) {
  // Group each executed record by its domain first, so the failure taxonomy can be
  // tallied over that domain's OWN records rather than the install-wide set.
  const recordsByScope = new Map();
  for (const r of Array.isArray(outcomes) ? outcomes : []) {
    if (!r || typeof r !== 'object') continue;
    if (!PROPOSAL_EXECUTION_OUTCOMES.includes(r.executionOutcome)) continue;
    const scope = typeof r.scope === 'string' && r.scope.trim() ? r.scope.trim() : null;
    if (!scope) continue;
    if (!recordsByScope.has(scope)) recordsByScope.set(scope, []);
    recordsByScope.get(scope).push(r);
  }
  const byDomain = {};
  for (const [scope, records] of recordsByScope) {
    const completed = records.length;
    const succeeded = records.filter(r => r.executionOutcome === 'success').length;
    byDomain[scope] = {
      completed,
      succeeded,
      successRate: Math.round((succeeded / completed) * 100),
      // Reuse the shared taxonomy engine on this domain's slice — it discards the
      // successes internally, so passing the whole slice yields this domain's own
      // failure shape without a second pre-filter here.
      failureSummary: summarizeExecutionFailures(records)
    };
  }
  return byDomain;
}

/**
 * Render the dominant execution-failure causes from a domain's `failureSummary`
 * (#2764 §3) as a compact clause for the per-domain avoid line. Reuses the shared
 * `formatExecutionFailure` gloss so the wording matches the install-wide failure line
 * in computeOutcomesReport. Returns '' when the domain holds NO diagnosed failure — a
 * pure-`unknown`/`unclassified` (or failure-free) domain adds no cause clause rather
 * than a hollow "failed for unknown reasons" tail on every low-execution line.
 */
function formatDominantFailureCause(failureSummary, limit = 2) {
  const entries = Array.isArray(failureSummary?.entries) ? failureSummary.entries : [];
  if (entries.length === 0) return '';
  const listed = entries
    .slice(0, limit)
    .map(({ category, count }) => `${formatExecutionFailure(category)} (${count})`)
    .join('; ');
  return `failing mostly on ${listed}`;
}

/**
 * Is this a proposal DOMAIN whose OWN hand-offs chronically fail — enough executed
 * hand-offs to be evidence (PROPOSAL_EXECUTION_MIN_SAMPLE) AND a success rate below
 * the coin-flip avoid line (SCOPE_AVOID_SUCCESS_THRESHOLD)? The single load-bearing
 * definition of "on the avoid list", shared so the reasoner-facing prompt
 * (computeProposalExecutionAwareness) and the deterministic hand-off gate
 * (computeHandoffRouting) can NEVER disagree about which domains qualify — the
 * design requires the prompt's avoid list and the gate to name the same set. Takes
 * a per-domain bucket from computeExecutionByDomain (or undefined when the domain
 * has no execution history → false).
 */
function isAvoidDomain(bucket) {
  return !!bucket
    && bucket.completed >= PROPOSAL_EXECUTION_MIN_SAMPLE
    && bucket.successRate < SCOPE_AVOID_SUCCESS_THRESHOLD;
}

/**
 * Render the per-proposal-DOMAIN execution avoid/prefer split for the reasoning
 * prompt (#2765) — the real per-proposal signal the #2760 install-wide scope block
 * could only approximate. Returns '' when no domain clears the sample floor, so
 * buildPrompt omits the block. Mirrors computeScopeAwareness's 50/75 thresholds and
 * bounded rendering, but keys on the proposal's own scope and carries NO
 * "directional context only" caveat: this IS how LI's own proposals in each domain
 * fared, so the reasoner can steer toward domains it actually executes and away from
 * domains where its own hand-offs fail even after the proposal was accepted.
 */
export function computeProposalExecutionAwareness({ outcomes = [] } = {}) {
  const byDomain = computeExecutionByDomain(outcomes);
  const avoid = [];
  const prefer = [];
  for (const [scope, bucket] of Object.entries(byDomain)) {
    // The per-domain failure CAUSE (#2764 §3) is surfaced only for domains that clear
    // this floor — i.e. only where the domain is already listed as low-execution. A
    // single failed hand-off below the floor is the install-wide early-signal case the
    // "Why LI's own hand-offs failed" line in computeOutcomesReport already reports, so
    // we do not also emit a one-sample per-domain cause here (it would read as a trend
    // off n=1).
    if (bucket.completed < PROPOSAL_EXECUTION_MIN_SAMPLE) continue; // not enough executions to judge this domain
    if (isAvoidDomain(bucket)) avoid.push({ scope, rate: bucket.successRate, n: bucket.completed, cause: formatDominantFailureCause(bucket.failureSummary) });
    else if (bucket.successRate >= SCOPE_PREFER_SUCCESS_THRESHOLD) prefer.push({ scope, rate: bucket.successRate, n: bucket.completed });
  }
  return renderAvoidPreferSections({
    avoid,
    prefer,
    // Only the avoid list carries a `cause`; a preferred (reliably-executed) domain has
    // no failure shape worth naming, so its clause is simply absent.
    fmt: ({ scope, rate, n, cause }) => `- ${clampScopeLabel(scope)}: LI implemented ${rate}% of its own ${scope} proposals successfully over ${n} executed${cause ? ` — ${cause}` : ''}`,
    avoidHeader: `LOW-EXECUTION proposal domains — LI's OWN hand-offs in these domains succeed below ${SCOPE_AVOID_SUCCESS_THRESHOLD}% of the time; a proposal here needs a strong justification or a narrower slice:`,
    preferHeader: `HIGH-EXECUTION proposal domains — LI reliably implements its own proposals here (at or above ${SCOPE_PREFER_SUCCESS_THRESHOLD}%):`
  });
}

// Header for the cross-reference block (#2764 §3). Names the pattern the block exists
// to surface: a domain LI PROPOSES well (its proposals earn merges) yet EXECUTES
// poorly (its own hand-offs there fail), which neither liOutcomes (merge rate alone)
// nor liProposalExecution (execution rate alone) puts side by side.
const CROSS_REFERENCE_HEADER = "Domains where LI PROPOSES well but EXECUTES poorly — the proposal earns a merge, yet LI's OWN hand-off to implement it tends to fail with the named cause. These are blind spots: you pick the right work here but can't finish it as handed off. Narrow such a proposal to a slice an agent can complete, split it, or route it to a human — don't re-file the same shape expecting a different execution result:";

/**
 * Cross-reference MERGED-proposal success against EXECUTION-failure modes within the
 * SAME domain (#2764 §3). Pure + side-effect-free like the sibling report functions;
 * derives only from the outcome records already loaded (no new store read, no AI/tracker
 * call). The unique signal it adds over liOutcomes (per-scope merge rate) and
 * liProposalExecution (per-domain execution rate) is the CONTRAST between them: a domain
 * whose proposals the user merges but whose hand-offs then fail is "proposes well,
 * executes poorly" — the reasoner should keep proposing there but narrow the scope, not
 * abandon the domain (which a low execution rate read alone might imply).
 *
 * A domain qualifies only when BOTH signals are present: at least one MERGED proposal
 * (the "proposes well" side — otherwise the domain is just failing outright, which
 * liProposalExecution already covers) AND at least one DIAGNOSED failed hand-off (the
 * "executes poorly" side, with a concrete cause to name — a purely `unknown`/
 * `unclassified` failure history has no actionable mode to cross-reference). Merge rate
 * is measured over RESOLVED proposals only — the same denominator summarizeOutcomeStats
 * uses for its rawMergeRate (pending ≠ a merge verdict), not computeOutcomesReport's
 * per-scope rate, which divides by all filed. Sorted sharpest-execution-problem first;
 * bounded like the avoid/prefer lists. Returns '' when no domain qualifies, so
 * buildPrompt omits the block.
 */
export function computeCrossReferenceAnalysis({ outcomes = [] } = {}) {
  const records = Array.isArray(outcomes) ? outcomes : [];
  const byDomain = computeExecutionByDomain(records); // per-domain failure taxonomy (self-guards bad records)

  // Per-domain merge stats over RESOLVED proposals (pending ≠ a merge verdict).
  const mergeByScope = new Map();
  for (const o of records) {
    if (!o || typeof o !== 'object') continue;
    const scope = typeof o.scope === 'string' && o.scope.trim() ? o.scope.trim() : null;
    if (!scope) continue;
    if (!PROPOSAL_OUTCOMES.includes(o.outcome)) continue; // unresolved: no verdict yet
    const agg = mergeByScope.get(scope) || { merged: 0, resolved: 0 };
    agg.resolved += 1;
    if (o.outcome === 'merged') agg.merged += 1;
    mergeByScope.set(scope, agg);
  }

  const qualifying = [];
  for (const [scope, exec] of Object.entries(byDomain)) {
    const merge = mergeByScope.get(scope);
    if (!merge || merge.merged < 1) continue; // "proposes well" side needs a merge
    const { entries, diagnosed, total: failTotal } = exec.failureSummary;
    if (diagnosed < 1) continue; // "executes poorly" side needs a diagnosed failed hand-off
    const top = entries[0];
    qualifying.push({
      scope,
      mergeRate: Math.round((merge.merged / merge.resolved) * 100),
      merged: merge.merged,
      resolved: merge.resolved,
      cause: top.category,
      causeCount: top.count,
      failTotal,
      diagnosed
    });
  }
  if (!qualifying.length) return '';
  // Sharpest execution problem first (most diagnosed failures), ties broken by the
  // strongest "proposes well" contrast (highest merge rate) so the output is stable.
  qualifying.sort((a, b) => b.diagnosed - a.diagnosed || b.mergeRate - a.mergeRate);
  const shown = qualifying.slice(0, SCOPE_AWARENESS_MAX_PER_LIST);
  const more = qualifying.length - shown.length;
  const lines = shown.map(q =>
    `- ${clampScopeLabel(q.scope)}: proposals merge at ${q.mergeRate}% (${q.merged}/${q.resolved}) but hand-offs here fail on ${q.cause} (${q.causeCount} of ${q.failTotal})`
  );
  if (more > 0) lines.push(`- …and ${more} more`);
  return `${CROSS_REFERENCE_HEADER}\n${lines.join('\n')}`;
}

/**
 * Deterministic hand-off routing gate (#2764 §4). Given a proposal and the app's
 * historical outcome records, decides whether a trivial+safe proposal may be
 * auto-handed-off to a coding agent NOW, or must instead be filed for a human —
 * because LI's OWN prior hand-offs in that domain chronically fail. This is the
 * SYSTEM-side enforcement of the same signal the reasoner is merely WARNED about
 * in the liProposalExecution / liCrossReference prompt blocks: even when the
 * reasoner marks a proposal trivial+safe, the gate suppresses the auto-hand-off
 * for a domain whose track record says the hand-off will just fail again.
 *
 * Pure + side-effect-free, like the sibling compute* report functions — derives
 * only from the `li-outcomes` records already loaded (no new AI/tracker/store
 * call). The just-filed proposal cannot skew this: computeExecutionByDomain only
 * counts records carrying a resolved `executionOutcome`, which a freshly-filed
 * proposal has not got yet.
 *
 * Shares the isAvoidDomain classifier with computeProposalExecutionAwareness so the
 * gate and the reasoner-facing prompt can NEVER disagree about which domains are
 * "chronically failing": a domain qualifies only when it has at least
 * PROPOSAL_EXECUTION_MIN_SAMPLE executed hand-offs AND its success rate is below
 * SCOPE_AVOID_SUCCESS_THRESHOLD — the SAME floor + threshold that puts a domain on
 * the reasoner's avoid list.
 *
 * Returns:
 *   - `{ handoff: true, reason: null }` — allow the auto-hand-off, when the
 *     proposal has no scope (can't judge), the domain is below the sample floor,
 *     the domain has no execution history, or its rate is at/above the threshold.
 *   - `{ handoff: false, domain, rate, n, cause, reason }` — SUPPRESS: file for a
 *     human instead. `reason` names the domain, rate, sample size, and (when a
 *     dominant failure cause is diagnosed) the cause — reusing formatDominantFailureCause,
 *     which returns '' for a purely unknown/unclassified domain so the cause clause
 *     is simply omitted there.
 *
 * @param {object} args
 * @param {object} args.proposal - the reasoner's proposal ({ scope, ... }).
 * @param {Array}  [args.outcomes] - the app's li-outcomes records.
 * @returns {{ handoff: boolean, reason: string|null, domain?: string, rate?: number, n?: number, cause?: string }}
 */
export function computeHandoffRouting({ proposal, outcomes = [] } = {}) {
  // No scope → we can't map the proposal to a domain's track record, so we can't
  // justify suppressing the hand-off. Allow, as before §4 existed.
  const domain = typeof proposal?.scope === 'string' && proposal.scope.trim() ? proposal.scope.trim() : null;
  if (!domain) return { handoff: true, reason: null };

  const byDomain = computeExecutionByDomain(outcomes);
  const bucket = byDomain[domain];
  // Below the floor, no bucket, or at/above the threshold → no signal to suppress on,
  // so allow the hand-off exactly as today. isAvoidDomain is the SAME predicate
  // computeProposalExecutionAwareness uses for its avoid list, so the gate and the
  // reasoner-facing prompt agree on which domains are "chronically failing".
  if (!isAvoidDomain(bucket)) return { handoff: true, reason: null };

  const cause = formatDominantFailureCause(bucket.failureSummary);
  const reason = `${domain} hand-offs succeed ${bucket.successRate}% over ${bucket.completed} executed — filing for human review instead of auto-hand-off${cause ? ` (${cause})` : ''}`;
  return { handoff: false, domain, rate: bucket.successRate, n: bucket.completed, cause, reason };
}

// Source keys that buildPrompt renders as their OWN dedicated block (with tailored
// guidance) instead of dumping into the generic "### <key>\n<value>" source list.
// Keeping them in one named set — rather than accreting `&& k !== 'x'` clauses on the
// filter — documents WHY these keys are special and gives the next dedicated-block
// signal a single edit point.
const BESPOKE_SOURCE_BLOCK_KEYS = new Set(['plannedWork', 'scopeGuidance']);

/**
 * Build the JSON-only reasoning prompt for one app. Deterministic: given the
 * gathered sources, open issues, and config, produces the exact string sent to
 * the model. Meta/self scopes are only offered when the app is PortOS.
 * `outcomesReport` (from computeOutcomesReport) is injected as a `liOutcomes`
 * block with calibration guidance when non-empty (#2428). `selfEvalReport` (from
 * computeSelfEvalSummary) is injected as a `liSelfEval` block the same way (#2700).
 * `sources.scopeGuidance` (from computeScopeAwareness) is injected as a
 * `liScopeAwareness` block the same way (#2760). `proposalExecutionReport` (from
 * computeProposalExecutionAwareness) is injected as a `liProposalExecution` block —
 * the TRUE per-proposal-domain execution record #2760 could only approximate (#2765).
 * `crossReferenceReport` (from computeCrossReferenceAnalysis) is injected as a
 * `liCrossReference` block that names domains LI proposes well but executes poorly (#2764 §3).
 * Finally, the static `liPlaybook` block (LI_PROPOSAL_PLAYBOOK, #2763) is ALWAYS
 * appended: the a-priori scope/task-type/goal rule set LI needs from run one, before
 * any per-app outcome data exists.
 */
export function buildPrompt({ app, config, sources = {}, openIssues = [], isPortos = false, outcomesReport = '', selfEvalReport = '', proposalExecutionReport = '', crossReferenceReport = '' }) {
  const allowed = (config.allowedScopes || []).filter(s =>
    isScopeAllowed({ scope: s, allowedScopes: config.allowedScopes, isPortos })
  );
  const scopeLines = allowed.map(s => `  - ${s}`).join('\n');
  // plannedWork renders as its OWN block (below) rather than inside the generic
  // source list, so the cross-reference guidance is guaranteed to sit directly
  // under the committed backlog it refers to instead of drifting to wherever
  // object key order happens to put it.
  const sourceBlocks = Object.entries(sources)
    .filter(([k]) => !BESPOKE_SOURCE_BLOCK_KEYS.has(k))
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `### ${k}\n${v.trim()}`)
    .join('\n\n');
  const openList = openIssues.length
    ? openIssues.map(i => `- #${i.number ?? '?'} [${i.slug || extractSlugFromBody(i.body) || 'no-slug'}] ${i.title || ''}`).join('\n')
    : '(none)';

  // Nudge a managed app with no own-performance signal (no METRICS.md gathered)
  // toward adding one, so future runs can judge real performance. PortOS is exempt
  // — it measures itself through cosMetrics. Also gate on the source being ENABLED:
  // if the user deliberately turned appMetrics off, a METRICS.md may well exist, so
  // "add a METRICS.md" would be a misleading (and possibly redundant) proposal.
  const hasAppMetrics = Boolean(typeof sources.appMetrics === 'string' && sources.appMetrics.trim());
  const appMetricsEnabled = config.sources?.appMetrics !== false;
  const metricsGuidance = (!isPortos && appMetricsEnabled && !hasAppMetrics)
    ? '\nThis app exposes no own-performance metrics yet (no METRICS.md). If you lack the data to judge how it is doing against its goals, a high-value app-data-gap proposal is to add a METRICS.md documenting how the app measures success — its user-success/KPI signals and where its production telemetry or data lives — so future runs can reason about real performance.\n'
    : '';

  const handoffNote = config.handoff?.enabled
    ? '\nHand-off: a proposal you mark BOTH "complexity":"trivial" AND "safe":true may be handed directly to a coding agent to implement now (not just filed). Only mark a proposal trivial+safe when it is small, self-contained, and carries no regression or data-loss risk — when in doubt, use a higher complexity or "safe":false so a human triages it first. Note: even a trivial+safe proposal is filed for a human (not auto-handed-off) when it falls in a domain where LI\'s own past hand-offs chronically fail, so prefer to narrow such a proposal to a slice an agent can actually finish.\n'
    : '';

  // The committed backlog (#2698) + the instruction to check against it. Emitted
  // whenever gatherPlannedWork produced ANY string — including its explicit
  // "could not be read" marker, which must still reach the reasoner: silently
  // dropping an unavailable read would look identical to "this app has nothing
  // planned" and license a proposal straight into committed work.
  const plannedWorkBlock = (typeof sources.plannedWork === 'string' && sources.plannedWork.trim())
    ? `\n### plannedWork\n${sources.plannedWork.trim()}\n\n${PLANNED_WORK_GUIDANCE}\n`
    : '';

  // Feedback loop (#2428): show the reasoner how its own past proposals fared so
  // it can calibrate scope/merge-rate instead of proposing in a vacuum.
  const outcomesBlock = (typeof outcomesReport === 'string' && outcomesReport.trim())
    ? `\n### liOutcomes\n${outcomesReport.trim()}\n\nUse this data to calibrate your proposal: prefer scopes with higher merge rates, avoid patterns that were repeatedly rejected, and consider that lower-merge scopes may need more justification.\n`
    : '';

  // Self-evaluation (#2700): the loop's own quality check BEFORE it files, so it
  // can decline instead of learning only from a later rejection. Carries its own
  // low-confidence / degraded-execution guidance (computeSelfEvalSummary), which is
  // why no extra instruction sentence is appended here — the block is self-contained
  // and its guidance is conditional on what the signals actually say.
  const selfEvalBlock = (typeof selfEvalReport === 'string' && selfEvalReport.trim())
    ? `\n### liSelfEval\n${selfEvalReport.trim()}\n\nWeigh this against the sources above before you commit to a proposal. Filing nothing (proposal: null) is a legitimate, and sometimes the correct, outcome — a marginal issue costs the user triage time and lowers your merge rate further.\n`
    : '';

  // Scope-awareness (#2760): install-wide completion rates by CoS task TYPE — directional
  // context for how reliably different KINDS of work get finished here. PortOS-only
  // (codex P2): these rates are this install's own CoS execution history, meaningless to
  // a managed app, so the block is gated on isPortos even if a managed app enabled the
  // cosMetrics source. It is context, not a rule (codex P1): a proposal does not map 1:1
  // onto a listed type, so treat a low-completion type as a reason for extra scrutiny /
  // a narrower scope, not a hard veto.
  const scopeGuidanceBlock = (isPortos && typeof sources.scopeGuidance === 'string' && sources.scopeGuidance.trim())
    ? `\n### liScopeAwareness\n${sources.scopeGuidance.trim()}\n\nThese are per-task-type completion rates for THIS install — how reliably each KIND of work tends to get finished, not a per-proposal record (your proposals don't map 1:1 onto these types). Use it as directional context: a proposal whose implementation resembles a low-completion type deserves extra scrutiny or a narrower scope; high-completion kinds are safer bets. A low rate on self-improve:layered-intelligence is LI's OWN reasoning-run rate — a direct signal to propose conservatively. Where the liProposalExecution block below covers a domain, prefer it: it is a direct per-proposal record, whereas these buckets are only directional.\n`
    : '';

  // Per-proposal-domain execution record (#2765): unlike liScopeAwareness above —
  // which borrows install-wide per-task-TYPE rates a proposal only loosely maps onto —
  // this keys on how LI's OWN proposals in each domain actually fared once handed off
  // and executed. It carries NO "directional only" caveat because the mapping is real,
  // so it is the authoritative avoid/prefer signal wherever it has data. The report is
  // pre-gated on the outcomes source by the caller (built from the same records), so no
  // isPortos re-check here — the block simply renders when execution history exists.
  const proposalExecutionBlock = (typeof proposalExecutionReport === 'string' && proposalExecutionReport.trim())
    ? `\n### liProposalExecution\n${proposalExecutionReport.trim()}\n\nThis is a DIRECT record of how LI's own proposals in each domain fared once implemented — not directional context. Favor domains LI executes reliably; for a low-execution domain, either narrow the proposal to a slice an agent can finish or justify why it is still the highest-value work despite the track record.\n`
    : '';

  // Cross-reference (#2764 §3): the CONTRAST liOutcomes and liProposalExecution can't
  // show on their own — a domain LI proposes well (merges) but executes poorly (its
  // hand-offs fail with a named cause). It carries its own actionable guidance in the
  // header, so no extra instruction sentence is appended. Gated on the outcomes source
  // by the caller (built from the same records), so no isPortos re-check here.
  const crossReferenceBlock = (typeof crossReferenceReport === 'string' && crossReferenceReport.trim())
    ? `\n### liCrossReference\n${crossReferenceReport.trim()}\n`
    : '';

  // Proposal Playbook (#2763): the STANDING, a-priori rule set — always rendered.
  // Unlike the data blocks above (which appear only once enough per-app outcome data
  // accumulates), the playbook is the guidance LI needs from run one, when it would
  // otherwise be proposing blind. It sits last so it is the freshest instruction
  // before the JSON contract, and its guidance sentence defers to any live data block
  // above that has real numbers contradicting a general rule.
  const playbookBlock = LI_PROPOSAL_PLAYBOOK
    ? `\n### liPlaybook\n${LI_PROPOSAL_PLAYBOOK}\n\n${LI_PLAYBOOK_GUIDANCE}\n`
    : '';

  return `You are the Layered Intelligence reasoner for the app "${app.name}". Your job is to evaluate how THIS app is performing against its OWN goals and purpose${isPortos ? '' : ', not how well PortOS\'s tooling manages it'}. Decide the SINGLE highest-value improvement to propose this run (signal, not noise), grounded in the app's own goals and its own performance metrics (user success, KPIs, production telemetry). You never write code; you return structured JSON that a deterministic system files as ONE tracker issue.
${handoffNote}${metricsGuidance}
Rules & guidance from the operator:
${config.rules?.trim() || '(none)'}

Allowed proposal scopes (you MUST pick one of these for any proposal):
${scopeLines || '  (none — return proposal: null)'}
${isPortos ? '' : 'Note: meta/self scopes are unavailable on this app; frame any data need as an "app-data-gap" against this app.\n'}
Already-open tracked issues (DO NOT duplicate these — reuse their slug only if genuinely the same work):
${openList}

Gathered sources:
${sourceBlocks || (plannedWorkBlock ? '(no other sources available — you may propose an app-data-gap to add telemetry)' : '(no sources available — you may propose an app-data-gap to add telemetry)')}
${plannedWorkBlock}${outcomesBlock}${selfEvalBlock}${scopeGuidanceBlock}${proposalExecutionBlock}${crossReferenceBlock}${playbookBlock}
Respond with JSON only (no markdown fences):
{
  "analysis": "brief reasoning summary",
  "proposal": {              // null if nothing worth filing this run
    "scope": "<one allowed scope>",
    "slug": "kebab-stable-id",
    "title": "short imperative title",
    "body": "markdown detail for the coding agent",
    "value": "why this is the single highest-value item now",
    "complexity": "trivial | moderate | complex",   // honest effort/risk estimate
    "safe": false            // true ONLY if a coding agent could implement it end-to-end with no regression/data-loss risk
  },
  "pause": {                 // null if not pausing
    "blockOnIssue": "this" or <existing issue number>,
    "reason": "why the loop should pause on this app until resolved"
  }
}`;
}

// ---------------------------------------------------------------------------
// I/O layer — gather + filers. Injectable deps keep these testable.
// ---------------------------------------------------------------------------

/** Run a CLI, resolving `{ code, stdout, stderr }` (never rejects). */
function runCli(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: false, windowsHide: true, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.on('error', err => resolve({ code: -1, stdout: '', stderr: err.message }));
  });
}

/**
 * Why a planned-work read came back empty-handed. Rendered INSTEAD of a listing so
 * a failed tracker read can never be mistaken for "this app has nothing planned" —
 * the two are opposite instructions to the reasoner (be conservative vs. the field
 * is wide open), and collapsing them is exactly the failure the sentinel rule in
 * CLAUDE.md exists to prevent.
 */
export function plannedWorkUnavailable(why) {
  return `${PLANNED_WORK_UNAVAILABLE_PREFIX} (${why}). Do NOT treat this as "nothing is planned" — this app may well have a committed backlog that simply could not be listed this run. Be conservative: prefer proposal: null over filing work that might already be in scope.`;
}

/**
 * Whether a gathered plannedWork string is an actual LISTING of committed work —
 * i.e. something the reasoner can be told to go read — as opposed to one of the
 * two sentinels ("nothing is planned" / "could not be read"). Both sentinels are
 * meaningful in the prompt and still render, but neither is a backlog: telling
 * the reasoner its proposals "may be overlapping with committed work — review the
 * plannedWork source above" directly beneath a block stating no planned work
 * exists is a contradiction that just biases it toward filing nothing.
 */
export function hasPlannedWorkListing(plannedWork) {
  if (typeof plannedWork !== 'string') return false;
  const text = plannedWork.trim();
  if (!text || text === PLANNED_WORK_NONE) return false;
  return !text.startsWith(PLANNED_WORK_UNAVAILABLE_PREFIX);
}

/**
 * Render a planned-work item list into the prompt block. Pure.
 *
 * Reports the count of everything it was HANDED even when the rendered list is
 * truncated to `maxItems`, so the reasoner knows it is seeing the top of a larger
 * backlog rather than all of it — 15 shown out of 100 must not read as "there are
 * only 15". Note the caller's own read is capped too (the tracker lists cap at
 * 100), so on a very large backlog this count is itself a floor, not a census.
 */
export function formatPlannedWork(items, { maxItems = PLANNED_WORK_MAX_ITEMS, maxChars = PLANNED_WORK_MAX_CHARS } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(i => i && typeof i === 'object' && (i.title || i.number != null));
  if (list.length === 0) return PLANNED_WORK_NONE;
  const top = list.slice(0, maxItems);
  const lines = top.map(i => {
    const ref = i.number != null ? `#${i.number} ` : '';
    const meta = [
      i.priority ? `priority: ${i.priority}` : null,
      Array.isArray(i.labels) && i.labels.length ? `labels: ${i.labels.join(', ')}` : null
    ].filter(Boolean).join('; ');
    return `- ${ref}${(i.title || '').trim()}${meta ? ` (${meta})` : ''}`;
  });
  const header = list.length > top.length
    ? `${list.length} items of actively-planned work the user has already committed to (showing the top ${top.length}):`
    : `${list.length} item(s) of actively-planned work the user has already committed to:`;
  return [header, ...lines].join('\n').slice(0, maxChars);
}

/**
 * Extract a PLAN.md's UNCHECKED (`- [ ]`) items — the plan tracker's equivalent of
 * a `plan`-labeled issue. A `- [x]` item is finished work, not committed-and-
 * pending, so it is excluded: proposing something already done is a different
 * (and already-handled) problem than proposing something already scheduled.
 */
export function extractPlannedPlanItems(planContent) {
  if (typeof planContent !== 'string') return [];
  const items = [];
  const re = /^[ \t]*[-*][ \t]+\[ \][ \t]*(\S.*)$/gm;
  let m;
  while ((m = re.exec(planContent))) {
    const title = m[1].replace(/\s+/g, ' ').trim();
    if (title) items.push({ number: null, title: title.slice(0, 200), labels: [], priority: null });
  }
  return items;
}

/**
 * Gather the app's actively-planned work — the backlog the user has ALREADY
 * committed to — so the reasoner can cross-reference a proposal against it before
 * filing (#2698). A deterministic tracker read: files + `gh`/`glab`/Jira REST, and
 * NO LLM call (the no-cold-bootstrap rule).
 *
 * Returns a prompt-ready string, or `null` when the source does not apply at all
 * (an unresolvable tracker: no forge CLI, no Jira coords, no repo path) — three
 * distinct states, never collapsed:
 *   - `null`                     → nothing to say; buildPrompt omits the block
 *   - `plannedWorkUnavailable()` → the read FAILED; be conservative
 *   - a listing / PLANNED_WORK_NONE → the read SUCCEEDED and is trustworthy
 *     (a plan-tracked app with no PLAN.md at all is a real PLANNED_WORK_NONE)
 *
 * Deps are injectable so tests drive every branch without a live tracker.
 */
export async function gatherPlannedWork({
  filer,
  forgeCli,
  cwd,
  jira,
  listForge = listForgeIssues,
  listJira = listJiraIssues,
  readFileFn = tryReadFile
} = {}) {
  if (filer === 'forge' && forgeCli && cwd) {
    const { ok, issues } = await listForge({ cli: forgeCli, cwd, label: PLANNED_WORK_LABEL, state: 'open' });
    if (!ok) return plannedWorkUnavailable(`the ${forgeCli} issue list failed`);
    // gh honors --state open, but glab's label list can still surface a closed
    // issue depending on version — re-filter so a done item never reads as pending.
    const open = issues.filter(i => i.state === 'open');
    return formatPlannedWork(open.map(i => ({
      number: i.number,
      title: i.title,
      labels: i.labels || [],
      priority: extractIssuePriority(i.labels)
    })));
  }

  if (filer === 'jira' && jira?.instanceId && jira?.projectKey) {
    const { ok, issues } = await listJira({
      instanceId: jira.instanceId,
      projectKey: jira.projectKey,
      jql: plannedWorkJql(jira.projectKey),
      // Jira's priority field is not in searchIssues' default `fields` set — ask
      // for it explicitly, or every item would report a null priority.
      searchOptions: { fields: 'summary,status,labels,updated,description,resolutiondate,priority' }
    });
    if (!ok) return plannedWorkUnavailable('the Jira search failed');
    const open = issues.filter(i => i.state === 'open');
    return formatPlannedWork(open.map(i => ({
      number: i.number,
      title: i.title,
      labels: i.labels || [],
      // Prefer Jira's real priority field; fall back to a priority-ish label.
      priority: i.priority || extractIssuePriority(i.labels)
    })));
  }

  if (filer === 'plan' && cwd) {
    const planPath = join(cwd, 'PLAN.md');
    // No PLAN.md at all is a real "nothing is planned" for a plan-tracked app —
    // distinguish it from a PLAN.md that EXISTS but could not be read (a genuine
    // failure), which tryReadFile's null would otherwise conflate.
    if (!existsSync(planPath)) return PLANNED_WORK_NONE;
    const content = await readFileFn(planPath);
    if (typeof content !== 'string') return plannedWorkUnavailable('PLAN.md exists but could not be read');
    return formatPlannedWork(extractPlannedPlanItems(content));
  }

  return null;
}

/**
 * Gather the enabled Layer-1 sources for one app into a `{ key: string }` map.
 * Deterministic reads only (files + CoS metric JSON + tracker lists); NO LLM calls.
 * Missing files degrade to omitted keys, never throws. `openIssues` is gathered
 * separately by the handler (it shells out to the forge). `tracker`
 * (`{ filer, forgeCli, cwd, jira }`, resolved by the caller) enables the
 * plannedWork source — absent, that source is simply skipped.
 */
export async function gatherSources(app, config, { cosPath = PATHS.cos, trustShellSources, tracker = null, isPortos = false } = {}) {
  const out = {};
  const src = config.sources || {};
  const repo = app.repoPath;

  // Resolve the install-level shell-trust opt-in lazily and once — only when a
  // `cmd` source is actually present — so apps with no shell sources never read
  // settings. Injected value (tests) wins; otherwise fall back to settings.json.
  let trustShell = trustShellSources;
  const resolveTrustShell = async () => {
    if (trustShell === undefined) trustShell = await getTrustShellSources();
    return trustShell;
  };

  if (src.goals && repo) {
    const goals = await tryReadFile(join(repo, 'GOALS.md'));
    if (goals) out.goals = goals.slice(0, 8000);
  }
  if (src.appMetrics && repo) {
    // The app's own success/performance metrics doc (the METRICS.md convention,
    // see docs/METRICS.md) — where a managed app records what "performing well"
    // means. Absent → omitted (the reasoner may then propose adding one).
    const metrics = await tryReadFile(join(repo, 'METRICS.md'));
    if (metrics) out.appMetrics = metrics.slice(0, 8000);
  }
  if (src.planMd && repo) {
    const plan = await tryReadFile(join(repo, 'PLAN.md'));
    if (plan) out.planMd = plan.slice(0, 8000);
  }
  if (src.healthReport && repo) {
    const health = await tryReadFile(join(repo, 'HEALTH_REPORT.md'));
    if (health) out.healthReport = health.slice(0, 8000);
  }
  if (src.plannedWork && tracker) {
    // The committed backlog (#2698). Unlike the file sources above, an EMPTY or
    // FAILED result still emits a key — each renders a distinct sentence, and
    // both are meaningful instructions to the reasoner (see gatherPlannedWork).
    const planned = await gatherPlannedWork(tracker);
    if (planned) out.plannedWork = planned.slice(0, PLANNED_WORK_MAX_CHARS);
  }
  if (src.cosMetrics) {
    // This install's own autonomous-agent run stats (per task type), NOT scoped to
    // the app being analyzed — see the default-config note for the PortOS-vs-managed
    // rationale (default-off for managed apps).
    const learning = await readJSONFile(join(cosPath, 'learning.json'), null);
    if (learning?.byTaskType) {
      // Surface BOTH the lifetime rate (the cumulative dashboard/telemetry truth)
      // AND a recency-windowed rate (issue #2460) per task type, labeled distinctly
      // so the reasoner doesn't conflate them. The windowed rate lets a
      // since-resolved failure burst age out of the "is work needed" signal instead
      // of permanently depressing it; `recentSuccessRate` is null when there are no
      // in-window runs, in which case the reasoner leans on the lifetime rate.
      // Note the intentional rename: computeWindowedStats' internal `windowed*`
      // fields are surfaced to the reasoner as `recent*` (reads more naturally in
      // the prompt context) — same concept, deliberately different label here.
      const summary = {};
      for (const [type, m] of Object.entries(learning.byTaskType)) {
        const windowed = computeWindowedStats(m?.recentOutcomes);
        summary[type] = {
          lifetimeSuccessRate: typeof m?.successRate === 'number' ? m.successRate : null,
          lifetimeCompleted: m?.completed || 0,
          recentSuccessRate: windowed.windowedSuccessRate,
          recentCompleted: windowed.windowedCompleted,
          avgDurationMs: m?.avgDurationMs || 0
        };
      }
      out.cosMetrics = JSON.stringify(summary).slice(0, 4000);
      // Scope-awareness guidance (#2760): a deterministic low/high-completion split
      // derived from the SAME per-type rates above, so the reasoner gets an interpreted
      // signal alongside the raw JSON instead of being asked to spot the pattern itself.
      // Rendered as its own prompt block (see buildPrompt). Gated on isPortos (codex P2):
      // these are THIS install's own CoS completion rates, meaningless to a managed app —
      // and a managed app CAN enable the cosMetrics source, so the cosMetrics toggle
      // alone is not the PortOS boundary. buildPrompt re-checks isPortos as defense in
      // depth; deriving it here only for PortOS also avoids the wasted work.
      if (isPortos) {
        const scopeGuidance = computeScopeAwareness({ metricsByType: summary });
        if (scopeGuidance) out.scopeGuidance = scopeGuidance;
      }
    }
  }
  for (const custom of src.custom || []) {
    const key = customSourceKey(custom);
    if (!key) continue;
    if (custom.type === 'file' && typeof custom.ref === 'string' && repo) {
      const safe = await confineToRepo(repo, custom.ref);
      if (!safe) {
        console.warn(`⚠️ Layered Intelligence: custom source "${custom.ref}" escapes repo — skipped`);
        continue;
      }
      const content = await tryReadFile(safe);
      if (content) out[key] = content.slice(0, 8000);
    } else if (custom.type === 'http' && typeof custom.url === 'string') {
      const content = await fetchHttpSource(custom.url);
      if (content) out[key] = content.slice(0, 8000);
    } else if (custom.type === 'cmd' && typeof custom.cmd === 'string' && repo) {
      const content = await runShellCommand(custom.cmd, { cwd: repo, trustShellSources: await resolveTrustShell() });
      if (content) out[key] = content.slice(0, 8000);
    }
  }
  return out;
}

/**
 * Read the LI loop's OWN agent-run metrics out of the CoS learning store (#2700).
 * Deterministic file read; no LLM call. Feeds computeSelfEvalSummary's execution-
 * health signal.
 *
 * Returns a discriminated result rather than a bare bucket-or-null, because the two
 * empty cases are NOT the same fact and the reasoner is told them differently:
 *   `{ read: false, metrics: null }` — the store is missing/unreadable/malformed:
 *                                      we do not know how LI's runs are going.
 *   `{ read: true,  metrics: null }` — the store is fine, LI has simply never run.
 *   `{ read: true,  metrics: {...} }` — real history.
 * Collapsing these to one `null` would let "cannot read the store" masquerade as
 * "healthy loop with no history" (or vice versa) — the sentinel rule.
 */
export async function readLiTaskMetrics({ cosPath = PATHS.cos } = {}) {
  const file = join(cosPath, 'learning.json');
  // An ABSENT store is a fresh install, not a broken read: learning.json is created
  // lazily on the first recorded task outcome. readJSONFile returns its default for
  // ENOENT, I/O errors, and parse failures ALIKE, so leaning on it alone would tell
  // every fresh install "your learning store could not be read" when the truth is
  // "nothing has run here yet" — the exact conflation this function exists to
  // prevent, just inverted. Check existence first so the two stay distinct.
  if (!existsSync(file)) return { read: true, metrics: null };
  const learning = await readJSONFile(file, null);
  const byTaskType = learning?.byTaskType;
  if (!byTaskType || typeof byTaskType !== 'object' || Array.isArray(byTaskType)) {
    return { read: false, metrics: null };
  }
  const bucket = byTaskType[LI_TASK_TYPE];
  return {
    read: true,
    metrics: (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) ? bucket : null
  };
}

/**
 * Stable map key for a custom source. Namespaced by type so a `file` ref and an
 * `http` url that share a string can't collide, and so the prompt's source block
 * labels are self-describing. Returns null for a malformed/unknown source.
 */
export function customSourceKey(custom) {
  if (!custom || typeof custom !== 'object') return null;
  if (custom.type === 'file' && custom.ref) return `custom:${custom.ref}`;
  if (custom.type === 'http' && custom.url) return `custom:http:${custom.url}`;
  if (custom.type === 'cmd' && custom.cmd) return `custom:cmd:${custom.cmd}`;
  return null;
}

/**
 * Fetch an http(s) custom source for the loop's prompt. Deterministic read, no
 * LLM. Rejects any non-http(s) scheme (defense in depth over the Zod refine),
 * bounds the request with a 10s timeout, and returns null on any failure so a
 * dead URL just omits the key rather than throwing.
 *
 * SSRF-guarded via `fetchPublicText` (default posture): loopback, link-local,
 * and the cloud-metadata endpoint (127.0.0.1, 169.254.169.254,
 * metadata.google.internal, ::1) are blocked so a hand-edited/hostile config
 * can't exfiltrate them into the reasoner prompt, and redirects are revalidated
 * against the same gate. LAN/private hosts (Tailscale peers, a home wiki) stay
 * ALLOWED intentionally — PortOS is a single-user tool where a custom source
 * legitimately points at the home network, and the URL is operator-configured.
 * `throwOnUnsafe: false` makes a blocked host omit the key like any other dead
 * URL instead of bubbling a 400. `fetchText` is injectable for tests.
 */
export async function fetchHttpSource(url, { timeoutMs = 10_000, fetchText = fetchPublicText } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const text = await fetchText(url, { timeoutMs, throwOnUnsafe: false }).catch(() => null);
  return text || null;
}

/**
 * THREAT MODEL — a `cmd` custom source is attacker-reachable persistent config.
 *
 * The `sources.custom` array lives in each app's stored `layeredIntelligence`
 * config, written through the validated `PUT /api/apps/:id` route. A `cmd` entry
 * is executed here on the Layered Intelligence SCHEDULE (Engine-B autonomous job),
 * with the PortOS process's own privileges and cwd = the app repo. So any path
 * that can land a string in that config (a hand-edited config, a hostile sync
 * payload, a future config-writing feature, an XSS-driven same-origin POST) gets
 * *persistent, unattended* code execution — not a one-shot the operator watched.
 *
 * Historically this ran the full command string with `shell: true`, capped only
 * by length + a 15s timeout. That is arbitrary RCE: `; rm -rf ~`, `$(curl … | sh)`,
 * pipes to `sh`, etc. all execute. Issue #2515.
 *
 * Defense: by default we DENY the shell. The command is parsed and checked
 * against the shared binary allowlist (`validateCommand` in commandSecurity.js —
 * same gate the manual command runner uses), which rejects shell metacharacters
 * (`;|&$(){}` …) and any binary not on the allowlist, then we spawn the base
 * binary with parsed args and `shell: false` — so no shell ever interprets the
 * string. A non-allowlisted / metacharacter command is dropped (key omitted) with
 * a warning, exactly like any other failed source read.
 *
 * Escape hatch: an operator who genuinely needs a pipeline (`git log … | head`)
 * can set the install-level `settings.layeredIntelligence.trustShellSources`
 * flag, which restores the full `shell: true` behavior for THIS install only.
 * It is an explicit, install-wide opt-in — off by default — so a fresh install
 * (or a synced-in app config) can never execute an un-allowlisted command.
 *
 * `exec` is injectable for tests; `trustShellSources` is resolved by the caller
 * (`gatherSources`) from install settings and threaded in.
 *
 * Returns null on rejection / non-zero exit / timeout / no output so a failing or
 * denied command just omits the source key rather than throwing.
 */
export async function runShellCommand(cmd, { cwd, timeoutMs = 15_000, exec = bufferedSpawn, trustShellSources = false } = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) return null;
  if (trustShellSources) {
    // Operator has explicitly opted this install into full-shell custom sources.
    const { code, stdout } = await exec(cmd, [], { cwd, timeoutMs, shell: true });
    if (code !== 0) return null;
    return (stdout || '').trim() || null;
  }
  const check = validateCommand(cmd);
  if (!check.valid) {
    console.warn(`⚠️ Layered Intelligence: custom cmd source "${cmd}" rejected — ${check.error} (enable settings.layeredIntelligence.trustShellSources to allow arbitrary shell commands)`);
    return null;
  }
  const { code, stdout } = await exec(check.baseCommand, check.args, { cwd, timeoutMs, shell: false });
  if (code !== 0) return null;
  return (stdout || '').trim() || null;
}

/**
 * Resolve the install-level "trust shell sources" opt-in from settings.json.
 * `null`/absent/non-true all read as OFF (the safe default) — only an explicit
 * `true` unlocks full-shell custom `cmd` sources. Injectable read for tests.
 */
export async function getTrustShellSources(read = getSettings) {
  const settings = await read();
  return settings?.layeredIntelligence?.trustShellSources === true;
}

/**
 * Confine a custom file `ref` to within `repo` so a hostile/hand-edited config
 * can't read arbitrary files into the LLM prompt. Returns the safe absolute path,
 * or null when it escapes. Guards BOTH lexical traversal (`..` / absolute) AND
 * symlink escape — a symlink inside the repo pointing outside is resolved via
 * realpath and rejected. Missing files return null (nothing to read).
 */
export async function confineToRepo(repo, ref) {
  const abs = resolve(repo, ref);
  const rel = relative(repo, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  // Resolve symlinks on both sides; a link inside the repo that points outside
  // is caught here (lexical check above only sees the link's own path).
  const realRepo = await realpath(repo).catch(() => null);
  const realAbs = await realpath(abs).catch(() => null);
  if (!realRepo || !realAbs) return null;
  const realRel = relative(realRepo, realAbs);
  if (realRel.startsWith('..') || isAbsolute(realRel)) return null;
  return realAbs;
}

/** Lazily resolve the default embedder so the pure module doesn't statically pull
 * in the embeddings/settings/provider graph (matches the handler's dynamic-import
 * pattern for heavy deps). Only reached in production — tests inject `embed`. */
async function defaultEmbed(text) {
  const { embedText } = await import('./embeddings.js');
  return embedText(text);
}

/**
 * SEMANTIC dedup guard — the embedding-similarity layer ON TOP OF the exact
 * slug/label dedup (`isProposalDuplicate`). Catches a proposal that describes the
 * same work as an existing issue but was worded differently (so its slug differs).
 * Runs only AFTER slug dedup passes, so it's a best-effort extra catch.
 *
 * Returns `{ available, duplicate, match }`:
 *   - `available:false` when semantic dedup couldn't run (no embeddable candidates,
 *     or the embeddings provider is off / the proposal embed failed). This is a
 *     SENTINEL, distinct from `available:true, duplicate:false` ("checked, no
 *     near-dup"): the handler treats unavailable as "proceed to file" because slug
 *     dedup already guarded the exact case — losing the semantic catch just
 *     restores pre-feature behavior, it never files a slug-duplicate.
 *   - `duplicate:true` with `match` = the highest-scoring near-duplicate issue.
 *
 * No cold-bootstrap risk: `embed` degrades to `{ skipped:true }` when no
 * embeddings provider is configured, and this only runs inside the user-enabled
 * scheduled sweep. `embed` is injectable for tests.
 */
export async function checkSemanticDuplicate({ proposal, existingIssues = [], now = Date.now(), embed = defaultEmbed, threshold = SEMANTIC_DEDUP_THRESHOLD } = {}) {
  const unavailable = { available: false, duplicate: false, match: null };
  if (!proposal || typeof proposal !== 'object') return unavailable;

  // Only issues still within the dedup window with SOMETHING to embed are worth
  // comparing; a plan-tracked slug-only issue (no title/body) can't be embedded.
  const candidates = existingIssues
    .filter(i => isIssueWithinDedupWindow(i, now) && (i.body || i.title))
    .slice(0, SEMANTIC_DEDUP_MAX_CANDIDATES);
  if (candidates.length === 0) return unavailable;

  // A failing embed (transient provider blip, malformed response) must degrade to
  // the available:false sentinel — NOT reject through processApp and mark the
  // whole app run 'error'. Deferring the call into a promise chain then catching
  // absorbs BOTH an async rejection AND a synchronous throw from the (injectable)
  // embedder, mirroring this file's fetchHttpSource / jira-search failure idiom
  // (no non-boundary try/catch).
  const safeEmbed = (text) => Promise.resolve().then(() => embed(text)).catch(() => null);

  const proposalRes = await safeEmbed(issueEmbedSeed({ title: proposal.title, body: proposal.body }));
  if (!proposalRes?.success || !Array.isArray(proposalRes.embedding)) return unavailable;

  const embedded = [];
  for (const c of candidates) {
    const res = await safeEmbed(issueEmbedSeed({ title: c.title, body: c.body }));
    if (res?.success && Array.isArray(res.embedding)) {
      embedded.push({ slug: c.slug || null, number: c.number ?? null, title: c.title || '', embedding: res.embedding });
    }
  }
  if (embedded.length === 0) return unavailable;

  const match = findSemanticDuplicate({ proposalEmbedding: proposalRes.embedding, candidates: embedded, threshold });
  return { available: true, duplicate: !!match, match };
}

/**
 * Normalize a forge issue state to `open` / `closed`. GitLab reports `opened`
 * (and `closed`/`locked`); GitHub reports `open`/`closed`. Anything that isn't a
 * recognized closed/locked state is treated as open so dedup + park don't miss a
 * GitLab-`opened` issue. (`merged` never applies to issues.)
 */
export function normalizeIssueState(state) {
  const s = (state || '').toLowerCase();
  if (s === 'closed' || s === 'locked') return 'closed';
  return 'open';
}

/**
 * Normalize a forge issue's labels to a plain `string[]`. gh reports objects
 * (`[{ name, color, … }]`); glab reports bare strings. Anything unrecognized
 * drops out rather than rendering `[object Object]` into the reasoner's prompt.
 */
export function normalizeIssueLabels(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(l => (typeof l === 'string' ? l : l?.name))
    .filter(l => typeof l === 'string' && l.trim())
    .map(l => l.trim());
}

/**
 * Best-effort priority read from an issue's labels — there is no cross-forge
 * priority field, so the common label conventions are matched instead:
 * `priority: high` / `priority/high`, `P0`–`P4`, and a bare
 * `critical|urgent|high|medium|low` (optionally suffixed `-priority`).
 *
 * Returns null when no label looks like a priority. Null means "this issue
 * carries no priority label", NOT "priority zero" — the renderer omits the field
 * entirely rather than inventing a default the tracker never asserted.
 */
export function extractIssuePriority(labels = []) {
  const re = /^(?:priority[:/\s-]+(.+)|p([0-4])|(critical|urgent|high|medium|low)(?:[\s-]priority)?)$/i;
  for (const label of normalizeIssueLabels(labels)) {
    const m = label.match(re);
    if (!m) continue;
    const value = m[1] ?? (m[2] != null ? `p${m[2]}` : m[3]);
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  }
  return null;
}

/**
 * List issues on a forge. Defaults to the layered-intelligence set (open +
 * recently closed) for the reasoner + dedup guard; `label`/`state` are
 * parameterized so the plannedWork source (#2698) can reuse the exact same
 * parse/normalize path for the `plan`-labeled committed backlog.
 *
 * Returns `{ ok, issues }` — `ok:false` means the tracker read FAILED (CLI error
 * or unparseable output), which is NOT the same as "no existing issues" (`ok:true,
 * issues:[]`). The handler must NOT file when the read failed, or a transient
 * `gh` blip would defeat dedup and file a duplicate (CLAUDE.md sentinel rule).
 */
export async function listForgeIssues({ cli, cwd, env, label = LI_LABEL, state = 'all', exec = runCli } = {}) {
  // glab lists open issues by default and needs `--all` to widen to every state;
  // gh takes the state explicitly.
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', label, ...(state === 'all' ? ['--all'] : []), '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', label, '--state', state, '--limit', '100', '--json', 'number,title,body,state,stateReason,closedAt,url,labels,comments'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      body: i.body || i.description || '',
      state: normalizeIssueState(i.state),
      // GitHub-only: 'completed' | 'not_planned' | 'reopened'. glab omits it, so
      // deriveOutcome falls back to treating any closed issue as merged.
      stateReason: i.stateReason || i.state_reason || null,
      closedAt: i.closedAt || i.closed_at || null,
      // gh reports `url`; glab reports `web_url`. Null when neither is present so
      // the overview's proposal links degrade to a plain count rather than a
      // dead href.
      url: i.url || i.web_url || null,
      labels: normalizeIssueLabels(i.labels),
      // The rejection classifier's last-resort signal (#2748): the prose a human
      // left when declining, for a close with no matching label/close-reason. gh
      // returns `comments` in the same batched list call (no extra fetch); glab's
      // `-F json` omits them, so its rows carry null and fall through to label/
      // stateReason only (tracked in the issue's Remaining).
      closingComment: extractClosingComment(i.comments),
      slug: extractSlugFromBody(i.body || i.description || '') || extractSlugFromBody(i.title || '')
    }))
  };
}

/**
 * The rationale a human left when closing a proposal, for the rejection classifier
 * (#2748). gh returns issue comments oldest-first; the LAST non-empty one sits
 * closest to the close, so it carries the decline reason in the common case.
 * Returns null for an issue closed with no comment — there is nothing to classify.
 */
export function extractClosingComment(comments) {
  if (!Array.isArray(comments)) return null;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = comments[i]?.body;
    if (typeof body === 'string' && body.trim()) return body;
  }
  return null;
}

/**
 * List OPEN blocking-labeled issues for the app (park check). Returns
 * `{ ok, issues }` with the same failed-vs-empty distinction as listForgeIssues.
 */
export async function listBlockingIssues({ cli, cwd, env, exec = runCli } = {}) {
  const args = cli === 'glab'
    ? ['issue', 'list', '--label', LI_BLOCKING_LABEL, '-P', '100', '-F', 'json']
    : ['issue', 'list', '--label', LI_BLOCKING_LABEL, '--state', 'open', '--limit', '100', '--json', 'number,title,state'];
  const { code, stdout } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { ok: false, issues: [] };
  if (!stdout.trim()) return { ok: true, issues: [] };
  const parsed = safeJSONParse(stdout, null, { logError: false });
  if (!Array.isArray(parsed)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: parsed.map(i => ({
      number: i.number ?? i.iid ?? null,
      title: i.title || '',
      state: normalizeIssueState(i.state)
    }))
  };
}

/**
 * Ensure the layered-intelligence labels exist before the first `issue create`
 * (gh/glab both fail creating an issue with a non-existent label). Idempotent —
 * `--force` (gh) / re-create (glab) is a no-op when the label already exists.
 */
export async function ensureForgeLabels({ cli, cwd, env, exec = runCli } = {}) {
  const labels = [
    { name: LI_LABEL, color: '1d76db', desc: 'Filed by the Layered Intelligence loop' },
    { name: LI_BLOCKING_LABEL, color: 'b60205', desc: 'Layered Intelligence loop is paused on this issue' }
  ];
  for (const l of labels) {
    if (cli === 'glab') {
      await exec(cli, ['label', 'create', '--name', l.name, '--color', `#${l.color}`, '--description', l.desc], { cwd, env });
    } else {
      await exec(cli, ['label', 'create', l.name, '--color', l.color, '--description', l.desc, '--force'], { cwd, env });
    }
  }
}

/**
 * File ONE proposal issue on a forge (gh/glab). Ensures labels first, embeds the
 * slug marker in the body, and returns `{ success, number, url }`. The issue
 * number is parsed from the created URL's trailing digits.
 */
export async function fileProposalToForge({ cli, cwd, env, title, body, slug, exec = runCli } = {}) {
  await ensureForgeLabels({ cli, cwd, env, exec });
  const fullBody = `${body}\n\n${slugMarker(slug)}`;
  const args = cli === 'glab'
    ? ['issue', 'create', '--title', title, '--description', fullBody, '--label', LI_LABEL]
    : ['issue', 'create', '--title', title, '--body', fullBody, '--label', LI_LABEL];
  const { code, stdout, stderr } = await exec(cli, args, { cwd, env });
  if (code !== 0) return { success: false, error: stderr || `${cli} exited with code ${code}` };
  const urlMatch = stdout.trim().match(/(https?:\/\/\S+)/);
  const url = urlMatch ? urlMatch[1] : stdout.trim();
  const numMatch = url.match(/(\d+)\s*$/);
  return { success: true, number: numMatch ? Number(numMatch[1]) : null, url };
}

/** Apply the blocking label to an existing issue (pause). Returns `{ success }`. */
export async function applyBlockingLabel({ cli, cwd, env, number, exec = runCli } = {}) {
  if (!Number.isInteger(number)) return { success: false, error: 'no issue number' };
  const args = cli === 'glab'
    ? ['issue', 'update', String(number), '--label', LI_BLOCKING_LABEL]
    : ['issue', 'edit', String(number), '--add-label', LI_BLOCKING_LABEL];
  const { code, stderr } = await exec(cli, args, { cwd, env });
  return code === 0 ? { success: true } : { success: false, error: stderr };
}

// ---------------------------------------------------------------------------
// Jira filer. Jira has no forge CLI — it goes through the PortOS Jira REST
// service (server/services/jira.js). Dedup + pause are label-based (same as the
// forges) via JQL, with the slug marker embedded in the ticket description.
// The Jira deps (search/create/addLabel) are injectable so tests drive the
// dispatch without a live Jira instance.
// ---------------------------------------------------------------------------

/**
 * Normalize a Jira status CATEGORY to `open` / `closed`. Jira's three canonical
 * categories are "To Do" / "In Progress" / "Done"; only "Done" counts as closed
 * for dedup + park. Anything unrecognized is treated as open so a custom
 * in-flight status can't slip past dedup.
 */
export function normalizeJiraState(statusCategory) {
  return (statusCategory || '').toLowerCase() === 'done' ? 'closed' : 'open';
}

/**
 * List existing layered-intelligence tickets in a Jira project (open + recently
 * closed) for the reasoner + dedup guard. Mirrors listForgeIssues' `{ ok, issues }`
 * failed-vs-empty contract: a thrown search is `ok:false` (do NOT file — a blind
 * dedup would duplicate); an empty result is `ok:true, issues:[]`.
 */
export async function listJiraIssues({ instanceId, projectKey, jql, searchOptions, search = searchIssues } = {}) {
  if (!instanceId || !projectKey) return { ok: false, issues: [] };
  // `jql` lets the plannedWork source (#2698) reuse this parse path for the
  // prioritized backlog; absent, it's the layered-intelligence label set.
  const query = jql || `project = "${escapeJql(projectKey)}" AND labels = "${LI_LABEL}" ORDER BY updated DESC`;
  const rows = searchOptions
    ? await search(instanceId, query, searchOptions).then(r => r, () => null)
    : await search(instanceId, query).then(r => r, () => null);
  if (!Array.isArray(rows)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: rows.map(i => ({
      number: i.key || null,
      title: i.summary || '',
      body: i.description || '',
      state: normalizeJiraState(i.statusCategory),
      closedAt: i.resolutiondate || null,
      labels: normalizeIssueLabels(i.labels),
      // Jira DOES have a real priority field (unlike the forges) — but only when
      // the caller asked searchIssues for it. Absent → null → the renderer omits
      // it, rather than a fabricated default.
      priority: typeof i.priority === 'string' && i.priority.trim() ? i.priority.trim() : null,
      slug: extractSlugFromBody(i.description || '') || extractSlugFromBody(i.summary || '')
    }))
  };
}

/**
 * The JQL for a Jira project's committed backlog (#2698): `plan`-labeled tickets
 * that aren't Done, highest priority first.
 *
 * The label filter is NOT optional — it is what makes this source mean the same
 * thing on Jira as on a forge. Without it the query returns every open ticket,
 * i.e. the untriaged backlog nobody has committed to (plus LI's own past
 * proposals), which would then render under a header asserting the user
 * "already committed to" them and instruct the reasoner to suppress against
 * essentially the whole tracker — and duplicate the `openIssues` source besides.
 * A project that doesn't use the label reports a truthful "nothing planned"
 * rather than a backlog-shaped lie.
 *
 * Deliberately NOT `sprint in openSprints()` — the Sprint field only exists on
 * Scrum-board-backed projects, and JQL referencing an absent field is a hard 400
 * rather than an empty result, which would make gatherPlannedWork report
 * "unavailable" forever on every Kanban/basic project. `labels` exists on every
 * project shape. Priority is an ORDER BY rather than a filter for the same
 * reason: priority NAMES are scheme-specific (a project can rename or drop
 * "Highest"), so filtering on them risks the same permanent-400.
 */
export function plannedWorkJql(projectKey) {
  return `project = "${escapeJql(projectKey)}" AND labels = "${PLANNED_WORK_LABEL}" AND statusCategory != Done ORDER BY priority DESC, updated DESC`;
}

/**
 * List OPEN blocking-labeled Jira tickets for the app (park check). `{ ok, issues }`
 * with the same failed-vs-empty distinction. JQL filters out Done so a resolved
 * blocking ticket un-parks the app automatically (matching the forge pause model).
 */
export async function listJiraBlockingIssues({ instanceId, projectKey, search = searchIssues } = {}) {
  if (!instanceId || !projectKey) return { ok: false, issues: [] };
  const jql = `project = "${escapeJql(projectKey)}" AND labels = "${LI_JIRA_BLOCKING_LABEL}" AND statusCategory != Done ORDER BY updated DESC`;
  const rows = await search(instanceId, jql).then(r => r, () => null);
  if (!Array.isArray(rows)) return { ok: false, issues: [] };
  return {
    ok: true,
    issues: rows.map(i => ({ number: i.key || null, title: i.summary || '', state: normalizeJiraState(i.statusCategory) }))
  };
}

/**
 * File ONE proposal ticket in a Jira project. Embeds the slug marker in the
 * description (searchable for dedup) and tags it with the layered-intelligence
 * label. Returns `{ success, key, url }` — Jira issues are keyed strings
 * (`PROJ-123`), not integers, so the handler resolves pause targets by key.
 */
export async function fileProposalToJira({ instanceId, projectKey, issueType = 'Task', title, body, slug, create = createTicket } = {}) {
  if (!instanceId || !projectKey) return { success: false, error: 'jira instance/project not configured' };
  const description = `${body}\n\n${slugMarker(slug)}`;
  const res = await create(instanceId, {
    projectKey,
    summary: title,
    description,
    issueType,
    labels: [LI_LABEL]
  }).then(r => r, (err) => ({ success: false, error: err?.message || 'jira create failed' }));
  if (!res?.success) return { success: false, error: res?.error || 'jira create failed' };
  return { success: true, key: res.ticketId || null, url: res.url || null };
}

/**
 * Resolve a Jira pause target to a concrete issue KEY. `"this"` → the just-filed
 * ticket's key; an integer → `<projectKey>-<n>` (a pre-existing ticket in the
 * same project). Returns null when it can't resolve (e.g. `"this"` but nothing
 * was filed, or no project key for an integer target).
 */
export function resolveJiraBlockKey(pause, filedKey, projectKey) {
  if (!pause) return null;
  if (pause.blockOnIssue === 'this') return filedKey || null;
  if (Number.isInteger(pause.blockOnIssue) && projectKey) return `${projectKey}-${pause.blockOnIssue}`;
  return null;
}

/** Apply the Jira blocking label to an existing ticket (pause). Returns `{ success }`. */
export async function applyJiraBlockingLabel({ instanceId, key, addLabel = addLabels } = {}) {
  if (!instanceId || !key) return { success: false, error: 'no jira ticket key' };
  const res = await addLabel(instanceId, key, [LI_JIRA_BLOCKING_LABEL]).then(r => r, (err) => ({ success: false, error: err?.message }));
  return res?.success ? { success: true } : { success: false, error: res?.error || 'jira label failed' };
}

/**
 * Append a slug-tagged proposal to the app's PLAN.md (the `plan` tracker path).
 * Dedups by scanning for the `[lil-<slug>]` tag. Creates PLAN.md with a heading
 * + `## Next Up` section if absent. Returns `{ success, duplicate }`.
 */
export async function appendProposalToPlan({ repoPath, appName, slug, title, body } = {}) {
  const planPath = join(repoPath, 'PLAN.md');
  const tag = `[lil-${slug}]`;
  const existing = existsSync(planPath) ? await readFile(planPath, 'utf-8').catch(() => '') : '';
  if (existing.includes(tag)) return { success: true, duplicate: true };

  const oneLine = (body || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  const item = `- [ ] ${tag} **${title}** ${oneLine}`.trim();

  if (!existing) {
    const content = `# ${appName} — Development Plan\n\n## Next Up\n\n${item}\n`;
    await writeFile(planPath, content);
    return { success: true, duplicate: false };
  }
  const nextUpRe = /(##\s+Next Up[^\n]*)(\n?)/;
  if (nextUpRe.test(existing)) {
    // Insert right after the "## Next Up" heading line, normalizing the heading's
    // line ending first so a file that ENDS at `## Next Up` (no trailing newline)
    // gets the item on its own line rather than a second section appended below.
    const updated = existing.replace(nextUpRe, `$1\n${item}\n`);
    await writeFile(planPath, updated.endsWith('\n') ? updated : `${updated}\n`);
    return { success: true, duplicate: false };
  }
  // No Next Up section — append one.
  const sep = existing.endsWith('\n') ? '' : '\n';
  await appendFile(planPath, `${sep}\n## Next Up\n\n${item}\n`);
  return { success: true, duplicate: false };
}

/**
 * Scan a PLAN.md string for `[lil-<slug>]` tags → array of `{ slug, state }`.
 * Preserves each tag's list-item checkbox so the outcome loop (#2435) can
 * reconcile a completed PLAN proposal: `- [x] [lil-foo]` reads as `closed`,
 * `- [ ] [lil-foo]` as `open`.
 *
 * Absent ≠ done (the CLAUDE.md sentinel rule): a bare tag with NO preceding
 * checkbox stays `open` (still tracked/suppressed) rather than collapsing to
 * `closed` — a missing checkbox must not silently make an item re-proposable.
 * A `closed` item carries no `closedAt` (PLAN.md checkboxes have no timestamp),
 * which `isIssueWithinDedupWindow` treats as permanently in-window → a completed
 * proposal stays suppressed forever instead of being re-reasoned every run (#2620).
 */
export function extractPlanSlugs(planContent) {
  if (typeof planContent !== 'string') return [];
  const items = [];
  // Alt 1: a list item `- [ ]`/`- [x]` whose line also carries the tag (state
  // from the checkbox char). Alt 2: a bare tag with no checkbox (state 'open').
  const re = /^[ \t]*[-*][ \t]*\[([ xX])\][^\n]*?\[lil-([a-z0-9][a-z0-9-]*)\]|\[lil-([a-z0-9][a-z0-9-]*)\]/gim;
  let m;
  while ((m = re.exec(planContent))) {
    if (m[2]) {
      items.push({ slug: m[2].toLowerCase(), state: m[1].toLowerCase() === 'x' ? 'closed' : 'open' });
    } else {
      items.push({ slug: m[3].toLowerCase(), state: 'open' });
    }
  }
  return items;
}
