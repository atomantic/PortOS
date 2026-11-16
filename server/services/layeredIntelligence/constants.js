/**
 * Layered Intelligence constants & tunables. Pure data, no behaviour, so every other
 * LI module can import from here without a cycle.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DAY } from '../../lib/fileUtils.js';
import { extractTaskType } from '../taskLearning/store.js';


export const LI_LABEL = 'layered-intelligence';
export const LI_BLOCKING_LABEL = 'layered-intelligence:blocking';

// `{ name, color, description }` shared by every caller that creates a marker label.
export const LI_LABEL_SPEC = Object.freeze({ name: LI_LABEL, color: '1d76db', description: 'Filed by the Layered Intelligence loop' });
export const LI_BLOCKING_LABEL_SPEC = Object.freeze({ name: LI_BLOCKING_LABEL, color: 'b60205', description: 'Layered Intelligence loop is paused on this issue' });

// Label marking work the user has COMMITTED to (the `plannedWork` source filter).
export const PLANNED_WORK_LABEL = 'plan';

export const PLANNED_WORK_MAX_ITEMS = 15;

export const PLANNED_WORK_MAX_CHARS = 8000;

// Attached beneath the plannedWork block: turns "here is the backlog" into "do not file against it".
export const PLANNED_WORK_GUIDANCE = 'Cross-reference your proposal against the user\'s actively-planned work above. If your proposal duplicates or conflicts with an active item, DO NOT file — return proposal: null. Only propose genuinely new work that does NOT overlap with what is already in scope.';

// Human-authored playbook rendered verbatim as `liPlaybook`. Ships in the source tree
// (not seeded to data/prompts/), so no PROMPT_VERSIONS bump. A missing file is a
// packaging bug worth failing loudly at load.
export const LI_PROPOSAL_PLAYBOOK = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'layeredIntelligence.playbook.md'),
  'utf-8'
).trim();

export const LI_PLAYBOOK_GUIDANCE = 'This playbook is the distilled, standing rule set for choosing WHAT to propose — apply it as a hard constraint on scope, task type, and goal alignment before you commit to a proposal. Where a live report above (liOutcomes / liProposalExecution) contradicts a general rule here with real data for THIS app, the live data wins; absent that data, follow the playbook.';

// Tracker read SUCCEEDED and nothing is planned; stated explicitly so it is not mistaken for a missing source.
export const PLANNED_WORK_NONE = 'No actively-planned work is currently tracked for this app. (The tracker was read successfully — this is a real "nothing is planned", not a failed read.)';

// Stable opening of the failed-read marker, so `hasPlannedWorkListing` can tell it from a real listing.
export const PLANNED_WORK_UNAVAILABLE_PREFIX = 'Planned work could NOT be read';

// Jira labels can't contain spaces and ":" is unsafe on some versions; LI_LABEL is already Jira-safe.
export const LI_JIRA_BLOCKING_LABEL = 'layered-intelligence-blocking';

export const CLOSED_SUPPRESSION_MS = 30 * DAY;

// Cosine floor for the embedding near-duplicate guard; conservative (768-dim near-dups sit around 0.9+).
export const SEMANTIC_DEDUP_THRESHOLD = 0.9;

export const SEMANTIC_DEDUP_MAX_CANDIDATES = 50;

// RETIRED global job id; kept ONLY so migration 184 can tombstone the legacy record.
export const LI_JOB_ID = 'job-layered-intelligence';

// Every proposal scope the reasoner may return; the handler enforces where each lands (PROPOSAL_SCOPE_TARGETS).
export const PROPOSAL_SCOPES = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];

// Scopes fileable only when the sweeping app IS the PortOS install (they improve the loop itself).
export const PORTOS_ONLY_SCOPES = ['loop-meta', 'portos-self'];

// Only `trivial` is eligible for the Engine-A hand-off; unrecognized normalizes to null (never handed off).
export const PROPOSAL_COMPLEXITIES = ['trivial', 'moderate', 'complex'];

// With `safe: true` and hand-off enabled, lets the loop enqueue a coding agent instead of only filing.
export const HANDOFF_COMPLEXITY = 'trivial';

// Merge rate (%) below which computeOutcomesReport points the reasoner at plannedWork; RESOLVED proposals only.
export const LOW_MERGE_RATE_THRESHOLD = 20;

// A single early rejection must not trigger the alarm; it would bias the loop toward filing nothing.
export const LOW_MERGE_RATE_MIN_SAMPLE = 4;

// LI's SCHEDULE name and type-failure ledger key; NOT the key its runs are recorded under.
export const LI_SCHEDULED_TASK_TYPE = 'layered-intelligence';

// The `learning.json` byTaskType key LI's runs land under. DERIVED via the writer's own
// extractTaskType (it records `self-improve:<type>`), so it cannot drift.
export const LI_TASK_TYPE = extractTaskType({ metadata: { analysisType: LI_SCHEDULED_TASK_TYPE } });

// LI-task success rate (%) below which selfEval reports execution as DEGRADED. 50 rather
// than the merge-rate's 20: a rejected proposal is normal triage, a failing run is not.
export const LI_DEGRADED_SUCCESS_THRESHOLD = 50;

export const LI_DEGRADED_MIN_SAMPLE = 4;

// Execution health (%) below which the hard pre-filing exclusion gate arms. Wider net than
// the advisory degraded line since it SUPPRESSES filing; needs >= LI_DEGRADED_MIN_SAMPLE runs.
export const LI_HARD_GATE_EXECUTION_THRESHOLD = 75;

// Approval-funnel window; shorter than retention, which would equal the lifetime rate and never move.
export const LI_APPROVAL_FUNNEL_WINDOW_MS = 14 * DAY;

// Approver-delay age marks (days). CUMULATIVE and ascending (decay curve, not a partition); ascending order is load-bearing for the rendered line and bucket keys.
export const LI_APPROVAL_DELAY_BUCKET_DAYS = [1, 3, 7];

export const LI_DELIVERY_MIN_SAMPLE = 5;

// Approval → completion rate (%) below which the hard gate also arms; independent of the
// execution threshold so neither rate masks the other.
export const LI_HARD_GATE_DELIVERY_THRESHOLD = 50;

// Resolved filing outcomes; null means open. deriveOutcome: completed → merged, not_planned →
// rejected, other reason → abandoned, no reason → merged.
export const PROPOSAL_OUTCOMES = ['merged', 'rejected', 'abandoned'];

// EXECUTION outcomes of a handed-off proposal, distinct from the filing fate. Environmental
// failures (rate-limit/outage) are not recorded.
export const PROPOSAL_EXECUTION_OUTCOMES = ['success', 'failure'];

// Minimum executions before a domain's rate is trusted for avoid/prefer; lower than
// SCOPE_AWARENESS_MIN_SAMPLE because hand-offs are rare.
export const PROPOSAL_EXECUTION_MIN_SAMPLE = 2;

// Scope awareness: "avoid" below AVOID (reuses the degraded line) with enough runs, "prefer"
// at/above PREFER. Recomputed each run from the windowed rate, so nothing persisted goes stale.
export const SCOPE_AVOID_SUCCESS_THRESHOLD = LI_DEGRADED_SUCCESS_THRESHOLD; // < 50% → avoid
export const SCOPE_PREFER_SUCCESS_THRESHOLD = 75;                          // >= 75% → prefer

// Minimum completed runs before a scope's rate is trusted; advisory, so below the degraded floor.
export const SCOPE_AWARENESS_MIN_SAMPLE = 3;

export const SCOPE_AWARENESS_MAX_PER_LIST = 12;
export const SCOPE_AWARENESS_MAX_TYPE_LEN = 80;
