/**
 * Shared test-support for the arc-planner prompt ↔ context contract suites
 * (`verifyPromptContract.test.js`, `volumeVerifyPromptContract.test.js`).
 *
 * Each verify prompt's checklist and the context object that feeds it are two
 * independent lists with nothing but those suites enforcing agreement. Both
 * suites need the same three primitives, so they live here rather than being
 * copied per prompt — a copy would drift exactly the way the prompts do.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Read a SHIPPED stage prompt. Deliberately reads `data.reference/` and not
 * `data/` — `data/` is gitignored per-install state that a user may have
 * customized, so only the seed the repo ships is a contract worth enforcing.
 */
export const readShippedPrompt = (name) =>
  readFile(join(REPO_ROOT, 'data.reference', 'prompts', 'stages', name), 'utf-8');

/**
 * Candidate record-field identifiers a prompt cites in backticks. Strips the
 * illustrative value a check may attach (`episodeCountTarget: 12`) and the
 * array marker (`issues[]`) so the bare identifier is what gets tested. Only
 * single lowerCamelCase identifiers are candidates — JSON blobs, dotted paths
 * (`arc.themes`), kebab vocabulary, and prose fragments are not record fields.
 */
export const backtickedTokens = (markdown) => {
  const out = new Set();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].split(':')[0].replace(/\[\]$/, '').trim();
    if (/^[a-z][A-Za-z0-9]*$/.test(token)) out.add(token);
  }
  return out;
};

/** The `{{worldX}}` blocks a prompt interpolates. */
export const worldVars = (markdown) => new Set(
  [...markdown.matchAll(/\{\{\{?(world[A-Za-z0-9]*)\}?\}\}/g)].map((m) => m[1]),
);

/** The leaf names a prompt interpolates under a dotted `{{prefix.x}}` namespace. */
export const namespacedVars = (markdown, prefix) => new Set(
  [...markdown.matchAll(new RegExp(`\\{\\{\\{?${prefix}\\.([A-Za-z0-9]+)\\}?\\}\\}`, 'g'))].map((m) => m[1]),
);
