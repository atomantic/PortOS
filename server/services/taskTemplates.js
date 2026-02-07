/**
 * Task Templates Service
 *
 * Quick task templates for common user task patterns.
 * Helps users quickly create tasks for frequently needed operations.
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readJSONFile } from '../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '../../data/cos');
const TEMPLATES_FILE = join(DATA_DIR, 'task-templates.json');

// Built-in templates based on common task patterns
const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin-mobile-fix',
    name: 'Fix Mobile Responsiveness',
    icon: '📱',
    description: 'Make this page mobile-friendly',
    context: 'Check viewport sizes 375px, 768px, and 1024px. Fix Tailwind responsive classes.',
    category: 'ui',
    isBuiltin: true
  },
  {
    id: 'builtin-add-feature',
    name: 'Add New Feature',
    icon: '✨',
    description: 'Add a new feature to',
    context: 'Follow existing patterns in the codebase. Write tests for new functionality.',
    category: 'feature',
    isBuiltin: true
  },
  {
    id: 'builtin-fix-bug',
    name: 'Fix Bug',
    icon: '🐛',
    description: 'Fix the bug where',
    context: 'Investigate root cause, implement fix, add test to prevent regression.',
    category: 'bugfix',
    isBuiltin: true
  },
  {
    id: 'builtin-refactor',
    name: 'Refactor Code',
    icon: '🔧',
    description: 'Refactor',
    context: 'Improve code quality while maintaining existing behavior. Ensure tests pass.',
    category: 'refactor',
    isBuiltin: true
  },
  {
    id: 'builtin-add-test',
    name: 'Add Tests',
    icon: '🧪',
    description: 'Add tests for',
    context: 'Write unit tests with good coverage. Follow existing test patterns.',
    category: 'testing',
    isBuiltin: true
  },
  {
    id: 'builtin-improve-ux',
    name: 'Improve UX',
    icon: '🎨',
    description: 'Improve the user experience of',
    context: 'Focus on usability, accessibility, and visual polish.',
    category: 'ui',
    isBuiltin: true
  },
  {
    id: 'builtin-add-api',
    name: 'Add API Endpoint',
    icon: '🔌',
    description: 'Add API endpoint for',
    context: 'Add route with Zod validation, service function, and API tests.',
    category: 'feature',
    isBuiltin: true
  },
  {
    id: 'builtin-security-fix',
    name: 'Security Fix',
    icon: '🔒',
    description: 'Fix security issue in',
    context: 'Address vulnerability with proper input validation and sanitization.',
    category: 'security',
    isBuiltin: true
  }
];

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
  const data = await readJSONFile(TEMPLATES_FILE);
  if (!data) return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...data, userTemplates: data.userTemplates || [], usage: data.usage || {} };
}

/**
 * Save templates state
 */
async function saveState(state) {
  state.lastUpdated = new Date().toISOString();

  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }

  await writeFile(TEMPLATES_FILE, JSON.stringify(state, null, 2));
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
    app: templateData.app || '',
    isBuiltin: false,
    createdAt: new Date().toISOString()
  };

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
    app: task.app || ''
  });
}
