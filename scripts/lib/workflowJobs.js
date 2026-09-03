/**
 * Split a GitHub Actions workflow file into its `jobs:` entries, keyed by job
 * id, each as the raw YAML text of that job. Shared by the workflow-contract
 * tests so the indentation-based slicing lives in one place.
 *
 * ZERO external dependencies — see githubOutput.js.
 */

/**
 * @param {string} yaml - workflow source
 * @returns {Record<string, string>} job id → job body
 */
export function workflowJobs(yaml) {
  const body = yaml.slice(yaml.indexOf('\njobs:\n'));
  const jobs = {};
  let current = null;
  for (const line of body.split('\n')) {
    const header = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (header) {
      current = header[1];
      jobs[current] = [];
      continue;
    }
    if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([id, lines]) => [id, lines.join('\n')]));
}
