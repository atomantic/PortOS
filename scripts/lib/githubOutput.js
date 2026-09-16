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
