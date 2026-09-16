/**
 * "Is this install doing anything right now?" — the single definition of system
 * idleness, derived from the `/api/system/processing` snapshot.
 *
 * Two very different consumers need the SAME answer, which is why this is a
 * pure leaf rather than a field the widget computes for itself:
 *
 *   - the dashboard's Live activity widget, which renders what is running; and
 *   - the unattended auto-updater (`services/autoUpdateScheduler.js`), which
 *     restarts the whole install and therefore may only fire when nothing is
 *     in flight.
 *
 * If the two ever disagreed, the widget would read "idle" while the updater
 * refused (or, far worse, the updater would restart PortOS out from under work
 * the widget was still drawing). So the widget renders `blockers` verbatim and
 * the updater refuses on the same list.
 *
 * QUEUED WORK IS ACTIVE. A render sitting at position 3 has a user waiting on
 * it; restarting into a new source revision mid-queue is the same disruption as
 * killing the running one.
 *
 * Every label here is GENERIC prose — a count and a noun. Nothing in this
 * module may echo a prompt, a record name, an app name, or any other content
 * out of the snapshot: the blocker list is rendered in the UI and written into
 * the auto-update runtime record on disk.
 */

import { pluralize } from './textUtils.js';

/** Media kinds the queue runs, mapped to the noun a blocker line uses. */
const MEDIA_NOUNS = {
  image: 'image render',
  video: 'video render',
  audio: 'audio render',
  training: 'training run',
};

const mediaNoun = (kind) => MEDIA_NOUNS[kind] || 'media job';

/**
 * Count jobs by kind for one queue status, newest-agnostic (order-independent).
 * @returns {Map<string, number>}
 */
function countByKind(jobs, status) {
  const counts = new Map();
  for (const job of jobs) {
    if (job?.status !== status) continue;
    const kind = typeof job.kind === 'string' ? job.kind : 'media';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return counts;
}

/**
 * Reduce a processing snapshot to an idle verdict plus the list of things
 * keeping it busy.
 *
 * @param {object} snapshot - a `getActiveProcessing()` result. Missing slices
 *   are read as "nothing there" rather than throwing, so a partially-degraded
 *   snapshot still yields a usable verdict — EXCEPT for the deliberate
 *   `trusted: false` signals below, which are blockers in their own right.
 * @returns {{idle: boolean, activeCount: number, queuedCount: number, blockers: Array<{kind: string, label: string, count: number}>}}
 */
export function summarizeSystemActivity(snapshot) {
  const blockers = [];
  const add = (kind, label, count) => blockers.push({ kind, label, count });

  const jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
  for (const [kind, count] of countByKind(jobs, 'running')) {
    add(`media-running:${kind}`, `${pluralize(count, mediaNoun(kind))} running`, count);
  }
  for (const [kind, count] of countByKind(jobs, 'queued')) {
    add(`media-queued:${kind}`, `${pluralize(count, mediaNoun(kind))} queued`, count);
  }

  // An explicit `null` means the build list could not be read — not that
  // nothing is building. Same contract as the agent and mind slices: the value
  // that unlocks a restart may never be manufactured from a failed read. An
  // ABSENT key stays "nothing there", per this function's partial-snapshot rule.
  if (snapshot?.extras?.imageTo3d === null) add('image-to-3d-unreadable', 'Image-to-3D build state unreadable', 1);
  const imageTo3d = Array.isArray(snapshot?.extras?.imageTo3d) ? snapshot.extras.imageTo3d.length : 0;
  if (imageTo3d > 0) add('image-to-3d', `${pluralize(imageTo3d, 'image-to-3D build')} running`, imageTo3d);

  // Same contract as the mind slice below: an unreadable agent state is not an
  // empty one, and zero agents is exactly the value that unlocks a restart.
  const agentState = snapshot?.agents;
  if (agentState?.trusted === false) add('agents-unreadable', 'CoS agent state unreadable', 1);
  const activeAgents = Number(agentState?.active) || 0;
  if (activeAgents > 0) add('agents-running', `${pluralize(activeAgents, 'CoS agent')} running`, activeAgents);
  const queuedAgents = Number(agentState?.queued) || 0;
  if (queuedAgents > 0) add('agents-queued', `${pluralize(queuedAgents, 'CoS task')} queued`, queuedAgents);

  const mind = snapshot?.mind;
  // An unreadable Persistent Mind state is NOT an idle one: the update path
  // refuses on the same condition (`persistentMindStateUntrustedError`), so
  // reading it as "nothing queued" here would let the updater march up to a
  // refusal it could have seen coming.
  if (mind && mind.trusted === false) {
    add('mind-unreadable', 'Persistent Mind state unreadable', 1);
  } else if (mind) {
    if (mind.thinking) add('mind-thinking', 'Persistent Mind is thinking', 1);
    const queuedMessages = Number(mind.queued) || 0;
    if (queuedMessages > 0) add('mind-queued', `${pluralize(queuedMessages, 'Persistent Mind message')} queued`, queuedMessages);
  }

  const appOperations = Array.isArray(snapshot?.appOperations) ? snapshot.appOperations : [];
  if (appOperations.length > 0) {
    add('app-operations', `${pluralize(appOperations.length, 'app operation')} running`, appOperations.length);
  }

  if (snapshot?.update?.inProgress) add('update-in-progress', 'An update is already running', 1);

  const activeCount = jobs.filter((job) => job?.status === 'running').length
    + imageTo3d + activeAgents + (mind?.thinking ? 1 : 0) + appOperations.length;
  const queuedCount = jobs.filter((job) => job?.status === 'queued').length
    + queuedAgents + (Number(mind?.queued) || 0);

  return { idle: blockers.length === 0, activeCount, queuedCount, blockers };
}

/** One-line human summary of a blocker list, for a log line or a status row. */
export function describeActivityBlockers(blockers) {
  if (!Array.isArray(blockers) || blockers.length === 0) return 'system idle';
  return blockers.map((blocker) => blocker.label).join(', ');
}
