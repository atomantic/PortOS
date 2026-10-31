/**
 * Projects durable release publication and synchronization milestones onto task
 * and agent records for detail and status views.
 */
import { readReleaseSynchronizationOutbox } from './releaseSynchronizationStore.js';
import { effectiveReleaseSynchronization, releaseSynchronizationReset } from '../lib/releaseSynchronization.js';

function buildReleaseSynchronizationPayload(entry) {
  if (!entry) return null;
  const synchronization = effectiveReleaseSynchronization(entry);
  const reset = releaseSynchronizationReset(entry);
  const syncPr = entry.obligations?.synchronizationPr?.evidence?.prUrl
    || entry.obligations?.localReview?.evidence?.prUrl
    || null;
  const syncHead = entry.obligations?.synchronizationPr?.evidence?.headSha
    || entry.obligations?.localReview?.evidence?.receipt?.completedHead
    || (entry.obligations?.localReview?.evidence?.receipt?.version === 1 && entry.obligations.localReview.evidence.receipt.reviewedHead)
    || entry.obligations?.requiredCi?.evidence?.headSha
    || null;

  return {
    version: 1,
    identity: entry.identity,
    status: synchronization?.status || 'pending',
    prUrl: syncPr,
    headSha: syncHead,
    blocker: synchronization?.blocker || null,
    ...(reset && { operatorReset: reset, nextAction: 'The operator retired this checkpoint; its historical synchronization remains unverified.' }),
    ...(synchronization?.status === 'blocked' && synchronization.blocker === 'publisher-candidate-checkout-unverified' && !reset && {
      nextAction: 'No server-captured seed identifies the publisher checkout, so this synchronization cannot be verified. Confirm the release reached development, then retire this checkpoint with the operator reset.',
    }),
    verifiedAt: synchronization?.verifiedAt || null,
    checkedAt: synchronization?.checkedAt || null,
    retryAt: synchronization?.retryAt || null,
    tag: entry.publication?.tag,
    releaseUrl: entry.publication?.releaseUrl,
    publishedAt: entry.publication?.publishedAt,
    publisherAgentId: entry.owner?.agentId,
    publisherTaskId: entry.owner?.taskId,
    taskId: entry.task?.id,
  };
}

function findMatchingOutboxEntryForTask(task, outbox) {
  if (!task || !outbox?.publications) return null;
  const publications = Object.values(outbox.publications);
  if (!publications.length) return null;

  const identity = task.metadata?.releasePublication?.identity
    || task.metadata?.releaseSynchronization?.identity;
  if (identity && outbox.publications[identity]) {
    return outbox.publications[identity];
  }
  const taskId = task.id;
  if (!taskId) return null;

  return publications.find(e => e.task?.id === taskId || e.owner?.taskId === taskId) || null;
}

function findMatchingOutboxEntryForAgent(agent, outbox) {
  if (!agent || !outbox?.publications) return null;
  const publications = Object.values(outbox.publications);
  if (!publications.length) return null;

  const identity = agent.metadata?.releasePublication?.identity
    || agent.metadata?.releaseSynchronization?.identity;
  if (identity && outbox.publications[identity]) {
    return outbox.publications[identity];
  }

  // Publisher agent matches specifically by recorded owner agentId
  const agentId = agent.id || agent.agentId;
  const matchPublisher = publications.find(e => e.owner?.agentId === agentId);
  if (matchPublisher) return matchPublisher;

  // Continuation agent matches specifically by the continuation task ID
  if (agent.taskId) {
    const matchContinuation = publications.find(e => e.task?.id === agent.taskId);
    if (matchContinuation) return matchContinuation;
  }

  return null;
}

export function projectTaskReleaseMilestones(task, entryOrOutbox) {
  if (!task) return task;
  const entry = entryOrOutbox?.version === 1 && entryOrOutbox.identity
    ? entryOrOutbox
    : findMatchingOutboxEntryForTask(task, entryOrOutbox);
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
    : findMatchingOutboxEntryForAgent(agent, entryOrOutbox);
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

function projectAgentListReleaseMilestones(agents, outbox) {
  if (!Array.isArray(agents) || !outbox?.publications || Object.keys(outbox.publications).length === 0) return agents;
  return agents.map(agent => projectAgentReleaseMilestones(agent, outbox));
}

export async function getProjectedAgent(agent) {
  if (!agent) return agent;
  const outbox = await readReleaseSynchronizationOutbox().catch(() => null);
  return projectAgentReleaseMilestones(agent, outbox);
}

export async function getProjectedAgentList(agents) {
  if (!Array.isArray(agents) || agents.length === 0) return agents;
  const outbox = await readReleaseSynchronizationOutbox().catch(() => null);
  return projectAgentListReleaseMilestones(agents, outbox);
}

export function projectTaskSourceReleaseMilestones(source, outbox) {
  if (!source || !outbox?.publications || Object.keys(outbox.publications).length === 0) return source;
  const projectList = list => Array.isArray(list) ? list.map(t => projectTaskReleaseMilestones(t, outbox)) : list;
  if (Array.isArray(source)) return source.map(t => projectTaskReleaseMilestones(t, outbox));
  return {
    ...source,
    ...(source.tasks ? { tasks: projectList(source.tasks) } : {}),
    ...(source.completed ? { completed: projectList(source.completed) } : {}),
    ...(source.items ? { items: projectList(source.items) } : {}),
    ...(source.selectedTask ? { selectedTask: projectTaskReleaseMilestones(source.selectedTask, outbox) } : {}),
  };
}
