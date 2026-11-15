#!/usr/bin/env node
/**
 * Advance server/services/taskPromptDefaults/integrity.snapshot.json to the
 * current prompt source — the second half of every prompt-default change
 * (AGENTS.md "Distribution model"): edit the body, then
 *
 *   node scripts/regen-prompt-integrity-snapshot.js
 *
 * The snapshot owns the version numbers, so the tool bumps a key's version
 * itself and retires the outgoing hash. After a rebase conflict in the
 * snapshot, take the base side and rerun it. The mechanism is
 * advancePromptIntegritySnapshot in
 * server/services/taskPromptDefaults/integrityHash.js. Output is
 * environment-independent, and nothing is written when the snapshot is
 * already current.
 */
import { writeFileSync } from 'fs';

import * as promptDefaults from '../server/services/taskPromptDefaults.js';
import {
  PROMPT_INTEGRITY_SNAPSHOT_PATH,
  advancePromptIntegritySnapshot,
  readPromptIntegritySnapshot,
} from '../server/services/taskPromptDefaults/integrityHash.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const serialize = (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;

/**
 * CLI body, returning an exit code instead of calling process.exit, so every
 * branch is assertable in-process (the shape scripts/trusted-rebuild-stamp.js
 * uses). `read` yields the committed snapshot; `write` receives the new text.
 */
export function runCli({
  read = readPromptIntegritySnapshot,
  write = (text) => writeFileSync(PROMPT_INTEGRITY_SNAPSHOT_PATH, text),
} = {}) {
  const committed = read();
  const { snapshot, retired, added, dropped } = advancePromptIntegritySnapshot(committed, promptDefaults);

  for (const { key, from, to, hash } of retired) {
    console.log(`📦 ${key}: ${from === undefined ? 'unversioned' : `v${from}`} → v${to}, retired ${hash} onto the recognized history`);
  }
  for (const { key, to } of added) console.log(`🆕 ${key}: new prompt starts at v${to}`);
  for (const key of dropped) console.log(`🗑️ ${key}: no longer in the snapshot's PROMPT_VERSIONS — dropped its retired-hash history`);

  const text = serialize(snapshot);
  if (text === serialize(committed)) {
    console.log('✅ Prompt integrity snapshot is already current');
    return 0;
  }
  write(text);
  console.log(`🔒 Regenerated prompt integrity snapshot (${Object.keys(snapshot.DEFAULT_TASK_PROMPTS).length} current, ${Object.keys(snapshot.PREVIOUS_DEFAULT_PROMPTS).length} historical prompt keys)`);
  return 0;
}

if (isDirectlyInvoked(import.meta.url)) process.exit(runCli());
