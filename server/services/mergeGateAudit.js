/**
 * Post-merge gate audit for claim runs (#12549).
 *
 * The merge-admission lease and the "required CI is green" rule are prompt
 * instructions, and a claim agent has full forge access, so nothing stops it
 * merging around them. This runs after the run completes and asks the forge:
 * did each PR the run merged hold the repository's admission lease, and were all
 * checks on the merged head green before `mergedAt`? A miss is recorded on the
 * run, in the run-events ledger and as a notification. When the flagged head's
 * checks then fail, ONE recovery task is queued for the default branch so
 * concurrent runs inherit a single fix rather than each writing their own.
 *
 * Detection only: it never merges, reverts or edits a repository.
 */

import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { emitLog } from './cosEvents.js';
import { appendRunEvent } from './agentRunEventLog.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import { getAppById, getActiveApps, updateApp } from './apps.js';
import { RECOVERY_TASK_PREFIX } from './recoveryTasks.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { githubRepoSpec, githubApiHost } from '../lib/workTracker.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { assessMergeGate, classifyHeadChecks, MERGE_GATE_VIOLATIONS } from '../lib/mergeGateAudit.js';

// A flagged head whose checks never settle is dropped after this long; the
// sweep owns it until then.
export const MERGE_GATE_WATCH_TTL_MS = 6 * 60 * 60 * 1000;
// Fast follow-up after a flag, so a head failing in minutes is reported in
// minutes; the 30-minute CoS sweep is the durable fallback after a restart.
export const MERGE_GATE_POLL_INTERVAL_MS = 2 * 60 * 1000;
const MERGE_GATE_POLL_CAP = 15;
const LIST_LIMIT = 50;
const SHORT_SHA = 12;

const MERGED_PR_FIELDS = 'number,url,headRefOid,mergedAt,baseRefName';

const readList = (value) => (Array.isArray(value) ? value : []);
const auditKey = (pr) => `${pr.number}@${String(pr.headRefOid).toLowerCase()}`;
const watchKey = (repository, headSha) => `${repository}#${String(headSha).toLowerCase()}`;
const readWatches = (app) => readList(app?.mergeGateWatches).filter((watch) => isPlainObject(watch) && watch.key);

/** The check runs of `headSha`, or null when the forge could not be read. */
async function readHeadCheckRuns({ origin, repoSpec, forgeExec, headSha }) {
  const raw = await execGh([
    'api', '--hostname', githubApiHost(origin.host), '--paginate',
    `repos/${origin.fullName}/commits/${headSha}/check-runs?per_page=100`,
    '--jq', '.check_runs[] | {name, status, conclusion, completed_at}',
  ], undefined, { ...forgeExec, backoffKey: repoSpec }).catch(() => null);
  if (raw === null) return null;
  const runs = String(raw).split('\n').map((line) => line.trim()).filter(Boolean).map((line) => safeJSONParse(line, null));
  return runs.every(isPlainObject) ? runs : null;
}

async function readMergedPrs({ repoSpec, forgeExec, branch, since }) {
  const raw = await execGh([
    'pr', 'list', '--repo', repoSpec, '--head', branch, '--state', 'merged',
    '--json', MERGED_PR_FIELDS, '--limit', '5',
  ], undefined, { ...forgeExec, backoffKey: repoSpec }).catch(() => null);
  const prs = raw === null ? null : safeJSONParse(raw, null);
  if (!Array.isArray(prs)) return null;
  // A reused branch name can carry an earlier run's PR.
  return prs.filter((pr) => isPlainObject(pr) && /^[0-9a-f]{40}$/i.test(String(pr.headRefOid || ''))
    && Number.isFinite(Date.parse(pr.mergedAt)) && (since === null || Date.parse(pr.mergedAt) >= since));
}

/** A lease the run still holds (it exited without releasing), from the trusted admission state. */
async function readHeldLease(agent, repository) {
  const { readMergeAdmissionStateForSafetyCheck } = await import('./cosState.js');
  const snapshot = await readMergeAdmissionStateForSafetyCheck().catch(() => null);
  const lease = snapshot?.trusted ? snapshot.mergeAdmissions?.[repository] : null;
  return isPlainObject(lease) && lease.kind === 'agent' && lease.agentId === agent.id
    && lease.startedAt === agent.startedAt && lease.taskId === agent.taskId ? lease : null;
}

function recoveryContext(watch, failing, appName) {
  return [
    `A pull request merged in ${appName} (${watch.repository}) before its head's checks finished green`
      + `${watch.codes.includes(MERGE_GATE_VIOLATIONS.NO_ADMISSION_LEASE) ? ' and without the merge-admission lease' : ''}, `
      + 'and those checks have now failed.',
    '',
    `Merged PR: ${watch.prUrl}`,
    `Merged head: ${watch.headSha}`,
    `Base branch: ${watch.baseBranch}`,
    `Failing checks: ${failing.slice(0, 10).join(', ')}`,
    `Merging run: ${watch.agentId}`,
    '',
    `Make ${watch.baseBranch} green again, in one pull request: either fix what the failing checks report or revert the merge.`,
    'Other claim runs hit the same failure and may already be writing their own fixes. '
      + `Before changing anything, check open pull requests and recent commits on ${watch.baseBranch} for a fix that already landed or is in flight, `
      + 'and reuse it instead of writing a competing one.',
  ].join('\n');
}

async function fileRecoveryTask(watch, failing, app) {
  const { addTask } = await import('./cosTaskStore.js');
  const created = await addTask({
    description: `${RECOVERY_TASK_PREFIX} Default branch ${watch.baseBranch} is red after PR #${watch.prNumber} merged past the merge gate (${watch.headSha.slice(0, SHORT_SHA)}) in ${app.name || watch.repository}`,
    priority: 'HIGH',
    app: app.id,
    isRecovery: true,
    metadata: { mergeGateRecovery: { repository: watch.repository, headSha: watch.headSha, prUrl: watch.prUrl, baseBranch: watch.baseBranch } },
    context: recoveryContext(watch, failing, app.name || watch.repository),
    useWorktree: true,
    openPR: true,
  }, 'user');
  if (created?.duplicate) {
    emitLog('info', `🚦 Merge-gate recovery for ${watch.headSha.slice(0, SHORT_SHA)} already queued as ${created.id}`, { agentId: watch.agentId });
    return null;
  }
  emitLog('warn', `🚦 Queued merge-gate recovery for ${watch.baseBranch} (PR #${watch.prNumber}, ${failing.length} failing check(s))`, { agentId: watch.agentId, prUrl: watch.prUrl });
  return created?.id || null;
}

// apps.json is one store: serialize this module's read-modify-write of its field.
let watchWriteTail = Promise.resolve();
function mutateWatches(appId, mutate) {
  const next = watchWriteTail.catch(() => undefined).then(async () => {
    const app = await getAppById(appId);
    if (!app) return null;
    return updateApp(appId, { mergeGateWatches: mutate(readWatches(app)) });
  });
  watchWriteTail = next;
  return next;
}

async function notifyViolation(watch, violations, failing) {
  const codes = violations.map((violation) => violation.message).join('; ');
  return addNotification({
    type: NOTIFICATION_TYPES.AGENT_WARNING,
    priority: PRIORITY_LEVELS.HIGH,
    title: `PR #${watch.prNumber} bypassed the merge gate`,
    description: `Run ${watch.agentId} ${codes}.${failing.length ? ` ${failing.length} check(s) on the merged head already failed.` : ''}`,
    link: watch.prUrl,
    metadata: { agentId: watch.agentId, prNumber: watch.prNumber, headSha: watch.headSha },
  }).catch((err) => console.error(`❌ Failed to notify about merge-gate violation on PR #${watch.prNumber}: ${err.message}`));
}

async function recordViolation(agent, watch, violations, checkNames) {
  emitLog('warn', `🚦 Merge gate bypassed by ${agent.id}: PR #${watch.prNumber} ${violations.map((violation) => violation.message).join('; ')}`,
    { agentId: agent.id, taskId: agent.taskId, prUrl: watch.prUrl });
  await appendRunEvent({
    kind: 'run.merge-gate-violation',
    runId: agent.metadata?.runId,
    agentId: agent.id,
    taskId: agent.taskId,
    eventId: `merge-gate:${agent.id}:${watch.prNumber}:${watch.headSha}`,
    data: { prNumber: watch.prNumber, headSha: watch.headSha, mergedAt: watch.mergedAt, codes: watch.codes, checks: checkNames.slice(0, 10) },
  });
}

/**
 * Audit the PRs a completed claim run merged.
 *
 * @param {object} params
 * @param {string} params.agentId
 * @param {object|null} params.task - the CoS task
 * @param {object|null} params.agentState - the persisted agent record
 * @returns {Promise<{ audited: number, violations: number, skipReason?: string }>}
 */
export async function auditClaimMergeGate({ agentId, task, agentState }) {
  const metadata = agentState?.metadata || {};
  const branches = [...new Set([...readList(metadata.claimBranches), metadata.claimBranch].filter((b) => typeof b === 'string' && b))];
  const none = (skipReason) => ({ audited: 0, violations: 0, skipReason });
  if (branches.length === 0) return none('not-a-claim-run');
  if (!metadata.sourceWorkspace) return none('no-source-workspace');

  const origin = await getOriginInfo(metadata.sourceWorkspace).catch(() => null);
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return none('not-a-github-repo');
  const appId = task?.metadata?.app || null;
  const app = appId ? await getAppById(appId).catch(() => null) : null;
  const forgeExec = await resolveForgeExecOptions(metadata.sourceWorkspace, { forgeAccount: app?.forgeAccount });
  const { repositoryKey } = await import('./cosMergeAdmission.js');
  const repository = repositoryKey(origin);
  const startedMs = Date.parse(agentState?.startedAt);
  const since = Number.isFinite(startedMs) ? startedMs : null;

  const audited = new Set(readList(metadata.mergeGateAudits));
  const newAudits = [];
  const found = [];
  let unreadable = false;
  for (const branch of branches) {
    const prs = await readMergedPrs({ repoSpec, forgeExec, branch, since });
    if (prs === null) { unreadable = true; continue; }
    for (const pr of prs.filter((candidate) => !audited.has(auditKey(candidate)))) {
      const headSha = String(pr.headRefOid).toLowerCase();
      const checks = await readHeadCheckRuns({ origin, repoSpec, forgeExec, headSha });
      const heldLease = await readHeldLease({ ...agentState, id: agentId }, repository);
      const verdict = assessMergeGate({
        repository, headSha, mergedAt: pr.mergedAt, checks, heldLease,
        receipts: readList(metadata.mergeHandoffReceipts),
        history: [...readList(metadata.mergeAdmissionHistory), ...(metadata.lastMergeAdmission ? [metadata.lastMergeAdmission] : [])],
      });
      // An unreadable check list is no verdict on the checks rule; retry on a later pass.
      if (checks !== null) newAudits.push(auditKey(pr));
      if (verdict.violations.length === 0) continue;
      found.push({ pr, headSha, verdict });
    }
  }
  if (unreadable) emitLog('info', `🚦 Merge-gate audit for ${agentId} could not read every claim branch's PRs`, { agentId });

  const violationRecords = [];
  for (const { pr, headSha, verdict } of found) {
    const codes = verdict.violations.map((violation) => violation.code);
    const watch = {
      key: watchKey(repository, headSha), repository, agentId, taskId: agentState?.taskId ?? null,
      prUrl: pr.url, prNumber: pr.number, headSha, baseBranch: pr.baseRefName || 'the default branch',
      mergedAt: pr.mergedAt, flaggedAt: new Date().toISOString(), codes,
    };
    const checkNames = verdict.checks.notGreenAtMerge;
    await recordViolation({ ...agentState, id: agentId }, watch, verdict.violations, checkNames);
    await notifyViolation(watch, verdict.violations, verdict.checks.failing);
    violationRecords.push({ prUrl: pr.url, prNumber: pr.number, headSha, mergedAt: pr.mergedAt, detectedAt: watch.flaggedAt,
      codes, notGreenAtMerge: checkNames.slice(0, 10) });
    if (app && verdict.checks.readable) await watchFlaggedHead(watch, verdict.checks, app);
  }

  if (newAudits.length > 0 || violationRecords.length > 0) {
    const { updateAgent } = await import('./cosAgentLifecycle.js');
    await updateAgent(agentId, { metadata: {
      mergeGateAudits: [...audited, ...newAudits].slice(-LIST_LIMIT),
      ...(violationRecords.length ? { mergeGateViolations: [...readList(metadata.mergeGateViolations), ...violationRecords].slice(-LIST_LIMIT) } : {}),
    } }).catch((err) => emitLog('warn', `🚦 Could not record merge-gate audit on ${agentId}: ${err.message}`, { agentId }));
  }
  return { audited: newAudits.length, violations: found.length };
}

// Already-failed checks queue the recovery now; checks still running arm a watch
// that the sweep resolves. Settled-and-green needs no recovery: the default
// branch is not red.
async function watchFlaggedHead(watch, checks, app) {
  if (checks.failing.length > 0) {
    await fileRecoveryTask(watch, checks.failing, app)
      .catch((err) => emitLog('warn', `🚦 Merge-gate recovery for PR #${watch.prNumber} not queued: ${err.message}`, { agentId: watch.agentId }));
    return;
  }
  if (checks.settled) return;
  await mutateWatches(app.id, (existing) => (existing.some((entry) => entry.key === watch.key) ? existing : [...existing, watch]))
    .catch((err) => emitLog('warn', `🚦 Could not watch flagged head of PR #${watch.prNumber}: ${err.message}`, { agentId: watch.agentId }));
  scheduleWatchPolls(app.id);
}

const pollers = new Map();

// Bounded fast poll after a flag; every callback owns its rejections.
function scheduleWatchPolls(appId) {
  if (pollers.has(appId)) return;
  let polls = 0;
  const tick = () => {
    polls += 1;
    sweepMergeGateWatches({ appId }).then((result) => {
      if (result.remaining === 0 || polls >= MERGE_GATE_POLL_CAP) pollers.delete(appId);
      else pollers.set(appId, setTimeout(tick, MERGE_GATE_POLL_INTERVAL_MS).unref());
    }).catch((err) => {
      console.error(`❌ Merge-gate watch poll for app ${appId} failed: ${err.message}`);
      pollers.delete(appId);
    });
  };
  pollers.set(appId, setTimeout(tick, MERGE_GATE_POLL_INTERVAL_MS).unref());
}

/** Test seam: stop any armed fast polls. */
export function __cancelMergeGatePolls() {
  for (const timer of pollers.values()) clearTimeout(timer);
  pollers.clear();
}

let sweepInFlight = null;

async function sweepApp(app) {
  const watches = readWatches(app);
  if (watches.length === 0) return { checked: 0, recovered: 0, remaining: 0 };
  const origin = await getOriginInfo(app.repoPath).catch(() => null);
  const repoSpec = githubRepoSpec(origin);
  if (!repoSpec) return { checked: 0, recovered: 0, remaining: watches.length };
  const forgeExec = await resolveForgeExecOptions(app.repoPath, { forgeAccount: app.forgeAccount });
  const settledKeys = new Set();
  let recovered = 0;
  for (const watch of watches) {
    if (Date.now() - Date.parse(watch.flaggedAt) >= MERGE_GATE_WATCH_TTL_MS) {
      emitLog('info', `🚦 Dropping merge-gate watch for PR #${watch.prNumber}: checks did not settle in time`, { agentId: watch.agentId });
      settledKeys.add(watch.key);
      continue;
    }
    const checks = classifyHeadChecks(await readHeadCheckRuns({ origin, repoSpec, forgeExec, headSha: watch.headSha }), watch.mergedAt);
    if (checks.failing.length > 0) {
      const queued = await fileRecoveryTask(watch, checks.failing, app).then(() => true, (err) => {
        emitLog('warn', `🚦 Merge-gate recovery for PR #${watch.prNumber} not queued: ${err.message}`, { agentId: watch.agentId });
        return false;
      });
      if (queued) { settledKeys.add(watch.key); recovered += 1; }
    } else if (checks.readable && checks.settled) {
      settledKeys.add(watch.key);
    }
  }
  if (settledKeys.size > 0) await mutateWatches(app.id, (current) => current.filter((entry) => !settledKeys.has(entry.key)));
  return { checked: watches.length, recovered, remaining: watches.length - settledKeys.size };
}

/**
 * Resolve every flagged head still being watched: failing checks queue the one
 * recovery task, settled green checks close the watch.
 *
 * @param {{ appId?: string }} [options] limit to one app
 * @returns {Promise<{ checked: number, recovered: number, remaining: number }>}
 */
export function sweepMergeGateWatches({ appId = null } = {}) {
  // A concurrent sweep joins the one in flight; recovery dedupe rides on the task queue.
  if (sweepInFlight) return sweepInFlight;
  sweepInFlight = (async () => {
    const totals = { checked: 0, recovered: 0, remaining: 0 };
    const apps = appId ? [await getAppById(appId).catch(() => null)].filter(Boolean) : await getActiveApps().catch(() => []);
    for (const app of apps.filter((candidate) => readWatches(candidate).length > 0)) {
      const result = await sweepApp(app).catch((err) => {
        console.error(`❌ Merge-gate watch sweep failed for ${app.name}: ${err.message}`);
        return { checked: 0, recovered: 0, remaining: readWatches(app).length };
      });
      totals.checked += result.checked;
      totals.recovered += result.recovered;
      totals.remaining += result.remaining;
    }
    return totals;
  })().finally(() => { sweepInFlight = null; });
  return sweepInFlight;
}
