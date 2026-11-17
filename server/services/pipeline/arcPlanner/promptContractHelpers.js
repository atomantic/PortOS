/**
 * Shared test-support for the arc-planner prompt <-> context contract suites
 * (`verifyPromptContract.test.js`, `volumeVerifyPromptContract.test.js`): each
 * prompt checklist and its context object are independent lists that only those
 * suites keep in agreement, so the primitives are shared, not copied.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pathWithin } from '../../../../lib/pathWithin.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * Read a SHIPPED stage prompt from `data.reference/`, not the gitignored,
 * user-customizable `data/`: only the shipped seed is a contract worth enforcing.
 * A name that climbs out of the stages directory rejects (`pathWithin`).
 */
export const readShippedPrompt = async (name) =>
  readFile(pathWithin(join(REPO_ROOT, 'data.reference', 'prompts', 'stages'), name), 'utf-8');

const IDENTIFIER = /^[a-z][A-Za-z0-9]*$/;

/**
 * Candidate record-field identifiers a prompt cites in backticks. Strips an
 * illustrative value (`episodeCountTarget: 12`) and array marker (`issues[]`);
 * only single lowerCamelCase identifiers count (not JSON, dotted paths, kebab
 * vocabulary or prose). Angle-bracket placeholders inside the span are collected
 * too: `episode:<arcPosition>` names a real field after the colon.
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
