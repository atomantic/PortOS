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

const LOCAL_ACTION_USES = /^ {6}(?:- | {2})uses: \.\/(\.github\/actions\/[^\s#]+)\s*$/m;

/** Each declared input's `default:`, from an action.yml's `inputs:` block. */
function actionInputDefaults(actionYaml) {
  const block = actionYaml.split(/^inputs:\n/m)[1]?.split(/^\S/m)[0] ?? '';
  const defaults = {};
  let current = null;
  for (const line of block.split('\n')) {
    const name = line.match(/^ {2}([A-Za-z][\w-]*):\s*$/);
    if (name) [, current] = name;
    const value = current && line.match(/^ {4}default:\s*(.*)$/);
    if (value) defaults[current] = value[1].replace(/^'(.*)'$/, '$1');
  }
  return defaults;
}

/**
 * Inline every `uses: ./.github/actions/<name>` step of each job, so a contract
 * test reads the job GitHub actually runs. The calling step stays verbatim and
 * is followed by the action's `runs.steps`, re-indented to job-step depth with
 * each `${{ inputs.<name> }}` replaced by the caller's `with:` value (or the
 * input's default). Composite actions do not nest here, so one pass suffices.
 *
 * @param {Record<string, string>} jobs - from workflowJobs()
 * @param {(path: string) => string} readFile - repo-relative path → contents
 * @returns {Record<string, string>} job id → expanded job body
 */
export function expandLocalActions(jobs, readFile) {
  const expandStep = (step) => {
    const uses = step.match(LOCAL_ACTION_USES);
    if (!uses) return step;
    const action = readFile(`${uses[1]}/action.yml`);
    const inputs = actionInputDefaults(action);
    const withBlock = step.split(/^ {8}with:\n/m)[1] ?? '';
    for (const [, key, value] of withBlock.matchAll(/^ {10}([A-Za-z][\w-]*):\s*(.*)$/gm)) inputs[key] = value;
    const steps = action.split(/^ {2}steps:\n/m)[1] ?? '';
    const body = steps.replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (match, key) => (key in inputs ? inputs[key] : match))
      .split('\n').map((line) => (line ? `  ${line}` : line)).join('\n');
    return `${step.replace(/\n*$/, '')}\n${body.replace(/\n*$/, '')}\n`;
  };
  return Object.fromEntries(Object.entries(jobs).map(([id, body]) => [
    id,
    body.split(/(?=^ {6}- )/m).map(expandStep).join(''),
  ]));
}
