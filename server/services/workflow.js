/**
 * Workflow Service
 *
 * Defines the canonical project-maintenance workflow across PortOS scheduled
 * tasks (taskSchedule.js, per-app improvement tasks) and autonomous jobs
 * (autonomousJobs.js, system-level recurring jobs).
 *
 * The workflow is a conceptual ordering — actual execution remains driven by
 * each item's own schedule. The `runAfter` field on a task type encodes a
 * hard dependency (taskSchedule already enforces it); stage ordering here is
 * a recommendation surfaced in the visualizer so users can reason about
 * how their schedule fits together.
 *
 * Stages (in canonical order):
 *   1. hygiene  — reset state: cleanup branches and old agent data
 *   2. review   — review existing in-flight work (open PRs, codebase review)
 *   3. plan     — replan based on current state of the repo
 *   4. audit    — quality/security audits that don't depend on planning
 *   5. build    — implement new work from the (now fresh) plan
 *   6. report   — externalize status (JIRA, briefing, etc.)
 *   7. ambient  — recurring jobs that don't fit the dev-loop ordering
 */

import { getScheduleStatus } from './taskSchedule.js';
import * as autonomousJobs from './autonomousJobs.js';
import { checkJobGate, hasGate, getRegisteredGates } from './jobGates.js';

/**
 * Stage definitions. `taskTypes` are entries from taskSchedule's tasks map;
 * `jobIds` are entries from autonomousJobs. An item can appear in only one
 * stage; orphans are reported under the `ambient` stage by getWorkflowGraph().
 */
export const WORKFLOW_STAGES = [
  {
    id: 'hygiene',
    label: 'Hygiene',
    description: 'Reset state: clean up merged branches and stale agent data so downstream stages start clean.',
    taskTypes: ['branch-cleanup'],
    jobIds: ['job-agent-data-cleanup']
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Review existing in-flight work — open pull requests and the current codebase — before planning new work.',
    taskTypes: ['pr-reviewer', 'code-reviewer-a', 'code-reviewer-b', 'reference-watch'],
    jobIds: ['job-brain-review']
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Audit PLAN.md against what actually shipped and surface gaps. Runs only after review/cleanup so the plan reflects merged reality.',
    taskTypes: ['do-replan'],
    jobIds: []
  },
  {
    id: 'audit',
    label: 'Audit',
    description: 'Quality, security, and accessibility audits. Independent of the plan, but typically scheduled lighter than build work.',
    taskTypes: [
      'security',
      'code-quality',
      'test-coverage',
      'performance',
      'accessibility',
      'console-errors',
      'dependency-updates',
      'documentation',
      'error-handling',
      'typing',
      'ui-bugs',
      'mobile-responsive'
    ],
    jobIds: ['job-wiki-maintenance']
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Implement the next planned feature. Gated on do-replan so new work is grounded in a fresh plan.',
    taskTypes: ['feature-ideas', 'plan-task'],
    jobIds: []
  },
  {
    id: 'report',
    label: 'Report',
    description: 'Externalize status — JIRA tickets, daily briefing, release readiness — once the build cycle has settled.',
    taskTypes: ['jira-sprint-manager', 'jira-status-report', 'release-check'],
    jobIds: ['job-daily-briefing', 'job-datadog-error-monitor']
  },
  {
    id: 'ambient',
    label: 'Ambient',
    description: 'Recurring jobs that run independently of the dev loop — system health, repo maintenance, personal prompts.',
    taskTypes: [],
    jobIds: [
      'job-github-repo-maintenance',
      'job-system-health-check',
      'job-autobiography-prompt',
      'job-moltworld-exploration',
      'job-goal-check-in'
    ]
  }
];

const STAGE_INDEX = new Map(WORKFLOW_STAGES.map((s, i) => [s.id, i]));

/**
 * Build a reverse map from task type / job id → stage id.
 * Used to classify items the schedule contains that we haven't categorized.
 */
function buildItemStageMap() {
  const map = new Map();
  for (const stage of WORKFLOW_STAGES) {
    for (const t of stage.taskTypes) map.set(`task:${t}`, stage.id);
    for (const j of stage.jobIds) map.set(`job:${j}`, stage.id);
  }
  return map;
}

/**
 * Build the workflow graph for the visualizer.
 *
 * Returns:
 *   { stages: [...], nodes: [...], edges: [...], generatedAt }
 *
 * - nodes: every scheduled task type and every autonomous job, with
 *   { id, kind ('task'|'job'), stage, label, schedule, enabled, lastRun,
 *     runAfter, gate, blocked }
 * - edges: explicit runAfter dependencies and inter-stage flow hints
 *   { from, to, kind: 'depends-on' | 'stage-flow' }
 *   `depends-on` edges connect node ids (`task:foo` → `task:bar`).
 *   `stage-flow` edges connect entries in the `stages` list (bare stage ids
 *   like `plan` → `build`); they have no corresponding entries in `nodes`.
 */
export async function getWorkflowGraph() {
  const [scheduleStatus, jobs] = await Promise.all([
    getScheduleStatus(),
    autonomousJobs.getAllJobs()
  ]);

  const itemStage = buildItemStageMap();
  const nodes = [];
  const edges = [];

  // Task nodes — getScheduleStatus returns flat objects spreading interval + execution + status
  for (const [taskType, info] of Object.entries(scheduleStatus.tasks || {})) {
    const stageId = itemStage.get(`task:${taskType}`) || 'ambient';
    const runAfter = Array.isArray(info.runAfter) ? info.runAfter : [];
    nodes.push({
      id: `task:${taskType}`,
      kind: 'task',
      stage: stageId,
      label: taskType,
      enabled: !!info.enabled,
      schedule: {
        type: info.type,
        intervalMs: info.intervalMs ?? null,
        cronExpression: info.cronExpression ?? null,
        weekdaysOnly: !!info.weekdaysOnly
      },
      lastRun: info.lastRun || null,
      runCount: info.runCount || 0,
      runAfter,
      gate: null,
      // Only true gating reasons (waiting on hard prerequisites) are surfaced as `blocked`
      // — that field drives warning styling in the UI. Other shouldRun=false states (cooldown,
      // weekday-only, disabled-for-app, etc.) are exposed via `statusReason` so the UI can
      // render them as neutral "waiting" rather than a warning.
      blocked: info.status?.reason === 'waiting-on-dependencies' ? info.status.reason : null,
      statusReason: info.status?.shouldRun === false ? info.status.reason : null,
      shouldRun: info.status?.shouldRun === true,
      pendingDeps: info.status?.pendingDeps || []
    });

    for (const dep of runAfter) {
      edges.push({ from: `task:${dep}`, to: `task:${taskType}`, kind: 'depends-on' });
    }
  }

  // Job nodes — include gate metadata and last-known evaluation. Gate checks may perform I/O
  // (inbox counts, goals lookups, etc.), so run them in parallel rather than sequentially.
  const gateIds = new Set(getRegisteredGates());
  const gateResults = await Promise.all(
    jobs.map(job => (gateIds.has(job.id) ? checkGateSafe(job.id) : Promise.resolve(null)))
  );
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const stageId = itemStage.get(`job:${job.id}`) || 'ambient';
    const gateInfo = gateResults[i];
    nodes.push({
      id: `job:${job.id}`,
      kind: 'job',
      stage: stageId,
      label: job.name || job.id,
      enabled: !!job.enabled,
      schedule: {
        type: job.interval || (job.cronExpression ? 'cron' : 'custom'),
        intervalMs: job.intervalMs ?? null,
        cronExpression: job.cronExpression ?? null,
        scheduledTime: job.scheduledTime ?? null,
        weekdaysOnly: !!job.weekdaysOnly
      },
      lastRun: job.lastRun || null,
      runCount: job.runCount || 0,
      runAfter: [],
      gate: gateInfo,
      // Jobs without gates are implicitly runnable; gate.shouldRun=false => blocked
      blocked: gateInfo && gateInfo.shouldRun === false ? gateInfo.reason : null,
      shouldRun: gateInfo ? gateInfo.shouldRun !== false : true
    });
  }

  // Stage-flow edges — chain stages in canonical order so the visualizer can
  // render a left-to-right pipeline. Skip empty stages. These edges target bare
  // stage ids (matching the `stages` list), not node ids.
  const populatedStages = WORKFLOW_STAGES.filter(stage =>
    nodes.some(n => n.stage === stage.id)
  );
  for (let i = 0; i < populatedStages.length - 1; i++) {
    edges.push({
      from: populatedStages[i].id,
      to: populatedStages[i + 1].id,
      kind: 'stage-flow'
    });
  }

  // Sort stages by canonical order
  const stages = WORKFLOW_STAGES.map(s => ({
    id: s.id,
    label: s.label,
    description: s.description,
    order: STAGE_INDEX.get(s.id),
    nodeCount: nodes.filter(n => n.stage === s.id).length,
    enabledCount: nodes.filter(n => n.stage === s.id && n.enabled).length
  }));

  return {
    generatedAt: new Date().toISOString(),
    stages,
    nodes,
    edges
  };
}

async function checkGateSafe(jobId) {
  if (!hasGate(jobId)) return null;
  const result = await checkJobGate(jobId).catch(err => ({
    shouldRun: true,
    reason: `gate-error: ${err?.message || err}`,
    error: true
  }));
  return result;
}
