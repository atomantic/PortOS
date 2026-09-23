/** Agent-free maintenance scans. Receipts live with the existing CoS runtime state. */
import { randomUUID } from 'node:crypto';
import { loadState, saveState, withStateLock, isImprovementEnabled } from './cosState.js';
import { normalizePersistentMindMaintainer } from '../lib/persistentMindMaintainer.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { DEVELOPMENT_ACTIVE_STATUSES, sameDevelopmentWork } from '../lib/developmentWorkIdentity.js';
import { safeJSONParse } from '../lib/jsonIo.js';

let scanTail = Promise.resolve();
const tasksFrom = data => [...data.user.tasks, ...data.cos.tasks];
const ownershipTask = (app, pr) => ({ metadata: { app: app.id, reviewLoopPRUrl: pr.url } });
const parseGithubJson = value => safeJSONParse(value, null, { allowArray: false });

function authorized(state, appId, write = false) {
  const role = normalizePersistentMindMaintainer(state.config?.persistentMindMaintainer);
  const caps = normalizePersistentMindCapabilities(state.config?.persistentMindCapabilities);
  return role.enabled && caps.readPortos && (!write || caps.createTasks)
    && role.appIds.includes(appId) && (!caps.allowedAppIds || caps.allowedAppIds.includes(appId));
}

/** Latest bounded receipt; this read never refreshes, queues or invokes a model. */
export async function readDevelopmentWatchdogSnapshot() {
  return (await loadState()).developmentWatchdog?.latest || null;
}

async function participatingPeerTasks() {
  const { getPeers } = await import('./instances.js');
  const { peerFetch } = await import('../lib/peerHttpClient.js');
  const { peerBaseUrl } = await import('../lib/peerUrl.js');
  const { peerCosTasksSchema } = await import('../lib/peerSyncValidation.js');
  const { PORTOS_SCHEMA_VERSIONS } = await import('../lib/schemaVersions.js');
  let peers;
  try { peers = (await getPeers()).filter(p => p.enabled !== false && p.fullSync === true); }
  catch { return { tasks: [], blockers: [{ source: 'peer-ownership', reason: 'peer-registry-unavailable' }] }; }
  const tasks = [];
  const blockers = [];
  for (const peer of peers) {
    try {
      const response = await peerFetch(`${peerBaseUrl(peer)}/api/peer-sync/cos-tasks`, {
        signal: AbortSignal.timeout(10000), maxBytes: 8 * 1024 * 1024,
      }, peer);
      if (!response.ok) throw new Error('unavailable');
      const parsed = peerCosTasksSchema.safeParse(await response.json());
      if (!parsed.success || parsed.data.schemaVersion > PORTOS_SCHEMA_VERSIONS.cosTasks
        || parsed.data.tasks.length >= 50000) throw new Error('incomplete');
      tasks.push(...parsed.data.tasks);
    } catch {
      blockers.push({ source: 'peer-ownership', reason: 'participating-peer-unavailable-or-incomplete', peerId: peer.id });
    }
  }
  return { tasks, blockers };
}

async function inspectApp(app, tasks) {
  const { resolveAppForgeTarget } = await import('../lib/workTracker.js');
  const { listAppPullRequests } = await import('./appPullRequests.js');
  const { detectActionableWork, listConfiguredForgeIssues, issueNumberFromRef } = await import('./perpetualWork.js');
  const { resolveClaimWorkMetadata } = await import('./cosTaskGenerator.js');
  const { execGh } = await import('./github.js');
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const { createGithubActorTrust } = await import('./forgeActorTrust.js');
  const { execGit } = await import('../lib/execGit.js');
  const { tracker, target } = await resolveAppForgeTarget(app);
  const row = { appId: app.id, repository: target?.fullName || null, complete: false, blockers: [], pullRequests: [], issues: [], eligibleCount: 0 };
  // Other forge support remains explicit rather than silently using GitHub semantics.
  if (tracker !== 'github' || !target?.repoSpec) { row.blockers.push('unsupported-forge'); return row; }
  const account = target.fullName?.split('/')[0]?.toLowerCase() === 'atomantic' ? 'atomantic' : app.forgeAccount;
  if (account === 'atomantic' && app.forgeAccount && app.forgeAccount !== 'atomantic') { row.blockers.push('conflicting-forge-account-pin'); return row; }
  const exec = await resolveForgeExecOptions(app.repoPath, { forgeAccount: account });
  const login = (await execGh(['api', 'user', '--hostname', target.apiHost, '--jq', '.login'], undefined, exec)).trim();
  if (account === 'atomantic' && login !== 'atomantic') { row.blockers.push('required-forge-account-unavailable'); return row; }
  // Every downstream resolver receives the same explicit account pin.
  const pinned = { ...app, forgeAccount: account };
  const { metadata: preview } = await resolveClaimWorkMetadata(pinned, 'claim-issue');
  const [prs, backlog, branches, issues] = await Promise.all([
    listAppPullRequests(pinned),
    detectActionableWork('claim-issue', pinned, { issueAuthorFilter: preview.issueAuthorFilter, issueExcludeLabels: preview.issueExcludeLabels, requireComplete: true }),
    execGit(['ls-remote', '--heads', 'origin'], app.repoPath),
    listConfiguredForgeIssues('gh', pinned, { issueAuthorFilter: preview.issueAuthorFilter, issueExcludeLabels: preview.issueExcludeLabels }, exec.env),
  ]);
  if (!issues.ok || issues.truncated || issues.issues.some(issue => !Number.isInteger(issue.number) || !Array.isArray(issue.labels) || !Array.isArray(issue.assignees))) { row.blockers.push('issue-source-incomplete'); return row; }
  if (prs.transient || backlog.transient) { row.blockers.push(prs.transient ? prs.reason : backlog.reason); return row; }
  const trust = await createGithubActorTrust({ runGh: (args, timeout) => execGh(args, timeout, exec), host: target.apiHost, repoFullName: target.fullName });
  const active = tasks.filter(task => DEVELOPMENT_ACTIVE_STATUSES.has(task.status));
  for (const pr of prs.pullRequests) {
    const owner = active.find(task => sameDevelopmentWork(task, ownershipTask(app, pr)));
    let disposition = 'eligible';
    if (owner) disposition = owner.status === 'blocked' ? 'blocked' : 'actively-owned';
    else if (!pr.headSha) disposition = 'unknown';
    else if (pr.isDraft) disposition = 'draft';
    else if (!await trust.isTrusted(pr.author)) disposition = 'untrusted-excluded';
    else if (pr.labels.some(label => ['blocked', 'do-not-merge', 'hold'].includes(label.toLowerCase()))) disposition = 'blocked';
    else if (pr.checks.some(check => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', 'WAITING'].includes(check.status))) disposition = 'waiting-for-ci-review';
    // A live external claim branch is not proof of an orphan. Leave its owner
    // accountable until the existing claim/reconcile flow establishes otherwise.
    else if (issueNumberFromRef(pr.headBranch) || /^claim\//.test(pr.headBranch)) {
      const number = issueNumberFromRef(pr.headBranch);
      if (!number) disposition = 'unknown';
      else {
        const claim = await execGh(['issue', 'view', String(number), '--repo', target.repoSpec, '--json', 'state,labels'], undefined, exec)
          .then(parseGithubJson).catch(() => null);
        if (!claim || typeof claim !== 'object' || typeof claim.state !== 'string' || !Array.isArray(claim.labels)
          || (claim.state === 'OPEN' && claim.labels.some(label => label.name === 'in-progress'))) disposition = 'unknown';
      }
    }
    row.pullRequests.push({ number: pr.number, headSha: pr.headSha, fingerprint: JSON.stringify([pr.headSha, pr.reviewDecision, pr.mergeStateStatus, pr.checks, pr.labels]), disposition, taskId: owner?.id || null,
      reason: owner?.metadata?.blockedCategory || (disposition === 'unknown' ? 'external-claim-owner-unverified' : null), url: pr.url, headBranch: pr.headBranch, forkHead: pr.forkHead });
  }
  row.eligibleCount = backlog.count || 0;
  const externalClaims = new Set([
    ...branches.stdout.split('\n').map(line => line.trim().split(/\s+/).at(-1)?.replace(/^refs\/heads\//, '')),
    ...prs.pullRequests.map(pr => pr.headBranch),
  ].map(issueNumberFromRef).filter(Number.isInteger));
  const candidates = new Set((backlog.items || []).map(item => item.ref));
  row.candidateSelectionLimited = (backlog.count || 0) > candidates.size;
  for (const issue of issues.issues) {
    const item = { ref: String(issue.number) };
    const labels = issue.labels.map(label => typeof label === 'string' ? label : label.name);
    const candidate = { metadata: { app: app.id, claimFlow: true, claimTarget: item.ref } };
    const owner = active.find(task => sameDevelopmentWork(task, candidate));
    const hasBranch = externalClaims.has(issue.number);
    row.issues.push({ number: Number(item.ref), disposition: owner ? 'actively-owned' : hasBranch || labels.includes('in-progress') ? 'external-claim' : labels.includes('blocked') ? 'blocked' : candidates.has(item.ref) ? 'eligible' : 'excluded-or-unselected', taskId: owner?.id || null });
  }
  row.complete = true;
  return row;
}

async function dispatch(app, decision) {
  // Refresh grant, pause and ownership through the durable queue immediately
  // before a write. The queue's shared work-key admission is authoritative.
  const current = await loadState();
  if (!authorized(current, app.id, true) || current.paused || getDomainMode(current.config, 'cos') !== 'execute') return { reason: 'authority-changed' };
  const { resolveAutonomyBudget } = await import('./cosTaskGenerator.js');
  const budget = await resolveAutonomyBudget(current, Object.values(current.agents || {}).filter(a => a.status === 'running'));
  if (budget.cosAutonomyMode !== 'execute' || budget.autonomousActionsRemaining <= 0) return { reason: 'autonomy-budget' };
  const { getAllTasks, addTask } = await import('./cosTaskStore.js');
  const peers = await participatingPeerTasks();
  if (peers.blockers.length) return { reason: 'peer-ownership-unknown' };
  const liveTasks = [...tasksFrom(await getAllTasks()), ...peers.tasks];
  const agents = Object.values(current.agents || {}).filter(a => ['running', 'queued', 'finalizing', 'paused'].includes(a.status));
  const queued = liveTasks.filter(t => t.status === 'pending');
  const project = a => (a.metadata?.app || a.metadata?.taskApp) === app.id;
  if (agents.length + queued.length >= (current.config.maxConcurrentAgents || 1)
    || agents.filter(project).length + queued.filter(project).length >= (current.config.maxConcurrentAgentsPerProject || current.config.maxConcurrentAgents || 1)) return { reason: 'capacity-changed' };
  const fresh = await inspectApp(app, liveTasks);
  const item = decision.kind === 'pr'
    ? fresh.pullRequests.find(row => row.number === decision.number)
    : fresh.issues.find(row => row.disposition === 'eligible');
  if (!fresh.complete || item?.disposition !== 'eligible' || (decision.kind === 'pr' && item.headSha !== decision.headSha)) return { reason: 'evidence-changed' };
  if (decision.kind === 'issue') {
    if (!isImprovementEnabled(current)) return { reason: 'improvement-disabled' };
    const taskSchedule = await import('./taskSchedule.js');
    // The opt-in maintainer supplies the initiation cadence, including for a
    // manual-start perpetual drain. Reuse its continuation gate to preserve
    // enablement, parks, failure backoff and run-after dependencies without
    // clearing brakes or changing the operator's autoStart setting.
    const readiness = await taskSchedule.shouldContinuePerpetualDrain('claim-issue', app.id);
    if (!readiness.shouldRun) return { reason: readiness.reason };
    const requests = await taskSchedule.getOnDemandRequests();
    if (requests.some(request => request.appId === app.id && ['claim-issue', 'claim-work'].includes(request.taskType))) return { reason: 'claim-already-requested' };
    const candidate = { metadata: { app: app.id, claimFlow: true } };
    const owner = liveTasks.find(task => DEVELOPMENT_ACTIVE_STATUSES.has(task.status) && sameDevelopmentWork(task, candidate));
    if (owner) return { taskId: owner.id, duplicate: true };
    const { prepareManagedAppImprovementTask, recordDeferredPerpetualDispatch } = await import('./cosTaskGenerator.js');
    const prepared = await prepareManagedAppImprovementTask('claim-issue', app, current);
    if (!prepared?.task) return { reason: 'claim-schedule-no-work' };
    const finalState = await loadState();
    if (!authorized(finalState, app.id, true) || finalState.paused || !isImprovementEnabled(finalState)
      || getDomainMode(finalState.config, 'cos') !== 'execute') return { reason: 'authority-changed' };
    const task = await addTask({ ...prepared.task, metadata: { ...prepared.task.metadata,
      developmentWatchdog: true, dispatchProvenance: 'development-watchdog' } }, 'internal', { raw: true, suppressDequeue: true });
    if (!task.duplicate) {
      await recordDeferredPerpetualDispatch(prepared.pendingPerpetualDispatch, taskSchedule);
      await taskSchedule.recordExecution('task:claim-issue', app.id);
      const { cosEvents } = await import('./cosEvents.js');
      cosEvents.emit('cos:dequeue-requested');
    }
    return { taskId: task.id, duplicate: !!task.duplicate };
  }
  const { resolveAppForgeTarget } = await import('../lib/workTracker.js');
  const { target } = await resolveAppForgeTarget(app);
  const { resolveForgeExecOptions } = await import('./forgeExecOptions.js');
  const exec = await resolveForgeExecOptions(app.repoPath, { forgeAccount: target.fullName.startsWith('atomantic/') ? 'atomantic' : app.forgeAccount });
  const { execGh } = await import('./github.js');
  const { parseBlockingIssueNumbers } = await import('./blockedIssueReconcile.js');
  const body = await execGh([decision.kind === 'pr' ? 'pr' : 'issue', 'view', String(item.number), '--repo', target.repoSpec, '--json', 'body'], undefined, exec)
    .then(parseGithubJson).catch(() => null);
  if (!body || typeof body.body !== 'string') return { reason: 'forge-read-failed' };
  for (const number of parseBlockingIssueNumbers(body.body)) {
    const dependency = await execGh(['issue', 'view', String(number), '--repo', target.repoSpec, '--json', 'state'], undefined, exec)
      .then(parseGithubJson).catch(() => null);
    if (!dependency || typeof dependency.state !== 'string') return { reason: 'dependency-read-failed' };
    if (dependency.state !== 'CLOSED') return { reason: 'open-dependency' };
  }
  const finalState = await loadState();
  if (!authorized(finalState, app.id, true) || finalState.paused || getDomainMode(finalState.config, 'cos') !== 'execute') return { reason: 'authority-changed' };
  const { resolveReviewLoopOptions } = await import('./codeReview.js');
  const { normalizeReviewers, claimSafeReviewers } = await import('../lib/reviewerConfig.js');
  const { isTruthyMeta } = await import('./agentState.js');
  const options = await resolveReviewLoopOptions({}, { normalize: normalizeReviewers, isTruthyMeta });
  const reviewers = claimSafeReviewers(options.reviewers);
  const { spawnReviewLoopFollowUp } = await import('./agentWorktreeCleanup.js');
  const task = await spawnReviewLoopFollowUp({ originalAgentId: null,
    originalTask: { id: `watchdog-${randomUUID()}`, description: `Resolve PR #${item.number}`, metadata: { app: app.id } },
    prUrl: item.url, prBranch: item.headBranch, forkHead: item.forkHead, sourceWorkspace: app.repoPath,
    prCompletion: 'review-then-merge', ...options, reviewers, optionalReviewers: (options.optionalReviewers || []).filter(r => r !== 'copilot'), dispatch: 'queue' });
  return task ? { taskId: task.id, duplicate: !!task.duplicate } : { reason: 'queue-unavailable' };
}

async function scan({ dryRun = false, force = false, source = 'scheduled' } = {}) {
  const state = await loadState();
  const role = normalizePersistentMindMaintainer(state.config?.persistentMindMaintainer);
  const prior = state.developmentWatchdog?.latest;
  const policyKey = JSON.stringify([role, normalizePersistentMindCapabilities(state.config?.persistentMindCapabilities), state.paused, getDomainMode(state.config, 'cos')]);
  if (!dryRun && !force && state.developmentWatchdog?.policyKey === policyKey && prior && Date.now() - Date.parse(prior.checkedAt) < role.intervalMinutes * 60000) return prior;
  const receipt = { schemaVersion: 1, id: randomUUID(), checkedAt: new Date().toISOString(), source, dryRun,
    complete: true, availableSlots: 0, blockers: [], apps: [], decisions: [], recovery: [] };
  if (!role.enabled) receipt.blockers.push('maintainer-disabled');
  else if (!role.appIds.some(id => authorized(state, id))) {
    receipt.complete = false;
    receipt.blockers.push('no-readable-maintainer-scope');
    receipt.apps = role.appIds.map(appId => ({ appId, complete: false, blockers: ['app-unavailable-or-not-granted'], pullRequests: [], issues: [] }));
  } else {
    const { getActiveApps } = await import('./apps.js');
    const { getAllTasks } = await import('./cosTaskStore.js');
    const tasks = tasksFrom(await getAllTasks());
    const peers = await participatingPeerTasks();
    const allTasks = [...tasks, ...peers.tasks];
    const agents = Object.values(state.agents || {});
    // Include finalization and queued ownership, not only live subprocesses.
    const activeAgents = agents.filter(agent => ['running', 'queued', 'finalizing', 'paused'].includes(agent.status));
    for (const agent of activeAgents) {
      const task = tasks.find(t => t.id === agent.taskId);
      if (task) allTasks.push({ ...task, status: 'running' });
      else if (agent.metadata) allTasks.push({ ...agent, status: 'running' });
    }
    const queued = tasks.filter(task => ['pending', 'in_progress'].includes(task.status));
    receipt.availableSlots = Math.max(0, (state.config.maxConcurrentAgents || 1) - activeAgents.length - queued.filter(t => t.status === 'pending').length);
    receipt.recovery = tasks.filter(task => authorized(state, task.metadata?.app || task.metadata?.taskApp) && (task.metadata?.sourceAgentId || task.metadata?.isInvestigation || task.metadata?.diagnostics))
      .slice(-30).map(task => ({ taskId: task.id, status: task.status, sourceAgentId: task.metadata.sourceAgentId || null,
        sourceTaskId: task.metadata.sourceTaskId || null, kind: task.metadata.reviewLoopFollowUp ? 'review-follow-up' : task.metadata.isInvestigation ? 'investigation' : 'recovery',
        blockedReason: task.metadata.blockedCategory || null }));
    receipt.blockers.push(...peers.blockers);
    const apps = await getActiveApps();
    for (const id of role.appIds) {
      const app = apps.find(item => item.id === id);
      if (!app || !authorized(state, id)) { receipt.apps.push({ appId: id, complete: false, blockers: ['app-unavailable-or-not-granted'], pullRequests: [], issues: [] }); continue; }
      let row;
      try { row = await inspectApp(app, allTasks); }
      catch { row = { appId: id, complete: false, blockers: ['source-unavailable'], pullRequests: [], issues: [] }; }
      for (const pr of row.pullRequests) {
        const previous = state.developmentWatchdog?.dispatches?.[`${id}:pr:${pr.number}`];
        if (pr.disposition === 'eligible' && previous?.fingerprint === pr.fingerprint) {
          pr.disposition = 'blocked'; pr.reason = 'unchanged-after-dispatch'; pr.taskId = previous.taskId;
        }
      }
      receipt.apps.push(row);
      if (!row.complete || peers.blockers.length) continue;
      const projectCount = activeAgents.filter(a => (a.metadata?.app || a.metadata?.taskApp) === id).length + queued.filter(t => t.metadata?.app === id && t.status === 'pending').length;
      let capacity = Math.min(receipt.availableSlots, Math.max(0, (state.config.maxConcurrentAgentsPerProject || state.config.maxConcurrentAgents || 1) - projectCount));
      // Issue selection belongs to the scheduled claim coordinator: one
      // unpinned batch per repository, with its configured swarm/model routing.
      const issueBatch = row.issues.some(issue => issue.disposition === 'eligible')
        ? [{ kind: 'issue', number: null, disposition: 'eligible' }] : [];
      for (const item of [...row.pullRequests.map(p => ({ ...p, kind: 'pr' })), ...issueBatch]) {
        if (item.disposition !== 'eligible') continue;
        const decision = { appId: id, kind: item.kind, number: item.number, headSha: item.headSha || null, fingerprint: item.fingerprint || null,
          outcome: capacity <= 0 ? 'capacity-full' : dryRun ? 'would-queue' : 'pending' };
        if (capacity > 0 && !dryRun) {
          let outcome;
          try { outcome = await dispatch(app, item); } catch (err) { console.error(`❌ Development watchdog dispatch failed: ${err.message}`); outcome = { reason: 'dispatch-source-unavailable' }; }
          Object.assign(decision, outcome, { outcome: outcome.taskId ? outcome.duplicate ? 'already-owned' : 'queued' : 'deferred' });
        }
        receipt.decisions.push(decision);
        if (decision.taskId && item.kind === 'pr') {
          const record = row.pullRequests.find(record => record.number === item.number);
          record.disposition = 'queued-for-resolution'; record.taskId = decision.taskId;
        }
        if (capacity > 0 && (dryRun || decision.outcome === 'queued')) { capacity--; receipt.availableSlots--; }
      }
    }
    receipt.complete = !peers.blockers.length && receipt.apps.every(app => app.complete);
  }
  const firstSeen = new Map((prior?.apps || []).flatMap(app => (app.pullRequests || []).map(pr => [`${app.appId}:${pr.number}`, pr.firstObservedAt || prior.checkedAt])));
  for (const app of receipt.apps) for (const pr of app.pullRequests) pr.firstObservedAt = firstSeen.get(`${app.appId}:${pr.number}`) || receipt.checkedAt;
  receipt.counts = {
    dispatched: receipt.decisions.filter(d => d.outcome === 'queued').length,
    ownedSkips: receipt.apps.reduce((n, app) => n + [...app.pullRequests, ...app.issues].filter(item => ['actively-owned', 'external-claim'].includes(item.disposition)).length, 0),
    duplicateAdmissionsPrevented: receipt.decisions.filter(d => d.duplicate).length,
    deferred: receipt.decisions.filter(d => ['deferred', 'capacity-full'].includes(d.outcome)).length,
    deterministicActions: 0,
    modelCalls: 0,
  };
  if (!dryRun && (role.enabled || prior)) await withStateLock(async () => {
    const current = await loadState();
    const dispatches = { ...current.developmentWatchdog?.dispatches };
    for (const decision of receipt.decisions) if (decision.kind === 'pr' && decision.outcome === 'queued') {
      dispatches[`${decision.appId}:pr:${decision.number}`] = { fingerprint: decision.fingerprint, taskId: decision.taskId };
    }
    // Retain only still-open scoped work; an incomplete scan cannot erase the
    // previous hold. Bound the ledger independently from the receipt history.
    for (const app of receipt.apps) if (app.complete) {
      for (const key of Object.keys(dispatches)) if (key.startsWith(`${app.appId}:pr:`)
        && !app.pullRequests.some(pr => key === `${app.appId}:pr:${pr.number}`)) delete dispatches[key];
    }
    current.developmentWatchdog = { policyKey, dispatches: Object.fromEntries(Object.entries(dispatches).slice(-1000)), latest: receipt, history: [...(current.developmentWatchdog?.history || []), receipt].slice(-24) };
    await saveState(current);
  });
  return receipt;
}

/** All invocation paths share one scan; queue admission survives restart. Dry runs never persist. */
export function runDevelopmentWatchdog(options = {}) {
  const next = scanTail.catch(() => undefined).then(() => scan(options));
  scanTail = next;
  return next;
}
