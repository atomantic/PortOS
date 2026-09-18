/**
 * GitHub Actions step-output/step-env/summary append helpers for CI scripts.
 *
 * ZERO external dependencies — these run in jobs that have not installed
 * anything yet. Do NOT import from server/lib or any installed package.
 */

import { appendFileSync } from 'fs';

/**
 * Append a `name=value` line to one of Actions' key/value command files.
 *
 * Newlines and carriage returns are stripped: the `name=value` form has no
 * escape, so an embedded newline silently truncates the value and lets the
 * remainder forge a second entry. Callers that render a value as markdown
 * should sanitize further at their own call site.
 */
function appendCommandFile(envVar, name, value) {
  const path = process.env[envVar];
  if (!path) return;
  appendFileSync(path, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`);
}

/**
 * Append `name=value` to $GITHUB_OUTPUT, or do nothing outside Actions.
 *
 * @param {string} name - output name
 * @param {unknown} value - stringified before writing
 */
export function writeStepOutput(name, value) {
  appendCommandFile('GITHUB_OUTPUT', name, value);
}

/**
 * Append `name=value` to $GITHUB_ENV, or do nothing outside Actions.
 *
 * Unlike a step output this needs no `id`, and later steps in the same job read
 * it as an ordinary process environment variable — which is what lets one
 * resolver step feed several plain `node scripts/...` steps.
 *
 * @param {string} name - environment variable name
 * @param {unknown} value - stringified before writing
 */
export function writeStepEnv(name, value) {
  appendCommandFile('GITHUB_ENV', name, value);
}

/**
 * Append a markdown block to $GITHUB_STEP_SUMMARY, or do nothing outside
 * Actions.
 *
 * Unlike the `name=value` files above, the summary is free-form markdown:
 * newlines are content, not a delimiter, so they are preserved rather than
 * collapsed. That makes the caller responsible for what it renders — pass
 * fixed prose and values you control, never raw event payload text.
 *
 * @param {string} markdown - block to append; a trailing newline is added
 * @param {NodeJS.ProcessEnv} [env] - injectable for tests
 */
export function writeStepSummary(markdown, env = process.env) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${markdown}\n`);
}

/**
 * A workflow-sourced name (a job's, a step's) rendered into a log line.
 *
 * Actions parses a line beginning `::` as a workflow command, and the name
 * comes from a workflow file, so a newline or a `::` would let a name forge a
 * command instead of appearing in one. Capped because these land in an
 * annotation title, not in a report.
 *
 * @param {unknown} value
 * @param {string} [fallback] - used when the value is empty
 * @returns {string}
 */
export function safeWorkflowText(value, fallback = '') {
  return String(value || fallback)
    .replace(/[\r\n]+/g, ' ')
    .replace(/::/g, ':')
    .slice(0, 80);
}

/**
 * Escaping for the two halves of a workflow command, which differ: a property
 * value is delimited by `:` and `,` as well, so those need encoding there and
 * must NOT be encoded in the message (where they are ordinary punctuation).
 * `%` goes first, or it would re-encode the escapes that follow it.
 */
const escapeCommandData = (value) => String(value)
  .replace(/%/g, '%25')
  .replace(/\r/g, '%0D')
  .replace(/\n/g, '%0A');
const escapeCommandProperty = (value) => escapeCommandData(value)
  .replace(/:/g, '%3A')
  .replace(/,/g, '%2C');

/**
 * An `::error::` workflow annotation line, ready to print to stdout.
 *
 * Annotations are the one diagnostic surface that survives the run being
 * cancelled out from under the job that wrote it: Actions records them the
 * moment the line is printed, and renders them at the top of the pull
 * request's Checks tab. That is why fail-fast reporting uses one — a job's
 * step conclusions are readable over the API, but only by somebody who
 * already knows to look (issue 7574).
 *
 * @param {string} title - short heading; shown in the Checks tab
 * @param {string} message - the detail line
 * @returns {string}
 */
export function formatErrorAnnotation(title, message) {
  return `::error title=${escapeCommandProperty(title)}::${escapeCommandData(message)}`;
}
