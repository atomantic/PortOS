import { cosEvents } from './cosEvents.js';

// Persisted preflight steps survive a restart; only this process-local marker
// proves that preparation is actually running now.
const active = new Map();
export const isPreflightActive = id => active.has(id);

const publish = (id, preflightActive) => cosEvents.emit('tasks:changed', {
  activityOnly: 'preflight', task: { id, preflightActive },
});

export function beginPreflightActivity(id) {
  if (!id) return () => {};
  active.set(id, (active.get(id) || 0) + 1);
  publish(id, true);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (active.get(id) || 1) - 1;
    if (remaining) active.set(id, remaining);
    else active.delete(id);
    publish(id, remaining > 0);
  };
}

export function projectPreflightTask(task) {
  return task?.metadata?.preflight?.requestId ? { ...task, preflightActive: isPreflightActive(task.id) } : task;
}

export function projectPreflightSource(source) {
  if (!Array.isArray(source?.tasks)) return source;
  const grouped = source.grouped && Object.fromEntries(Object.entries(source.grouped)
    .map(([key, rows]) => [key, rows.map(projectPreflightTask)]));
  return { ...source, tasks: source.tasks.map(projectPreflightTask), ...(grouped && { grouped }) };
}
