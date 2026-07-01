import { request } from './apiCore.js';

// Fetch the recent tail of a PM2 process's system log. Returns
// `{ processName, lines, logs }` where `logs` is the raw multi-line text.
// (The PM2 process *list* comes from the existing `getProcessesList` wrapper.)
export const getProcessLogs = (processName, lines = 200) =>
  request(`/logs/${encodeURIComponent(processName)}?lines=${lines}`);
