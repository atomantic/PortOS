#!/usr/bin/env node
/**
 * Advance server/services/taskPromptDefaults/integrity.snapshot.json to the
 * current prompt source — step two of every prompt-default change (AGENTS.md
 * "Distribution model"): bump the prompt's PROMPT_VERSIONS entry, then
 *
 *   node scripts/regen-prompt-integrity-snapshot.js
 *
 * The mechanism — retire the outgoing hash on a bump, refuse a body change or
 * a rollback without one — is advancePromptIntegritySnapshot in
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
  const { snapshot, retired, drift, dropped } = advancePromptIntegritySnapshot(committed, promptDefaults);

  if (drift.length) {
    for (const { key, version, reason } of drift) {
      console.error(reason === 'rollback'
        ? `❌ ${key}: PROMPT_VERSIONS went backwards to v${version} — a rollback is not a bump; restore the version or ship the change as a new one`
        : `❌ ${key}: the default body changed but PROMPT_VERSIONS is still v${version} — bump it, then rerun`);
    }
    console.error('🔒 Snapshot left unchanged: an edited default with no version bump would ship unrecognized on every other install');
    return 1;
  }

  for (const { key, from, to, hash } of retired) {
    console.log(`📦 ${key}: ${from === undefined ? 'unversioned' : `v${from}`} → v${to}, retired ${hash} onto the recognized history`);
  }
  for (const key of dropped) console.log(`🗑️ ${key}: no longer in PROMPT_VERSIONS — dropped its retired-hash history`);

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
