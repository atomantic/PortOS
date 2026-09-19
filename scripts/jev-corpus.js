#!/usr/bin/env node
/**
 * Build the scope-adherence training corpus from this checkout's forge history.
 *
 *   node scripts/jev-corpus.js [--repo <path>] [--json]
 *
 * A thin CLI over `services/jevCorpusBuilder.js` — the same code path the
 * "Train a project head" action in the jev panel runs, so a corpus built here
 * and a corpus built there are the same corpus. Writes
 * `data/jev/corpora/scope-adherence-<hash>/{train,gold,manifest}` and prints the
 * manifest.
 *
 * It prints COUNTS. Never an example, never a premise, never a clause: the
 * corpus is this install's private repository history, and a terminal is not
 * where that belongs. Read the JSONL directly if you need to audit it.
 *
 * Exits non-zero on the refusals that matter — most importantly
 * `jev-corpus-split-overlap`, which means the gold set shares rows with the
 * training split and any score measured on it would be partly memorization.
 */

import { buildScopeAdherenceCorpus } from '../server/services/jevCorpusBuilder.js';
import { resolveForgeForRepo } from '../server/services/forgeAuth.js';
import { PATHS } from '../server/lib/paths.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const position = argv.indexOf(name);
  return position >= 0 && argv[position + 1] ? argv[position + 1] : fallback;
};

const repoPath = flag('--repo', PATHS.root);
const asJson = argv.includes('--json');

const forge = await resolveForgeForRepo(repoPath).catch(() => null);
const result = await buildScopeAdherenceCorpus({ repoPath, env: forge?.env || null });

if (!result.ok) {
  console.error(`❌ jev corpus build failed: ${result.code}`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`📚 jev corpus ${result.corpusHash} — ${result.trainSize} train / ${result.goldSize} gold`);
  for (const [source, count] of Object.entries(result.sources)) console.log(`   ${source}: ${count}`);
  console.log(`   majority-class baseline on gold: ${(result.majorityClass * 100).toFixed(1)}%`);
  console.log(`   shadow evidence: ${result.shadow.observed} observed, ${result.shadow.compared} compared`);
  console.log(`   written to ${result.corpusDir.replace(PATHS.installRoot, '.')}`);
}
