import { request } from './apiCore.js';

// System (PM2) logs
// List every PM2 process so a log viewer can offer a process picker.
export const getLogProcesses = () => request('/logs/processes');

// Fetch the recent tail of a PM2 process's system log. Returns
// `{ processName, lines, logs }` where `logs` is the raw multi-line text.
export const getProcessLogs = (processName, lines = 200) =>
  request(`/logs/${encodeURIComponent(processName)}?lines=${lines}`);
