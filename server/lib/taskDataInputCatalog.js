/** Pure catalog for deterministic context sources available to scheduled agents. */
export const TASK_DATA_INPUT_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'product-requirements', label: 'Product requirements', description: 'Find and include PRD.md files from the target repository.', requiresApp: true }),
  Object.freeze({ id: 'project-goals', label: 'Project goals', description: 'Find and include GOALS.md files from the target repository.', requiresApp: true }),
  Object.freeze({ id: 'open-issues', label: 'Open issues', description: 'Include the target repository\'s current open forge issues.', requiresApp: true }),
  Object.freeze({ id: 'open-pull-requests', label: 'Open pull requests', description: 'Include the target repository\'s current open pull or merge requests.', requiresApp: true }),
  Object.freeze({ id: 'closed-unmerged-pull-requests', label: 'Closed unmerged pull requests', description: 'Include recently closed pull or merge requests that were not merged.', requiresApp: true }),
]);

export const TASK_DATA_INPUT_IDS = Object.freeze(TASK_DATA_INPUT_DEFINITIONS.map(({ id }) => id));

export function getTaskDataInputCatalog() {
  return TASK_DATA_INPUT_DEFINITIONS.map((definition) => ({ ...definition }));
}
