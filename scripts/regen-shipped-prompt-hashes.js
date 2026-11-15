#!/usr/bin/env node
/**
 * Advance data.reference/prompts/shipped-hashes.json to the current prompt
 * templates, the one step a template edit needs besides the `.md` change:
 *
 *   node scripts/regen-shipped-prompt-hashes.js
 *
 * A changed body retires its outgoing hash, so every install still holding it
 * is upgraded by the migration runner's prompt reconciler. Nothing is ever
 * removed, and nothing is written when the table is already current.
 */
import { writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  advanceShippedHashes,
  readReferencePromptHashes,
  readShippedHashes,
  serializeShippedHashes,
  shippedHashesPath,
} from './migrations/shippedPromptHashes.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** CLI body returning an exit code, so every branch is assertable in-process. */
export async function runCli({ rootDir = REPO_ROOT } = {}) {
  const committed = await readShippedHashes(rootDir);
  const { table, retired, added } = advanceShippedHashes(committed, await readReferencePromptHashes(rootDir));
  for (const key of added) console.log(`➕ ${key}: new shipped prompt`);
  for (const { key, hash } of retired) console.log(`📦 ${key}: retired ${hash}`);

  const text = serializeShippedHashes(table);
  if (text === serializeShippedHashes(committed)) {
    console.log('✅ Shipped prompt hashes are already current');
    return 0;
  }
  await writeFile(shippedHashesPath(rootDir), text);
  console.log(`🔒 Regenerated shipped prompt hashes (${Object.keys(table).length} prompts)`);
  return 0;
}

if (isDirectlyInvoked(import.meta.url)) process.exit(await runCli());
