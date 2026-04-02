import { request } from './apiCore.js';

// Commands
export const executeCommand = (command, workspacePath) => request('/commands/execute', {
  method: 'POST',
  body: JSON.stringify({ command, workspacePath })
});
export const stopCommand = (id) => request(`/commands/${id}/stop`, { method: 'POST' });
export const getAllowedCommands = () => request('/commands/allowed');
export const getProcessesList = () => request('/commands/processes');
