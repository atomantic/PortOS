// Route builders for the CoS cross-links between an agent, its run, the run's
// event ledger and its task. Every target already has a deep link; these keep
// the spelling (and the `sys-` task source rule from AgentsTab) in one place.
export const agentPath = (agentId) => `/cos/agents/${encodeURIComponent(agentId)}`;
export const runPath = (runId) => `/cos/runs?${new URLSearchParams({ run: runId })}`;
export const runEventsPath = (runId) => `/cos/runs/events?${new URLSearchParams({ run: runId })}`;
export const taskPath = (taskId) => {
  const params = new URLSearchParams({ task: taskId });
  if (String(taskId).startsWith('sys-')) params.set('source', 'internal');
  return `/cos/tasks?${params}`;
};
