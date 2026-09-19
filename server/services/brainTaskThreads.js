/** Bridge CoS tasks into the Brain bullet journal without creating noise. */

import * as brainStorage from './brainStorage.js';

const TASK_REF_KIND = 'cos.task';

export async function ensureTaskThread({ taskId, title, nextAction, notes, priority = 'normal' }) {
  if (!taskId || !title) return null;
  const threads = await brainStorage.getThreads();
  const existing = threads.find(thread => thread.status !== 'archived'
    && thread.refs?.some(ref => ref?.kind === TASK_REF_KIND && ref?.id === taskId));
  if (existing) return existing;
  return brainStorage.createThread({
    title,
    status: 'open',
    priority,
    nextAction: nextAction || 'Review the task in CoS',
    notes: notes || '',
    refs: [{ kind: TASK_REF_KIND, id: taskId, label: title }],
    source: 'cos',
  });
}
