/**
 * GitHub Actions step-output/step-env/summary append helpers for CI scripts.
 * ZERO external dependencies: these run before anything is installed, so do NOT
 * import from server/lib or any installed package.
 */

import { appendFileSync } from 'fs';

/**
 * Append a `name=value` line to one of Actions' command files. Newlines and
 * carriage returns are stripped: the form has no escape, so an embedded newline
 * truncates the value and lets the remainder forge a second entry.
 */
function appendCommandFile(envVar, name, value) {
  const path = process.env[envVar];
  if (!path) return;
  appendFileSync(path, `${name}=${String(value).replace(/[\r\n]+/g, ' ')}\n`);
}

/** Append `name=value` to $GITHUB_OUTPUT, or do nothing outside Actions. */
export function writeStepOutput(name, value) {
  appendCommandFile('GITHUB_OUTPUT', name, value);
}

/** Append `name=value` to $GITHUB_ENV (no step `id` needed; later steps read it as plain env), or do nothing outside Actions. */
export function writeStepEnv(name, value) {
  appendCommandFile('GITHUB_ENV', name, value);
}

/**
 * Append a markdown block to $GITHUB_STEP_SUMMARY, or do nothing outside Actions.
 * Newlines are content here, not a delimiter, so they are kept: pass fixed prose
 * and values you control, never raw event payload text.
 */
export function writeStepSummary(markdown, env = process.env) {
  const path = env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, `${markdown}\n`);
}

/**
 * A workflow-sourced name (a job's, a step's) rendered into a log line. Actions
 * parses a leading `::` as a workflow command, so a newline or `::` would let a
 * name forge one. Capped because these land in an annotation title.
 */
export function safeWorkflowText(value, fallback = '') {
  return String(value || fallback)
    .replace(/[\r\n]+/g, ' ')
    .replace(/::/g, ':')
    .slice(0, 80);
}

/**
 * Escaping for the two halves of a workflow command: a property value is also
 * delimited by `:` and `,` (encoded there, NOT in the message). `%` goes first or
 * it would re-encode the escapes that follow.
 */
const escapeCommandData = (value) => String(value)
  .replace(/%/g, '%25')
  .replace(/\r/g, '%0D')
  .replace(/\n/g, '%0A');
const escapeCommandProperty = (value) => escapeCommandData(value)
  .replace(/:/g, '%3A')
  .replace(/,/g, '%2C');

/**
 * An `::error::` workflow annotation line, ready to print to stdout. Annotations
 * survive the run being cancelled out from under the writing job and render at
 * the top of the PR's Checks tab, which is why fail-fast reporting uses one.
 */
export function formatErrorAnnotation(title, message) {
  return `::error title=${escapeCommandProperty(title)}::${escapeCommandData(message)}`;
}

/** A `::warning::` workflow annotation line: reported on the run, never a failure. */
export function formatWarningAnnotation(title, message) {
  return `::warning title=${escapeCommandProperty(title)}::${escapeCommandData(message)}`;
}
