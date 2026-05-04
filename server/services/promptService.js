/**
 * Compatibility shim for PortOS services that import from promptService.js
 * Re-exports toolkit prompts service functions, but routes `buildPrompt`
 * (and `previewPrompt`) through PortOS's enhanced template engine so
 * templates can use Mustache-style dot notation against nested objects
 * (e.g. `{{project.name}}`, `{{#frames}}{{label}}{{/frames}}`).
 *
 * The toolkit's stored data (stage-config.json, variables.json, .md files)
 * is unchanged — we just swap out the templating step. The toolkit-stored
 * `templateEngine === 'mustache'` semantics still hold; we extend them.
 */

import { applyTemplate } from '../lib/promptTemplate.js';

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

export async function buildPrompt(stageName, data = {}) {
  if (!aiToolkitInstance) throw new Error('AI Toolkit not initialized');
  const prompts = aiToolkitInstance.services.prompts;
  const stage = prompts.getStage(stageName);
  if (!stage) throw new Error(`Stage ${stageName} not found`);
  const template = await prompts.getStageTemplate(stageName);
  if (!template) throw new Error(`Template for ${stageName} not found`);
  // Auto-merge stage-declared shared variables (variables.json) into the
  // render context so templates can reference `{{schemaSnippet}}` etc.
  // without callers having to know which named variables their stage uses.
  const allVars = { ...data };
  const variables = prompts.getVariables() || {};
  for (const varName of stage.variables || []) {
    const v = variables[varName];
    if (v && allVars[varName] === undefined) allVars[varName] = v.content;
  }
  return applyTemplate(template, allVars);
}

export async function previewPrompt(stageName, testData = {}) {
  // Delegate to the local buildPrompt so the preview pane in the Prompts
  // Manager renders with the same engine that production prompts use.
  return buildPrompt(stageName, testData);
}
