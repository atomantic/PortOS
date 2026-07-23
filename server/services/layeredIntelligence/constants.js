/**
 * Layered Intelligence — constants & tunables (#2842 split of layeredIntelligence.js).
 *
 * The tracker labels, dedup/suppression windows, scope + complexity vocabularies,
 * degradation/exclusion thresholds and the shipped proposal playbook. Pure data —
 * no behaviour — so every other LI module can import from here without a cycle.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DAY } from '../../lib/fileUtils.js';
import { extractTaskType } from '../taskLearning/store.js';

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
  // `..` — the playbook ships next to the barrel in server/services/, one level
  // up from this module's ./layeredIntelligence/ directory (#2842 split).
  join(dirname(fileURLToPath(import.meta.url)), '..', 'layeredIntelligence.playbook.md'),
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

// LI execution health (%) below which the deterministic HARD PRE-FILING EXCLUSION
// gate (#2824) arms. Distinct from LI_DEGRADED_SUCCESS_THRESHOLD (50 — the "your
// loop is failing, hold a higher bar" ADVISORY line surfaced to the reasoner): the
// hard gate does not advise, it SUPPRESSES filing, so it opens a WIDER, more cautious
// net. Once LI's own runs dip below three-quarters success it stops FILING self-
// directed work it demonstrably cannot see through, rather than merely being warned.
// Reuses the SCOPE_PREFER value (75) intentionally: the same "reliably executes" bar
// that marks a proposal DOMAIN preferable is the bar LI's own execution health must
// clear before it is trusted to file self-improvement work. The gate arms only on a
// CONFIDENT read (>= LI_DEGRADED_MIN_SAMPLE runs) — a cold loop is never locked out.
export const LI_HARD_GATE_EXECUTION_THRESHOLD = 75;

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
