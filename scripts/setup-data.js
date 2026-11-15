#!/usr/bin/env node
import { existsSync, readdirSync, rmdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { inspectInstalledPrompts } from './migrations/shippedPromptHashes.js';
import { seedDataDir } from './lib/seedDataDir.js';
import { mergeJsonStarterTargets } from './lib/mergeJsonStarter.js';
import { rewriteAppsPortosRoot } from './lib/rewriteAppsPortosRoot.js';
import { adoptLegacyAppliedList } from './lib/migrationLedger.js';
import { setupSpotlight } from './setup-spotlight.js';
import { setupTimeMachine } from './setup-timemachine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const referenceDir = join(rootDir, 'data.reference');

console.log('📁 Setting up data directory...');

// One-shot cleanup for installs that predate the migrations-out-of-data move:
// (1) relocate data/migrations/.applied.json → data/migrations.applied.json
//     (the migration runner adopts it too, for a boot that skips setup-data);
// (2) drop the now-orphan data/migrations/ directory if empty. Guarded so we
//     never clobber a fresh-layout applied file and never blow away a non-empty
//     dir (in case a user has uncommitted local migration files).
const legacyMigrationsDir = join(dataDir, 'migrations');
if (await adoptLegacyAppliedList(rootDir)) {
  console.log('🧹 Moved data/migrations/.applied.json → data/migrations.applied.json');
}
if (existsSync(legacyMigrationsDir) && readdirSync(legacyMigrationsDir).length === 0) {
  rmdirSync(legacyMigrationsDir);
  console.log('🧹 Removed orphan data/migrations/ directory');
}

/**
 * Expand `__PORTOS_ROOT__` in data/apps.json to this checkout's absolute path.
 * Idempotent: no-op when the file is missing or already expanded. Runs for both
 * fresh seeds and existing data/ trees (partial copies / restored volumes can
 * leave the literal token in place — that breaks Apps → Git checkout detection).
 */
const rewritePortosRootPlaceholder = () => {
  const { rewritten, token, rootDir: expandedRoot } = rewriteAppsPortosRoot(dataDir, rootDir);
  if (rewritten) {
    console.log(`📍 Expanded ${token} in apps.json → ${expandedRoot}`);
  }
};

const { created } = seedDataDir({ referenceDir, dataDir, log: console.log });
rewritePortosRootPlaceholder();
setupSpotlight(dataDir);
setupTimeMachine(rootDir);
console.log(created
  ? '✅ Data directory created'
  : '✅ Data directory already exists, ensured subdirectories and files');

// Merge new top-level entries from data.reference's structured JSON files into
// the user's existing copies, leaving customized entries untouched. Without
// this, only file-level "missing → copy" propagation runs above, so a new
// prompt stage or shared variable added to data.reference/prompts/ never
// reaches an existing install whose stage-config.json or variables.json
// already exists. Each merge target points at one top-level dict-shaped key
// (`stages` for stage-config.json, `variables` for variables.json) and the
// merger adds entries the user is missing without overwriting anything they
// have. data/setup-data-seeded.json records which starter keys each target has
// already been offered, so a starter entry the user deleted stays deleted while
// an entry new in a later release still arrives. An install with no ledger entry
// for a target gets every missing key once (bootstrap), then the ledger is written.
const JSON_MERGE_TARGETS = [
  { relPath: 'prompts/stage-config.json', mergeKey: 'stages' },
  { relPath: 'prompts/variables.json',    mergeKey: 'variables' },
  { relPath: 'providers.json',            mergeKey: 'providers' },
];

mergeJsonStarterTargets({
  targets: JSON_MERGE_TARGETS,
  referenceDir,
  dataDir,
  ledgerPath: join(dataDir, 'setup-data-seeded.json'),
});

// Drift detection: classify every installed shipped prompt against
// data.reference/prompts/shipped-hashes.json. An untouched older shipped body
// is upgraded by the reconciler at the end of the next migration run; a body
// matching no shipped hash is the user's edit and is never overwritten.
const drift = await inspectInstalledPrompts(rootDir);
const autoUpdatable = drift.filter(({ state }) => state === 'retired');
const customized = drift.filter(({ state }) => state === 'customized');

if (autoUpdatable.length > 0) {
  console.warn(
    `\n⚠️  ${autoUpdatable.length} prompt(s) will be auto-updated by the next \`npm run migrations\` (or server start):\n` +
    autoUpdatable.map(({ key }) => `   • data/prompts/${key}`).join('\n') + '\n',
  );
}

if (customized.length > 0) {
  console.warn(
    `\n⚠️  ${customized.length} prompt(s) are customized and cannot be auto-updated.\n` +
    `   Manually merge the new template changes into each file:\n` +
    customized.map(({ key }) =>
      `   • data/prompts/${key}\n` +
      `     Compare with: data.reference/prompts/${key}`,
    ).join('\n') + '\n',
  );
}
