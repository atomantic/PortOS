#!/usr/bin/env node

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { inspectShippedPromptHistory } from './shippedPromptHistory.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = await inspectShippedPromptHistory({ repoRoot });

if (result.skipped) {
  const inCi = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';
  if (inCi) {
    console.error(`❌ Shipped prompt history guard requires full git history in CI: ${result.skipped}`);
    process.exitCode = 1;
  } else {
    console.log(`⏭️ Skipping shipped prompt history guard: ${result.skipped}`);
    process.exit(0);
  }
} else if (result.stranded.length) {
  for (const { file, hash, commit } of result.stranded) {
    console.error(
      `❌ ${file}: historical hash ${hash} from ${commit.slice(0, 12)} is not retired in data.reference/prompts/shipped-hashes.json — run node scripts/regen-shipped-prompt-hashes.js, or restore the dropped hash`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    '✅ Every historical shipped prompt body is current or retired in shipped-hashes.json',
  );
}
