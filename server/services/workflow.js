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
import { parseCronToNextRun } from './eventScheduler.js';
import { getLocalParts, getUserTimezone, nextLocalTime } from '../lib/timezone.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_OCCURRENCES_PER_NODE = 200;

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
      'mobile-responsive',
      'refresh-local-llm-catalog'
    ],
    jobIds: ['job-wiki-maintenance']
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Implement the next planned feature. Gated on do-replan so new work is grounded in a fresh plan.',
    taskTypes: ['feature-ideas', 'plan-task', 'claim-issue'],
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
export async function getWorkflowGraph({ horizonHours = 24, from = new Date() } = {}) {
  const safeHorizonHours = Math.min(24 * 14, Math.max(1, Number(horizonHours) || 24));
  const start = Number.isNaN(new Date(from).getTime()) ? new Date() : new Date(from);
  const [scheduleStatus, jobs, timezone] = await Promise.all([
    getScheduleStatus(),
    autonomousJobs.getAllJobs(),
    getUserTimezone()
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
        effectiveIntervalMs: info.adjustedIntervalMs ?? info.intervalMs ?? null,
        cronExpression: info.cronExpression ?? null,
        recheckCron: info.recheckCron ?? null,
        recheckIntervalMs: info.recheckIntervalMs ?? null,
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
      pendingDeps: info.status?.pendingDeps || [],
      nextRunAt: info.status?.nextRunAt || info.perpetual?.nextRecheckAt || null,
      perpetual: info.perpetual || null
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

  const generatedAt = new Date().toISOString();
  const timeline = projectWorkflowTimeline(nodes, {
    start,
    end: new Date(start.getTime() + safeHorizonHours * HOUR),
    timezone
  });

  return {
    generatedAt,
    timezone,
    stages,
    nodes,
    edges,
    timeline
  };
}

/**
 * Project heterogeneous scheduler definitions onto one clock. Occurrences are
 * launch/recheck instants; windows describe work that is currently perpetual.
 * Flexible rotation/on-demand tasks intentionally have neither because the
 * scheduler does not promise them a wall-clock position.
 */
export function projectWorkflowTimeline(nodes, { start, end, timezone = 'UTC' }) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const occurrences = [];
  const windows = [];

  for (const node of nodes.filter(item => item.enabled)) {
    const schedule = node.schedule || {};
    if (node.kind === 'task' && schedule.type === 'perpetual') {
      projectPerpetual(node, startMs, endMs, timezone, occurrences, windows);
      continue;
    }

    if (schedule.cronExpression) {
      if (isCronDueNow(node, schedule.cronExpression, startMs, timezone)) {
        occurrences.push(makeOccurrence(node, startMs, 'launch'));
      }
      appendCronOccurrences(node, schedule.cronExpression, startMs, endMs, timezone, occurrences, 'launch');
      continue;
    }

    if (node.kind === 'job') {
      projectIntervalJob(node, startMs, endMs, timezone, occurrences);
      continue;
    }

    projectIntervalTask(node, startMs, endMs, occurrences);
  }

  occurrences.sort((a, b) => new Date(a.at) - new Date(b.at) || a.nodeId.localeCompare(b.nodeId));
  const collisionOccurrenceIds = findCollisionOccurrenceIds(occurrences);

  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    timezone,
    occurrences: occurrences.map(item => ({ ...item, collision: collisionOccurrenceIds.has(item.id) })),
    windows
  };
}

function appendCronOccurrences(node, expression, startMs, endMs, timezone, target, kind) {
  let cursor = new Date(startMs - 60_000);
  for (let i = 0; i < MAX_OCCURRENCES_PER_NODE; i++) {
    let next;
    try {
      next = parseCronToNextRun(expression, cursor, timezone);
    } catch {
      return;
    }
    if (!next || next.getTime() >= endMs) return;
    if (next.getTime() >= startMs) target.push(makeOccurrence(node, next.getTime(), kind));
    cursor = next;
  }
}

function projectPerpetual(node, startMs, endMs, timezone, occurrences, windows) {
  const perpetual = node.perpetual;
  const allTrackedAppsParked = perpetual?.trackedAppCount > 0 && perpetual.parkedAppCount === perpetual.trackedAppCount;
  const draining = node.shouldRun && !perpetual?.globalParked && !allTrackedAppsParked && node.statusReason !== 'perpetual-parked';
  if (draining) {
    windows.push({
      id: `${node.id}:active`,
      nodeId: node.id,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      kind: 'perpetual',
      state: 'draining'
    });
  }

  const recheckCron = node.schedule?.recheckCron;
  if (recheckCron) {
    appendCronOccurrences(node, recheckCron, startMs, endMs, timezone, occurrences, 'recheck');
    return;
  }

  const nextRecheckMs = node.nextRunAt ? new Date(node.nextRunAt).getTime() : NaN;
  const cadence = node.schedule?.recheckIntervalMs || DAY;
  if (Number.isFinite(nextRecheckMs)) {
    appendIntervalOccurrences(node, nextRecheckMs, cadence, startMs, endMs, occurrences, 'recheck');
  }
}

function projectIntervalTask(node, startMs, endMs, occurrences) {
  const type = node.schedule?.type;
  if (type === 'rotation' || type === 'on-demand') return;
  if (type === 'once') {
    if (node.shouldRun) occurrences.push(makeOccurrence(node, startMs, 'launch'));
    return;
  }

  const cadence = node.schedule?.effectiveIntervalMs
    || (type === 'weekly' ? 7 * DAY : type === 'daily' ? DAY : node.schedule?.intervalMs);
  if (!cadence) return;

  let nextMs = node.shouldRun ? startMs : (node.nextRunAt ? new Date(node.nextRunAt).getTime() : NaN);
  if (!Number.isFinite(nextMs)) {
    const lastRunMs = node.lastRun ? new Date(node.lastRun).getTime() : NaN;
    nextMs = Number.isFinite(lastRunMs) ? lastRunMs + cadence : startMs;
  }
  appendIntervalOccurrences(node, nextMs, cadence, startMs, endMs, occurrences, 'launch');
}

function projectIntervalJob(node, startMs, endMs, timezone, occurrences) {
  const cadence = node.schedule?.intervalMs;
  if (!cadence) return;
  const lastRunMs = node.lastRun ? new Date(node.lastRun).getTime() : NaN;
  let nextMs = Number.isFinite(lastRunMs) ? lastRunMs + cadence : startMs;
  const timeMatch = String(node.schedule?.scheduledTime || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (isIntervalJobDueNow(node, startMs, timezone)) {
    occurrences.push(makeOccurrence(node, startMs, 'launch'));
    nextMs = startMs + cadence;
  }

  for (let i = 0; i < MAX_OCCURRENCES_PER_NODE && nextMs < endMs; i++) {
    if (timeMatch) {
      nextMs = nextLocalTime(nextMs - 60_000, Number(timeMatch[1]), Number(timeMatch[2]), timezone);
    }
    if (nextMs >= startMs && nextMs < endMs && isAllowedWeekday(node, nextMs, timezone)) {
      occurrences.push(makeOccurrence(node, nextMs, 'launch'));
    }
    nextMs += cadence;
  }
}

function isCronDueNow(node, expression, startMs, timezone) {
  if (node.kind === 'task') return node.shouldRun === true;
  if (!node.lastRun) return false;
  try {
    const next = parseCronToNextRun(expression, new Date(node.lastRun), timezone);
    return !!next && next.getTime() <= startMs;
  } catch {
    return false;
  }
}

function isIntervalJobDueNow(node, startMs, timezone) {
  const cadence = node.schedule?.intervalMs;
  if (!cadence || !isAllowedWeekday(node, startMs, timezone)) return false;
  const lastRunMs = node.lastRun ? new Date(node.lastRun).getTime() : 0;
  if (startMs - lastRunMs < cadence) return false;

  const match = String(node.schedule?.scheduledTime || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return true;
  const localNow = getLocalParts(new Date(startMs), timezone);
  let targetMs = nextLocalTime(startMs - DAY, Number(match[1]), Number(match[2]), timezone);
  let targetLocal = getLocalParts(new Date(targetMs), timezone);
  if (targetLocal.year !== localNow.year || targetLocal.month !== localNow.month || targetLocal.day !== localNow.day) {
    targetMs = nextLocalTime(targetMs + 1, Number(match[1]), Number(match[2]), timezone);
  }
  return targetMs <= startMs && lastRunMs < targetMs;
}

function isAllowedWeekday(node, atMs, timezone) {
  if (!node.schedule?.weekdaysOnly) return true;
  const day = getLocalParts(new Date(atMs), timezone).dayOfWeek;
  return day >= 1 && day <= 5;
}

function appendIntervalOccurrences(node, firstMs, cadence, startMs, endMs, target, kind) {
  if (!Number.isFinite(firstMs) || !Number.isFinite(cadence) || cadence <= 0) return;
  let nextMs = firstMs;
  if (nextMs < startMs) nextMs += Math.ceil((startMs - nextMs) / cadence) * cadence;
  for (let i = 0; i < MAX_OCCURRENCES_PER_NODE && nextMs < endMs; i++, nextMs += cadence) {
    target.push(makeOccurrence(node, nextMs, kind));
  }
}

function makeOccurrence(node, atMs, kind) {
  return {
    id: `${node.id}:${kind}:${atMs}`,
    nodeId: node.id,
    at: new Date(atMs).toISOString(),
    kind
  };
}

function findCollisionOccurrenceIds(occurrences) {
  const ids = new Set();
  const launches = occurrences.filter(item => item.kind === 'launch');
  const threshold = 15 * 60_000;
  for (let i = 0; i < launches.length; i++) {
    for (let j = i + 1; j < launches.length; j++) {
      const delta = new Date(launches[j].at) - new Date(launches[i].at);
      if (delta > threshold) break;
      if (launches[i].nodeId !== launches[j].nodeId) {
        ids.add(launches[i].id);
        ids.add(launches[j].id);
      }
    }
  }
  return ids;
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
