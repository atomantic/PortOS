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

const IDENTIFIER = /^[a-z][A-Za-z0-9]*$/;

/**
 * Candidate record-field identifiers a prompt cites in backticks. Strips the
 * illustrative value a check may attach (`episodeCountTarget: 12`) and the
 * array marker (`issues[]`) so the bare identifier is what gets tested. Only
 * single lowerCamelCase identifiers are candidates — JSON blobs, dotted paths
 * (`arc.themes`), kebab vocabulary, and prose fragments are not record fields.
 *
 * Angle-bracket placeholders inside the span are collected too: a `location`
 * form like `episode:<arcPosition>` names a real record field on its right-hand
 * side, and splitting at the colon would otherwise discard it — leaving a
 * substituted placeholder free to cite a field nothing renders.
 */
export const backtickedTokens = (markdown) => {
  const out = new Set();
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1];
    const token = span.split(':')[0].replace(/\[\]$/, '').trim();
    if (IDENTIFIER.test(token)) out.add(token);
    for (const placeholder of span.matchAll(/<([A-Za-z][A-Za-z0-9]*)>/g)) {
      if (IDENTIFIER.test(placeholder[1])) out.add(placeholder[1]);
    }
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
