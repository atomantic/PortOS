import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '../../data/prompts');

let stageConfig = null;
let variables = null;

/**
 * Load or reload prompts configuration
 */
export async function loadPrompts() {
  const configPath = join(PROMPTS_DIR, 'stage-config.json');
  const varsPath = join(PROMPTS_DIR, 'variables.json');

  if (existsSync(configPath)) {
    stageConfig = JSON.parse(await readFile(configPath, 'utf-8'));
  } else {
    stageConfig = { stages: {} };
  }

  if (existsSync(varsPath)) {
    variables = JSON.parse(await readFile(varsPath, 'utf-8'));
  } else {
    variables = { variables: {} };
  }

  console.log(`📝 Loaded ${Object.keys(stageConfig.stages || {}).length} prompt stages`);
}

/**
 * Get all stages with their metadata
 */
export function getStages() {
  return stageConfig?.stages || {};
}

/**
 * Get stage configuration
 */
export function getStage(stageName) {
  return stageConfig?.stages?.[stageName] || null;
}

/**
 * Get stage template content
 */
export async function getStageTemplate(stageName) {
  const templatePath = join(PROMPTS_DIR, 'stages', `${stageName}.md`);
  if (!existsSync(templatePath)) return null;
  return readFile(templatePath, 'utf-8');
}

/**
 * Update stage template
 */
export async function updateStageTemplate(stageName, content) {
  const stagesDir = join(PROMPTS_DIR, 'stages');
  if (!existsSync(stagesDir)) await mkdir(stagesDir, { recursive: true });
  await writeFile(join(stagesDir, `${stageName}.md`), content);
}

/**
 * Update stage configuration
 */
export async function updateStageConfig(stageName, config) {
  if (!stageConfig) await loadPrompts();
  stageConfig.stages[stageName] = { ...stageConfig.stages[stageName], ...config };
  await writeFile(join(PROMPTS_DIR, 'stage-config.json'), JSON.stringify(stageConfig, null, 2));
}

/**
 * Get all variables
 */
export function getVariables() {
  return variables?.variables || {};
}

/**
 * Get a single variable
 */
export function getVariable(key) {
  return variables?.variables?.[key] || null;
}

/**
 * Update a variable
 */
export async function updateVariable(key, data) {
  if (!variables) await loadPrompts();
  variables.variables[key] = { ...variables.variables[key], ...data };
  await writeFile(join(PROMPTS_DIR, 'variables.json'), JSON.stringify(variables, null, 2));
}

/**
 * Create a new variable
 */
export async function createVariable(key, data) {
  if (!variables) await loadPrompts();
  if (variables.variables[key]) {
    throw new Error(`Variable ${key} already exists`);
  }
  variables.variables[key] = data;
  await writeFile(join(PROMPTS_DIR, 'variables.json'), JSON.stringify(variables, null, 2));
}

/**
 * Delete a variable
 */
export async function deleteVariable(key) {
  if (!variables) await loadPrompts();
  delete variables.variables[key];
  await writeFile(join(PROMPTS_DIR, 'variables.json'), JSON.stringify(variables, null, 2));
}

/**
 * Build a prompt from template and variables
 */
export async function buildPrompt(stageName, data = {}) {
  const stage = getStage(stageName);
  if (!stage) throw new Error(`Stage ${stageName} not found`);

  let template = await getStageTemplate(stageName);
  if (!template) throw new Error(`Template for ${stageName} not found`);

  // Collect all variables needed for this stage
  const allVars = { ...data };
  for (const varName of stage.variables || []) {
    const v = getVariable(varName);
    if (v) allVars[varName] = v.content;
  }

  // Apply Mustache-like template substitution
  return applyTemplate(template, allVars);
}

/**
 * Apply Mustache-like template substitution
 */
function applyTemplate(template, data) {
  let result = template;

  // Handle sections {{#key}}...{{/key}}
  result = result.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
    const value = data[key];
    if (!value) return '';
    if (Array.isArray(value)) {
      return value.map(item => {
        if (typeof item === 'object') {
          return applyTemplate(content, item);
        }
        return content.replace(/\{\{\.\}\}/g, item);
      }).join('');
    }
    return applyTemplate(content, data);
  });

  // Handle inverted sections {{^key}}...{{/key}}
  result = result.replace(/\{\{\^(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
    return data[key] ? '' : content;
  });

  // Handle simple variables {{key}}
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return data[key] !== undefined ? String(data[key]) : '';
  });

  return result.trim();
}

/**
 * Preview a prompt with test data
 */
export async function previewPrompt(stageName, testData = {}) {
  return buildPrompt(stageName, testData);
}

// Load prompts on module init
loadPrompts().catch(err => console.error(`❌ Failed to load prompts: ${err.message}`));
