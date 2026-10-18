#!/usr/bin/env node

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { inspectShippedPromptHistory } from './shippedPromptHistory.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = await inspectShippedPromptHistory({
  repoRoot,
  migrationsDir: join(repoRoot, 'scripts', 'migrations'),
  stageDir: join(repoRoot, 'data.reference', 'prompts', 'stages'),
});

if (result.skipped) {
  console.log(
    `⏭️ Skipping shipped stage-prompt history guard: ${result.skipped}`,
  );
  process.exit(0);
}

if (result.stranded.length) {
  for (const { file, hash, commit } of result.stranded) {
    console.error(
      `❌ ${file}: historical hash ${hash} from ${commit.slice(0, 12)} is not accepted by a prompt migration`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    '✅ Every historical shipped stage-prompt body is accepted by a prompt migration',
  );
}
