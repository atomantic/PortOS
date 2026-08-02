#!/usr/bin/env node
/**
 * Regenerate server/services/taskPromptDefaults/integrity.snapshot.json.
 *
 * Run this ONLY after an intentional prompt-default change that also bumped
 * PROMPT_VERSIONS and appended the outgoing default to PREVIOUS_DEFAULT_PROMPTS
 * (see CLAUDE.md "Distribution model"). Regenerating to silence a failing
 * integrity test without those two steps blesses whatever edited a preserved
 * historical body — which is precisely what the test exists to catch.
 *
 *   node scripts/regen-prompt-integrity-snapshot.js
 *
 * Output is environment-independent (see integrityHash.js), so it produces the
 * same bytes on every install.
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import * as promptDefaults from '../server/services/taskPromptDefaults.js';
import { buildPromptIntegritySnapshot } from '../server/services/taskPromptDefaults/integrityHash.js';

const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'server',
  'services',
  'taskPromptDefaults',
  'integrity.snapshot.json',
);

const snapshot = buildPromptIntegritySnapshot(promptDefaults);
writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`🔒 Regenerated prompt integrity snapshot (${Object.keys(snapshot.DEFAULT_TASK_PROMPTS).length} current, ${Object.keys(snapshot.PREVIOUS_DEFAULT_PROMPTS).length} historical prompt keys)`);
