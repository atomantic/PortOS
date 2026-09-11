/**
 * Task Templates Service
 *
 * Quick task templates for common user task patterns.
 * Helps users quickly create tasks for frequently needed operations.
 */

import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { SLASHDO_WORKFLOWS } from '../lib/slashdoCatalog.js';

const DATA_DIR = PATHS.cos;
const TEMPLATES_FILE = join(DATA_DIR, 'task-templates.json');

// Built-in templates: one per bundled slashdo workflow worth launching
// unattended. These replaced eight generic phrase stubs ("Fix the bug where",
// "Refactor", …) which only seeded a sentence fragment the user had to finish
// typing anyway (#3089).
//
// DERIVED from the shared launchable-workflow catalog (#3114) rather than a
// hand-maintained second list — the route's Agent Operations registry reads the
// same source, so a workflow added there shows up in BOTH surfaces. Add or
// change a workflow in `server/lib/slashdoCatalog.js`, not here.
//
// `slashdoCommand` is the BARE command name — never a rendered `/do:x` string
// (see `server/lib/slashdoInvocation.js` for why).
const BUILT_IN_TEMPLATES = SLASHDO_WORKFLOWS.map(w => ({
  id: `builtin-do-${w.command}`,
  name: w.templateName,
  icon: w.icon,
  slashdoCommand: w.command,
  // `templatePrompt` is the trailing fragment for a workflow that needs a typed
  // target ("Safety scan of: "); everything else states what the run does.
  description: w.templatePrompt || w.description,
  context: `Runs the slashdo ${w.command} workflow: ${w.detail}.`,
  category: 'slashdo',
  settings: w.settings,
  isBuiltin: true
}));

const BUILT_IN_IDS = new Set(BUILT_IN_TEMPLATES.map(t => t.id));

// Default empty state
const DEFAULT_STATE = {
  version: 1,
  lastUpdated: null,
  userTemplates: [],
  usage: {}
};

/**
 * Load templates state
 */
async function loadState() {
  const data = await readJSONFile(TEMPLATES_FILE, null, { strict: true });
  if (!data) return { ...DEFAULT_STATE };
  return {
    ...DEFAULT_STATE,
    ...data,
    userTemplates: data.userTemplates || [],
    usage: pruneOrphanBuiltinUsage(data.usage || {})
  };
}

/**
 * Drop `usage` counters for `builtin-*` ids that no longer exist. Built-in
 * templates are code, not data — when the shipped set changes (#3089 swapped the
 * eight generic stubs for slashdo workflows) their counters would otherwise
 * linger in `data/cos/task-templates.json` forever, inflating nothing and
 * confusing anyone reading the file. User-template counters (`user-*`) are
 * untouched — those ids are only removed by deleteTemplate.
 */
function pruneOrphanBuiltinUsage(usage) {
  const kept = {};
  for (const [id, count] of Object.entries(usage)) {
    if (id.startsWith('builtin-') && !BUILT_IN_IDS.has(id)) continue;
    kept[id] = count;
  }
  return kept;
}

/**
 * Save templates state
 */
async function saveState(state) {
  state.lastUpdated = new Date().toISOString();

  await ensureDir(DATA_DIR);
  await atomicWrite(TEMPLATES_FILE, state);
}

/**
 * Get all templates (built-in + user)
 */
export async function getAllTemplates() {
  const state = await loadState();

  // Combine built-in and user templates
  const templates = [
    ...BUILT_IN_TEMPLATES,
    ...state.userTemplates
  ];

  // Add usage counts
  return templates.map(t => ({
    ...t,
    useCount: state.usage[t.id] || 0
  }));
}

/**
 * Get templates sorted by recent usage
 */
export async function getPopularTemplates(limit = 5) {
  const templates = await getAllTemplates();

  return templates
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
    .slice(0, limit);
}

/**
 * Record template usage (for popularity tracking)
 */
export async function recordTemplateUsage(templateId) {
  const state = await loadState();

  if (!state.usage) {
    state.usage = {};
  }

  state.usage[templateId] = (state.usage[templateId] || 0) + 1;
  await saveState(state);

  return state.usage[templateId];
}

/**
 * Create a new user template
 */
export async function createTemplate(templateData) {
  const state = await loadState();

  const newTemplate = {
    id: `user-${Date.now().toString(36)}`,
    name: templateData.name,
    icon: templateData.icon || '📝',
    description: templateData.description,
    context: templateData.context || '',
    category: templateData.category || 'custom',
    provider: templateData.provider || '',
    model: templateData.model || '',
    effort: templateData.effort || '',
    app: templateData.app || '',
    isBuiltin: false,
    createdAt: new Date().toISOString()
  };

  // Optional slashdo binding. Omitted (not blanked) when absent so applyTemplate's
  // "key absent = leave the toggle alone" contract holds for user templates too.
  if (templateData.slashdoCommand) newTemplate.slashdoCommand = templateData.slashdoCommand;
  if (templateData.settings && typeof templateData.settings === 'object') newTemplate.settings = templateData.settings;

  state.userTemplates.push(newTemplate);
  await saveState(state);

  return newTemplate;
}

/**
 * Update a user template
 */
export async function updateTemplate(templateId, updates) {
  const state = await loadState();

  const index = state.userTemplates.findIndex(t => t.id === templateId);
  if (index === -1) {
    return { error: 'Template not found or is a built-in template' };
  }

  state.userTemplates[index] = {
    ...state.userTemplates[index],
    ...updates,
    id: templateId, // Preserve ID
    isBuiltin: false,
    updatedAt: new Date().toISOString()
  };

  await saveState(state);
  return state.userTemplates[index];
}

/**
 * Delete a user template
 */
export async function deleteTemplate(templateId) {
  const state = await loadState();

  // Can't delete built-in templates
  if (templateId.startsWith('builtin-')) {
    return { error: 'Cannot delete built-in templates' };
  }

  const index = state.userTemplates.findIndex(t => t.id === templateId);
  if (index === -1) {
    return { error: 'Template not found' };
  }

  const deleted = state.userTemplates.splice(index, 1)[0];

  // Also clean up usage data
  if (state.usage && state.usage[templateId]) {
    delete state.usage[templateId];
  }

  await saveState(state);

  return { success: true, deleted };
}

/**
 * Get categories with counts
 */
export async function getCategories() {
  const templates = await getAllTemplates();

  const categories = {};
  for (const t of templates) {
    const cat = t.category || 'other';
    if (!categories[cat]) {
      categories[cat] = { name: cat, count: 0 };
    }
    categories[cat].count++;
  }

  return Object.values(categories);
}

/**
 * Create template from a completed task
 * Useful for saving successful task patterns
 */
export async function createTemplateFromTask(task, templateName) {
  return createTemplate({
    name: templateName || `Custom: ${task.description?.substring(0, 30)}...`,
    icon: '⭐',
    description: task.description,
    context: task.context || '',
    category: 'from-task',
    provider: task.provider || '',
    model: task.model || '',
    effort: task.effort || '',
    app: task.app || ''
  });
}
