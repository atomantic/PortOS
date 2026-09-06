/**
 * Pure catalog for deterministic context sources available to scheduled agents.
 *
 * `carriesDispatchLabels` marks an input whose rows can arrive already routed by
 * a planner (`model:` / `effort:`). It is declared here rather than sniffed from
 * the id so a later issues-shaped input inherits the routing contract by saying
 * so, not by happening to contain the right substring.
 */
export const TASK_DATA_INPUT_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'product-requirements', label: 'Product requirements', description: 'Find and include PRD.md files from the target repository.', requiresApp: true }),
  Object.freeze({ id: 'project-goals', label: 'Project goals', description: 'Find and include GOALS.md files from the target repository.', requiresApp: true }),
  Object.freeze({ id: 'open-issues', label: 'Open issues', description: 'Include the target repository\'s current open forge issues, with their labels.', requiresApp: true, carriesDispatchLabels: true }),
  Object.freeze({ id: 'open-pull-requests', label: 'Open pull requests', description: 'Include the target repository\'s current open pull or merge requests.', requiresApp: true }),
  Object.freeze({ id: 'closed-unmerged-pull-requests', label: 'Closed unmerged pull requests', description: 'Include recently closed pull or merge requests that were not merged.', requiresApp: true }),
]);

export const TASK_DATA_INPUT_IDS = Object.freeze(TASK_DATA_INPUT_DEFINITIONS.map(({ id }) => id));

export function getTaskDataInputCatalog() {
  return TASK_DATA_INPUT_DEFINITIONS.map((definition) => ({ ...definition }));
}
