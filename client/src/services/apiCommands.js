import { request } from './apiCore.js';

// Commands
export const executeCommand = (command, workspacePath, options = {}) => request('/commands/execute', {
  method: 'POST',
  body: JSON.stringify({ command, workspacePath }),
  ...options
});
export const stopCommand = (id) => request(`/commands/${id}/stop`, { method: 'POST' });
export const getAllowedCommands = () => request('/commands/allowed');
export const getProcessesList = (options) => request('/commands/processes', options);
