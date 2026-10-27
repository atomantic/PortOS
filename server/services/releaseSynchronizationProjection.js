/**
 * Projects durable release publication and synchronization milestones onto task
 * and agent records for detail and status views.
 */
import { readReleaseSynchronizationOutbox } from './releaseSynchronizationStore.js';

export function buildReleaseSynchronizationPayload(entry) {
  if (!entry) return null;
  const syncPr = entry.obligations?.synchronizationPr?.evidence?.prUrl
    || entry.obligations?.localReview?.evidence?.prUrl
    || null;
  const syncHead = entry.obligations?.synchronizationPr?.evidence?.headSha
    || entry.obligations?.localReview?.evidence?.receipt?.reviewedHead
    || entry.obligations?.requiredCi?.evidence?.headSha
    || null;

  return {
    version: 1,
    identity: entry.identity,
    status: entry.synchronization?.status || 'pending',
    prUrl: syncPr,
    headSha: syncHead,
    blocker: entry.synchronization?.blocker || null,
    verifiedAt: entry.synchronization?.verifiedAt || null,
    checkedAt: entry.synchronization?.checkedAt || null,
    retryAt: entry.synchronization?.retryAt || null,
    tag: entry.publication?.tag,
    releaseUrl: entry.publication?.releaseUrl,
    publishedAt: entry.publication?.publishedAt,
    publisherAgentId: entry.owner?.agentId,
    publisherTaskId: entry.owner?.taskId,
    taskId: entry.task?.id,
  };
}

export function findMatchingOutboxEntry(item, outbox) {
  if (!item || !outbox?.publications) return null;
  const publications = Object.values(outbox.publications);
  if (!publications.length) return null;

  const identity = item.metadata?.releasePublication?.identity
    || item.metadata?.releaseSynchronization?.identity;
  if (identity && outbox.publications[identity]) {
    return outbox.publications[identity];
  }
  const taskId = item.taskId || item.id;
  const matchTask = publications.find(e => e.task?.id === taskId || e.owner?.taskId === taskId);
  if (matchTask) return matchTask;

  const agentId = item.id || item.agentId;
  const matchAgent = publications.find(e => e.owner?.agentId === agentId);
  if (matchAgent) return matchAgent;

  return null;
}

export function projectTaskReleaseMilestones(task, entryOrOutbox) {
  if (!task) return task;
  const entry = entryOrOutbox?.version === 1 && entryOrOutbox.identity
    ? entryOrOutbox
    : findMatchingOutboxEntry(task, entryOrOutbox);
  if (!entry) return task;

  const metadata = { ...task.metadata };
  if (entry.publication) {
    metadata.releasePublication = entry.publication;
  }
  metadata.releaseSynchronization = {
    ...(metadata.releaseSynchronization || {}),
    ...buildReleaseSynchronizationPayload(entry),
  };
  return { ...task, metadata };
}

export function projectAgentReleaseMilestones(agent, entryOrOutbox) {
  if (!agent) return agent;
  const entry = entryOrOutbox?.version === 1 && entryOrOutbox.identity
    ? entryOrOutbox
    : findMatchingOutboxEntry(agent, entryOrOutbox);
  if (!entry) return agent;

  const metadata = { ...agent.metadata };
  if (entry.publication) {
    metadata.releasePublication = entry.publication;
  }
  metadata.releaseSynchronization = {
    ...(metadata.releaseSynchronization || {}),
    ...buildReleaseSynchronizationPayload(entry),
  };
  return { ...agent, metadata };
}

export async function getProjectedTask(task) {
  if (!task) return task;
  const outbox = await readReleaseSynchronizationOutbox().catch(() => null);
  return projectTaskReleaseMilestones(task, outbox);
}

export async function getProjectedAgent(agent) {
  if (!agent) return agent;
  const outbox = await readReleaseSynchronizationOutbox().catch(() => null);
  return projectAgentReleaseMilestones(agent, outbox);
}

export function projectTaskSourceReleaseMilestones(source, outbox) {
  if (!source || !outbox?.publications || Object.keys(outbox.publications).length === 0) return source;
  const projectList = list => Array.isArray(list) ? list.map(t => projectTaskReleaseMilestones(t, outbox)) : list;
  return {
    ...source,
    tasks: projectList(source.tasks),
    completed: projectList(source.completed),
    ...(source.selectedTask ? { selectedTask: projectTaskReleaseMilestones(source.selectedTask, outbox) } : {}),
  };
}
