import { request } from './apiCore.js';

// Commands
export const executeCommand = (command, workspacePath, options = {}) => request('/commands/execute', {
  method: 'POST',
  body: JSON.stringify({ command, workspacePath }),
  ...options
});
export const stopCommand = (id) => request(`/commands/${id}/stop`, { method: 'POST' });
export const getAllowedCommands = () => request('/commands/allowed');
export const getProcessesList = ({ appId, ...options } = {}) => request(
  `/commands/processes${appId ? `?appId=${encodeURIComponent(appId)}` : ''}`, options
);

export const applyProcessAction = (name, action, appId) => request(`/commands/processes/${encodeURIComponent(name)}/action`, {
  method: 'POST', body: JSON.stringify({ action, appId })
});
