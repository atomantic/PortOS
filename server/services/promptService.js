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

import { join } from 'path';
import { applyTemplate } from '../lib/promptTemplate.js';
import { expandPartials } from '../lib/promptPartials.js';
import { PATHS } from '../lib/fileUtils.js';
import { setAIToolkitInstance, requireToolkit } from '../lib/aiToolkitState.js';

// `server/index.js` imports `setAIToolkit` from here — keep the named export
// stable while the underlying singleton lives in `lib/aiToolkitState.js` so
// providers / runner / promptService all observe the same instance.
export const setAIToolkit = setAIToolkitInstance;

export async function loadPrompts() {
  return requireToolkit().services.prompts.init();
}

export function getStages() {
  return requireToolkit().services.prompts.getStages();
}

export function getStage(stageName) {
  return requireToolkit().services.prompts.getStage(stageName);
}

export async function getStageTemplate(stageName) {
  return requireToolkit().services.prompts.getStageTemplate(stageName);
}

export async function updateStageTemplate(stageName, content) {
  return requireToolkit().services.prompts.updateStageTemplate(stageName, content);
}

export async function updateStageConfig(stageName, config) {
  return requireToolkit().services.prompts.updateStageConfig(stageName, config);
}

export function getVariables() {
  return requireToolkit().services.prompts.getVariables();
}

export function getVariable(key) {
  return requireToolkit().services.prompts.getVariable(key);
}

export async function updateVariable(key, data) {
  return requireToolkit().services.prompts.updateVariable(key, data);
}

export async function createVariable(key, data) {
  return requireToolkit().services.prompts.createVariable(key, data);
}

export async function deleteVariable(key) {
  return requireToolkit().services.prompts.deleteVariable(key);
}

export async function buildPrompt(stageName, data = {}) {
  const prompts = requireToolkit().services.prompts;
  const stage = prompts.getStage(stageName);
  if (!stage) throw new Error(`Stage ${stageName} not found`);
  const rawTemplate = await prompts.getStageTemplate(stageName);
  if (!rawTemplate) throw new Error(`Template for ${stageName} not found`);
  // Expand `{{> partial-name }}` references against data/prompts/_partials/
  // BEFORE the variable+section pass so a partial can carry its own
  // {{variables}} that resolve against the same render context as the
  // including template. Cheap when no partials are referenced — the expander
  // short-circuits on a missing `{{>` sentinel.
  const template = await expandPartials(rawTemplate, {
    partialsDir: join(PATHS.data, 'prompts', '_partials'),
  });
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
