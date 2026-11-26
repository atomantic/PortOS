/**
 * Keep legacy synchronous reads and key enumeration while loading a domain only
 * when its first body is requested. Node caches each catalog after that load.
 */
import { CONSOLIDATED_AUDIT_DOMAINS } from '../../lib/auditDomains.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalogs = {
  auditDomains: () => require('./catalog/auditDomains.js').prompts,
  media: () => require('./catalog/media.js').prompts,
  security: () => require('./catalog/security.js').prompts,
  quality: () => require('./catalog/quality.js').prompts,
  interface: () => require('./catalog/interface.js').prompts,
  dependencies: () => require('./catalog/dependencies.js').prompts,
  planning: () => require('./catalog/planning.js').prompts,
  planTask: () => require('./catalog/planTask.js').prompts,
  claim: () => require('./catalog/claim.js').prompts,
  reviews: () => require('./catalog/reviews.js').prompts,
  maintenance: () => require('./catalog/maintenance.js').prompts,
  reference: () => require('./catalog/reference.js').prompts,
};

// Keep default lookup and enumeration on the same lazy catalog.
const catalogForTask = {
  ...Object.fromEntries(Object.keys(CONSOLIDATED_AUDIT_DOMAINS).map(id => [id, catalogs.auditDomains])),
  'app-launch-video': catalogs.media,
  'model-comparison-refresh': catalogs.media,
  'security': catalogs.security,
  'accessibility': catalogs.interface,
  'dependency-updates': catalogs.dependencies,
  'api-contract': catalogs.quality,
  'better-dependency-freedom': catalogs.dependencies,
  'privacy': catalogs.security,
  'feature-completeness': catalogs.planning,
  'feature-ideas': catalogs.planning,
  'plan-feature': catalogs.planning,
  'media-render-research': catalogs.media,
  'plan-task': catalogs.planTask,
  'plan-task-claim': catalogs.planTask,
  'claim-issue': catalogs.claim,
  'claim-issue-gitlab': catalogs.claim,
  'claim-issue-jira': catalogs.claim,
  'code-reviewer-review': catalogs.reviews,
  'code-reviewer-implement': catalogs.reviews,
  'do-release': catalogs.maintenance,
  'stash-cleanup': catalogs.maintenance,
  'repo-sync': catalogs.maintenance,
  'user-action-review': catalogs.maintenance,
  'jira-sprint-manager': catalogs.maintenance,
  'do-replan': catalogs.planning,
  'jira-status-report': catalogs.maintenance,
  'branch-cleanup': catalogs.maintenance,
  'branch-reconcile': catalogs.maintenance,
  'issue-reconcile': catalogs.maintenance,
  'pr-reviewer': catalogs.reviews,
  'pr-reviewer-security': catalogs.reviews,
  'pr-reviewer-eligibility': catalogs.reviews,
  'pr-reviewer-review': catalogs.reviews,
  'reference-watch': catalogs.reference,
  'pr-watcher': catalogs.reviews,
  'refresh-local-llm-catalog': catalogs.media,
};

export function getDefaultTaskPrompt(taskType) {
  if (!Object.hasOwn(catalogForTask, taskType)) return null;
  return catalogForTask[taskType]()[taskType];
}

export const DEFAULT_TASK_PROMPTS = {};
for (const taskType of Object.keys(catalogForTask)) {
  Object.defineProperty(DEFAULT_TASK_PROMPTS, taskType, {
    enumerable: true,
    get: () => getDefaultTaskPrompt(taskType),
  });
}

export function composeClaimIssuePrompt(options) {
  return require('./catalog/claim.js').composeClaimIssuePrompt(options);
}
