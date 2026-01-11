/**
 * Compatibility shim for PortOS services that import from runner.js
 * Re-exports toolkit runner service functions
 */

// This will be initialized by server/index.js and set via setAIToolkit()
let aiToolkitInstance = null;

export function setAIToolkit(toolkit) {
  aiToolkitInstance = toolkit;
}

export async function createRun(options) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.createRun(options);
}

export async function executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete, timeout) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.executeCliRun(runId, provider, prompt, workspacePath, onData, onComplete, timeout);
}

export async function executeApiRun(runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.executeApiRun(runId, provider, model, prompt, workspacePath, screenshots, onData, onComplete);
}

export async function stopRun(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.stopRun(runId);
}

export async function getRun(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.getRun(runId);
}

export async function getRunOutput(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.getRunOutput(runId);
}

export async function getRunPrompt(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.getRunPrompt(runId);
}

export async function listRuns(limit, offset, source) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.listRuns(limit, offset, source);
}

export async function deleteRun(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.deleteRun(runId);
}

export async function deleteFailedRuns() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.deleteFailedRuns();
}

export async function isRunActive(runId) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.runner.isRunActive(runId);
}
