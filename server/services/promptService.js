/**
 * Compatibility shim for PortOS services that import from promptService.js
 * Re-exports toolkit prompts service functions
 */

// This will be initialized by server/index.js and set via setAIToolkit()
let aiToolkitInstance = null;

export function setAIToolkit(toolkit) {
  aiToolkitInstance = toolkit;
}

export async function loadPrompts() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.init();
}

export function getStages() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.getStages();
}

export function getStage(stageName) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.getStage(stageName);
}

export async function getStageTemplate(stageName) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.getStageTemplate(stageName);
}

export async function updateStageTemplate(stageName, content) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.updateStageTemplate(stageName, content);
}

export async function updateStageConfig(stageName, config) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.updateStageConfig(stageName, config);
}

export function getVariables() {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.getVariables();
}

export function getVariable(key) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.getVariable(key);
}

export async function updateVariable(key, data) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.updateVariable(key, data);
}

export async function createVariable(key, data) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.createVariable(key, data);
}

export async function deleteVariable(key) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.deleteVariable(key);
}

export async function buildPrompt(stageName, data) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.buildPrompt(stageName, data);
}

export async function previewPrompt(stageName, testData) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  return aiToolkitInstance.services.prompts.previewPrompt(stageName, testData);
}
