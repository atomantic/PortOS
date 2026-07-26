/**
 * Task Templates Service
 *
 * Quick task templates for common user task patterns.
 * Helps users quickly create tasks for frequently needed operations.
 */

import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';

const DATA_DIR = PATHS.cos;
const TEMPLATES_FILE = join(DATA_DIR, 'task-templates.json');

// Built-in templates: one per bundled slashdo workflow worth launching
// unattended (`lib/slashdo/commands/do/*.md`). These replaced eight generic
// phrase stubs ("Fix the bug where", "Refactor", …) which only seeded a
// sentence fragment the user had to finish typing anyway (#3089).
//
// `slashdoCommand` is the BARE command name — never a rendered `/do:x` string
// (see `server/lib/slashdoInvocation.js` for why).
//
// `settings` are the run-shape defaults a workflow implies. Every entry sets
// `useWorktree`/`openPR`/`simplify` to false, for two distinct reasons:
//   - plan-task / replan / review / scan write no code at all, so there is
//     nothing to isolate, PR, or simplify.
//   - next / better / depfree / release MANAGE THEIR OWN worktrees and PRs — a
//     PortOS-level worktree would nest one inside another, and `release` must
//     run from `main` in the primary checkout.
// A key absent from `settings` means "leave the current toggle alone" (the
// absent-vs-empty rule) — it does NOT mean false.
const WORKFLOW_OWNS_ITS_OWN_GIT = { useWorktree: false, openPR: false, simplify: false };

const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin-do-plan-task',
    name: 'Plan a Task',
    icon: '📋',
    slashdoCommand: 'plan-task',
    description: 'Investigate and file a decision-complete issue for: ',
    context: 'Runs the slashdo plan-task workflow: investigate the codebase, then file a ready-to-work issue.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-next',
    name: 'Ship Next Issue',
    icon: '🎯',
    slashdoCommand: 'next',
    description: 'Claim and ship the next open issue',
    context: 'Runs the slashdo next workflow: claim an unclaimed item, do the work in its own worktree, ship a PR.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-replan',
    name: 'Replan Backlog',
    icon: '🗺️',
    slashdoCommand: 'replan',
    description: 'Audit and triage the backlog',
    context: 'Runs the slashdo replan workflow: prune completed items, suggest new work, keep the plan lean.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-review',
    name: 'Review Changes',
    icon: '🔍',
    slashdoCommand: 'review',
    description: 'Deep code review of the changed files',
    context: 'Runs the slashdo review workflow: review changed files against software engineering best practices.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-release',
    name: 'Cut a Release',
    icon: '🚀',
    slashdoCommand: 'release',
    description: 'Create a release PR',
    context: "Runs the slashdo release workflow using the project's documented release process.",
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-better',
    name: 'DevSecOps Audit',
    icon: '🛡️',
    slashdoCommand: 'better',
    description: 'Run a DevSecOps audit and remediation pass',
    context: 'Runs the slashdo better workflow: audit, remediate, enhance tests, open per-category PRs.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-depfree',
    name: 'Prune Dependencies',
    icon: '📦',
    slashdoCommand: 'depfree',
    description: 'Audit dependencies and remove unnecessary ones',
    context: 'Runs the slashdo depfree workflow: audit third-party deps and replace the removable ones with code.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  },
  {
    id: 'builtin-do-scan',
    name: 'Safety Scan',
    icon: '🔒',
    slashdoCommand: 'scan',
    description: 'Read-only safety audit of: ',
    context: 'Runs the slashdo scan workflow: flag malware patterns, network calls, and vulnerable deps.',
    category: 'slashdo',
    settings: WORKFLOW_OWNS_ITS_OWN_GIT,
    isBuiltin: true
  }
];

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
  const data = await readJSONFile(TEMPLATES_FILE);
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
