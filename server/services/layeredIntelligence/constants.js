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

// Tracker labels + slug marker. The slug is the stable dedup key, embedded in each
// filed issue body so later runs can self-avoid duplicates.
export const LI_LABEL = 'layered-intelligence';
export const LI_BLOCKING_LABEL = 'layered-intelligence:blocking';

// `{ name, color, description }` for the two LI marker labels, so every caller
// that needs to CREATE one (`ensureForgeLabels`, `fileProposalToForge`) shares
// the same literal instead of two copies that can silently drift apart.
export const LI_LABEL_SPEC = Object.freeze({ name: LI_LABEL, color: '1d76db', description: 'Filed by the Layered Intelligence loop' });
export const LI_BLOCKING_LABEL_SPEC = Object.freeze({ name: LI_BLOCKING_LABEL, color: 'b60205', description: 'Layered Intelligence loop is paused on this issue' });

// The tracker label marking an issue as work the user has COMMITTED to — the
// `plannedWork` source's filter (#2698). PortOS's own roadmap "lives entirely in
// the GitHub issue tracker" as `plan`-labeled issues, and that convention is the
// default for managed apps too.
export const PLANNED_WORK_LABEL = 'plan';

// How many planned-work items are surfaced to the reasoner; the FULL count is always
// reported alongside so a truncated list never reads as the whole backlog.
export const PLANNED_WORK_MAX_ITEMS = 15;

// Character bound for the rendered plannedWork block, matching the other
// file-backed sources' 8000-char ceiling.
export const PLANNED_WORK_MAX_CHARS = 8000;

// The instruction buildPrompt attaches directly beneath the plannedWork block —
// the whole point of the source: turn "here is the backlog" into "so do not file
// against it".
export const PLANNED_WORK_GUIDANCE = 'Cross-reference your proposal against the user\'s actively-planned work above. If your proposal duplicates or conflicts with an active item, DO NOT file — return proposal: null. Only propose genuinely new work that does NOT overlap with what is already in scope.';

// The LI Proposal Playbook (#2763): human-authored guidance on which proposals land vs.
// get rejected, loaded once from the co-located markdown and rendered verbatim as the
// `liPlaybook` block. It ships in the SOURCE tree (not seeded to data/prompts/), so it
// needs no PROMPT_VERSIONS bump. Read synchronously at load; a miss is a packaging bug
// worth failing loudly.
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

// Cosine-similarity floor for the embedding near-duplicate guard atop exact slug/label
// dedup. Deliberately conservative: only near-identical intent trips it (768-dim local
// embeddings put genuine near-dups at about 0.9 and above).
export const SEMANTIC_DEDUP_THRESHOLD = 0.9;

// Cap the number of existing issues embedded per run so a repo with a large LI
// backlog can't fan out into an unbounded embedding sweep. Open dedup-window
// issues should be few (the loop files ≤1/run), so this is a generous ceiling.
export const SEMANTIC_DEDUP_MAX_CANDIDATES = 50;

// The RETIRED global autonomous-job id that drove the old cross-app sweep. LI is now a
// per-app handler-backed scheduled task (#2322); kept ONLY so migration 184 can
// tombstone the legacy record. Nothing dispatches on it.
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

// Minimum RESOLVED proposals before the low-merge-rate alarm fires. A single early
// rejection must not tell the loop its rate is "critically low": that biases it toward
// filing nothing, so it could never earn a merge.
export const LOW_MERGE_RATE_MIN_SAMPLE = 4;

// LI's SCHEDULE name (taskSchedule.js SELF_IMPROVEMENT_TASK_TYPES) — also the key
// the type-failure ledger uses. NOT the key its runs are recorded under.
export const LI_SCHEDULED_TASK_TYPE = 'layered-intelligence';

// The `learning.json` byTaskType key LI's own agent runs land under, read by
// computeSelfEvalSummary. DERIVED, never restated: a scheduled LI task carries
// `metadata.analysisType = 'layered-intelligence'`, so extractTaskType records it as
// `self-improve:<type>`, not the bare schedule name (which is correct only in the
// schedule map and type-failure ledger). Building the key with the writer's own
// function keeps it from drifting.
export const LI_TASK_TYPE = extractTaskType({ metadata: { analysisType: LI_SCHEDULED_TASK_TYPE } });

// LI-task success rate (%) below which selfEval reports the loop's own execution
// as DEGRADED (#2700) — a separate failure mode from a low merge rate: the merge
// rate says "the user rejects what I propose", this says "my own runs are
// failing". Kept at 50 (a coin flip) rather than the merge-rate's 20: a proposal
// being rejected is normal triage, an LI run outright failing is not.
export const LI_DEGRADED_SUCCESS_THRESHOLD = 50;

// Minimum recorded LI runs before the degraded-execution signal fires (0-of-1 and
// 0-of-50 are both "0%", only the second is evidence).
export const LI_DEGRADED_MIN_SAMPLE = 4;

// LI execution health (%) below which the hard pre-filing exclusion gate (#2824) arms.
// Unlike LI_DEGRADED_SUCCESS_THRESHOLD (advisory), this SUPPRESSES filing, so it uses a
// wider net: the SCOPE_PREFER value (75), the bar that marks a domain "reliably
// executes". Arms only on a confident read (>= LI_DEGRADED_MIN_SAMPLE runs).
export const LI_HARD_GATE_EXECUTION_THRESHOLD = 75;

// Window for approval-funnel metrics (#3120). Deliberately shorter than the 30-day
// retention (CLOSED_SUPPRESSION_MS): a window equal to retention would equal the
// lifetime rate and never move when triage habits change.
export const LI_APPROVAL_FUNNEL_WINDOW_MS = 14 * DAY;

// Age thresholds (in days) for the approver-delay buckets (#3120): how many proposals
// are sitting undecided past each mark. CUMULATIVE and ascending — a proposal 9 days old
// counts in all three — so the buckets read as a decay curve rather than a partition.
// Ascending order is load-bearing for the rendered line and the bucket keys.
export const LI_APPROVAL_DELAY_BUCKET_DAYS = [1, 3, 7];

// Evidence floor for approved proposals, separate from LI's reasoning runs: one accepted
// proposal awaiting execution must not lock the loop out; five approvals make a poor
// completion rate a real delivery signal.
export const LI_DELIVERY_MIN_SAMPLE = 5;

// LI's approval → completion rate (%) below which the hard pre-filing exclusion gate
// also arms. This is intentionally independent of LI_HARD_GATE_EXECUTION_THRESHOLD:
// a loop can complete its reasoning runs reliably while its approved proposals fail
// to reach delivery, and neither rate is allowed to mask the other.
export const LI_HARD_GATE_DELIVERY_THRESHOLD = 50;

// Resolved outcomes of a filed proposal (#2428); null means still open. deriveOutcome
// maps the tracker close state: completed → merged, not_planned → rejected, any other
// present reason → abandoned (#2620); a reason-less close falls back to merged.
export const PROPOSAL_OUTCOMES = ['merged', 'rejected', 'abandoned'];

// EXECUTION outcomes of an LI proposal handed off to a coding agent (#2765), distinct
// from the filing fate in PROPOSAL_OUTCOMES. Null for proposals never handed off.
// Environmental failures (rate-limit/outage) are not recorded: they say nothing about
// the proposal's domain (#2618).
export const PROPOSAL_EXECUTION_OUTCOMES = ['success', 'failure'];

// Minimum recorded executions before a proposal DOMAIN's rate is trusted for the
// avoid/prefer split (#2765). Lower than SCOPE_AWARENESS_MIN_SAMPLE because each point is
// a real LI-proposal execution and the hand-off path is rare.
export const PROPOSAL_EXECUTION_MIN_SAMPLE = 2;

// Scope-awareness thresholds (#2760). An LI proposal later runs as a CoS task, so
// proposing work in a chronically failing scope is waste. A scope is "avoid" when its
// effective (windowed, else lifetime) success rate is below AVOID with enough completed
// runs, "prefer" at/above PREFER. AVOID reuses the 50% degraded-execution line. The
// classification is recomputed each run from the windowed rate, so nothing persisted
// can go stale (see computeScopeAwareness).
export const SCOPE_AVOID_SUCCESS_THRESHOLD = LI_DEGRADED_SUCCESS_THRESHOLD; // < 50% → avoid
export const SCOPE_PREFER_SUCCESS_THRESHOLD = 75;                          // >= 75% → prefer

// Minimum completed runs before a scope's rate is trusted. One below the degraded floor
// because this guidance is advisory, not a hard suppression.
export const SCOPE_AWARENESS_MIN_SAMPLE = 3;

// Prompt-size bounds for the scope-awareness block: task-type keys can embed an
// unbounded mission name, so cap entries per list (sorted sharpest-first) and truncate
// any single name.
export const SCOPE_AWARENESS_MAX_PER_LIST = 12;
export const SCOPE_AWARENESS_MAX_TYPE_LEN = 80;
