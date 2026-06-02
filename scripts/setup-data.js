#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, rmdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { md5, buildPromptDriftTables } from './migrations/_lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const referenceDir = join(rootDir, 'data.reference');

console.log('📁 Setting up data directory...');

// One-shot cleanup for installs that predate the migrations-out-of-data move:
// (1) relocate data/migrations/.applied.json → data/migrations.applied.json so
//     run-migrations.js finds the prior applied-list and doesn't re-run anything;
// (2) drop the now-orphan data/migrations/ directory if empty. Guarded so we
//     never clobber a fresh-layout applied file and never blow away a non-empty
//     dir (in case a user has uncommitted local migration files).
const legacyMigrationsDir = join(dataDir, 'migrations');
const legacyAppliedFile = join(legacyMigrationsDir, '.applied.json');
const newAppliedFile = join(dataDir, 'migrations.applied.json');
if (existsSync(legacyAppliedFile) && !existsSync(newAppliedFile)) {
  renameSync(legacyAppliedFile, newAppliedFile);
  console.log('🧹 Moved data/migrations/.applied.json → data/migrations.applied.json');
}
if (existsSync(legacyMigrationsDir) && readdirSync(legacyMigrationsDir).length === 0) {
  rmdirSync(legacyMigrationsDir);
  console.log('🧹 Removed orphan data/migrations/ directory');
}

if (!existsSync(dataDir)) {
  console.log('📁 Creating data directory from data.reference...');
  mkdirSync(dataDir, { recursive: true });
  cpSync(referenceDir, dataDir, { recursive: true });

  // Replace __PORTOS_ROOT__ placeholder with actual install path in apps.json
  const appsFile = join(dataDir, 'apps.json');
  if (existsSync(appsFile)) {
    const content = readFileSync(appsFile, 'utf8');
    if (content.includes('__PORTOS_ROOT__')) {
      writeFileSync(appsFile, content.replace(/__PORTOS_ROOT__/g, rootDir));
      console.log(`📍 Set PortOS repoPath to ${rootDir}`);
    }
  }

  console.log('✅ Data directory created');
} else {
  // Ensure all subdirectories and files exist without overwriting existing files
  const ensureSampleContent = (srcDir, destDir) => {
    const items = readdirSync(srcDir);
    for (const item of items) {
      const srcPath = join(srcDir, item);
      const destPath = join(destDir, item);
      const stat = statSync(srcPath);

      if (stat.isDirectory()) {
        if (!existsSync(destPath)) {
          console.log(`📁 Creating missing directory: ${item}`);
          mkdirSync(destPath, { recursive: true });
        }
        ensureSampleContent(srcPath, destPath);
      } else if (!existsSync(destPath)) {
        console.log(`📄 Creating missing file: ${destPath.replace(dataDir + '/', '')}`);
        cpSync(srcPath, destPath);
      }
    }
  };

  ensureSampleContent(referenceDir, dataDir);

  console.log('✅ Data directory already exists, ensured subdirectories and files');
}

// Merge new top-level entries from data.reference's structured JSON files into
// the user's existing copies, leaving customized entries untouched. Without
// this, only file-level "missing → copy" propagation runs above, so a new
// prompt stage or shared variable added to data.reference/prompts/ never
// reaches an existing install whose stage-config.json or variables.json
// already exists. Each merge target points at one top-level dict-shaped key
// (`stages` for stage-config.json, `variables` for variables.json) and the
// merger adds entries the user is missing without overwriting anything they
// have. Caveat: if a user deliberately deleted a starter entry it WILL come
// back on the next run — that's the documented trade-off vs. silent drift.
const JSON_MERGE_TARGETS = [
  { relPath: 'prompts/stage-config.json', mergeKey: 'stages' },
  { relPath: 'prompts/variables.json',    mergeKey: 'variables' },
  { relPath: 'providers.json',            mergeKey: 'providers' },
];

const mergeJsonStarter = (relPath, mergeKey) => {
  const samplePath = join(referenceDir, relPath);
  const dataPath = join(dataDir, relPath);
  if (!existsSync(samplePath) || !existsSync(dataPath)) return;
  let sample, data;
  try {
    sample = JSON.parse(readFileSync(samplePath, 'utf8'));
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (err) {
    console.log(`⚠️ Skipping JSON merge for ${relPath}: ${err.message}`);
    return;
  }
  const sampleEntries = sample?.[mergeKey];
  if (!sampleEntries || typeof sampleEntries !== 'object' || Array.isArray(sampleEntries)) return;
  if (!data[mergeKey] || typeof data[mergeKey] !== 'object' || Array.isArray(data[mergeKey])) {
    data[mergeKey] = {};
  }
  const added = [];
  for (const [key, value] of Object.entries(sampleEntries)) {
    if (!(key in data[mergeKey])) {
      data[mergeKey][key] = value;
      added.push(key);
    }
  }
  if (added.length > 0) {
    writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`📝 ${relPath}: merged ${added.length} new ${mergeKey} ${added.length === 1 ? 'entry' : 'entries'} (${added.join(', ')})`);
  }
};

for (const { relPath, mergeKey } of JSON_MERGE_TARGETS) {
  mergeJsonStarter(relPath, mergeKey);
}

// Drift detection — warn when a data.reference/prompts/{stages,_partials}/*.md
// differs from the installed copy. Only fires on existing installs (fresh
// installs already got a full copy above). Prompt templates drift when a PortOS
// update adds new template variables (e.g. {{lengthTargets.*}}) that existing
// installs won't pick up because setup-data.js only copies *missing* files.
//
// The drift tables are NOT hand-mirrored here — they are swept from each
// migration's exported `ACCEPTED_OLD_MD5` / `NEW_SHIPPED_MD5` (+ optional
// `DRIFT_SUBDIRS`) constants, so the migration that actually performs the
// auto-update is the single source of truth. `buildPromptDriftTables` merges
// each file's lineage (union of accepted-old + intermediate-new hashes; the
// highest-numbered migration's new hash is the current shipped baseline) and
// returns per-subdir `{ oldMap, newMap, files }` tables. Only the files
// managed by a migration are checked, so prompts with no migration counterpart
// (e.g. cd-evaluate.md) never produce misleading warnings.
const driftTables = await buildPromptDriftTables(join(__dirname, 'migrations'));
const emptyDriftTable = () => ({ oldMap: {}, newMap: {}, files: [] });
const stageTable   = driftTables.stages    || emptyDriftTable();
const partialTable = driftTables._partials || emptyDriftTable();

// Walk one directory's worth of shipped prompt files against a hash table
// and partition them into auto-updatable (still on a known old hash) vs.
// customized (hash matches neither old nor new). Used twice — once for
// stage prompts, once for partial fragments.
const collectDrift = ({ sampleSubdir, dataSubdir, files, oldMap, newMap }) => {
  const sampleSubpath = join(referenceDir, ...sampleSubdir);
  const dataSubpath   = join(dataDir,   ...dataSubdir);
  if (!existsSync(sampleSubpath) || !existsSync(dataSubpath)) {
    return { autoUpdatable: [], customized: [] };
  }
  const autoUpdatable = [];
  const customized    = [];
  for (const f of files) {
    const dataPath = join(dataSubpath, f);
    // No data.reference twin → the prompt was renamed/retired upstream (e.g.
    // pipeline-tv-script.md → pipeline-teleplay.md); there's nothing to
    // auto-update *to*, so skip rather than warn about a phantom drift.
    if (!existsSync(join(sampleSubpath, f))) continue;
    if (!existsSync(dataPath)) continue;
    const dataMd5 = md5(readFileSync(dataPath, 'utf8'));
    if (dataMd5 === newMap[f]) continue;
    const oldExpected = oldMap[f];
    const oldHashes = Array.isArray(oldExpected) ? oldExpected : [oldExpected];
    if (oldHashes.includes(dataMd5)) {
      autoUpdatable.push(f);
    } else {
      customized.push(f);
    }
  }
  return { autoUpdatable, customized };
};

const stageDrift = collectDrift({
  sampleSubdir: ['prompts', 'stages'],
  dataSubdir:   ['prompts', 'stages'],
  files: stageTable.files,
  oldMap: stageTable.oldMap,
  newMap: stageTable.newMap,
});
const partialDrift = collectDrift({
  sampleSubdir: ['prompts', '_partials'],
  dataSubdir:   ['prompts', '_partials'],
  files: partialTable.files,
  oldMap: partialTable.oldMap,
  newMap: partialTable.newMap,
});

const autoUpdatable = [
  ...stageDrift.autoUpdatable.map((f) => ({ file: f, relDir: 'data/prompts/stages' })),
  ...partialDrift.autoUpdatable.map((f) => ({ file: f, relDir: 'data/prompts/_partials' })),
];
const customized = [
  ...stageDrift.customized.map((f) => ({ file: f, relDir: 'data/prompts/stages', referenceDir: 'data.reference/prompts/stages' })),
  ...partialDrift.customized.map((f) => ({ file: f, relDir: 'data/prompts/_partials', referenceDir: 'data.reference/prompts/_partials' })),
];

if (autoUpdatable.length > 0) {
  console.warn(
    `\n⚠️  ${autoUpdatable.length} pipeline prompt(s) have a pending migration — run \`npm run migrations\` to auto-update:\n` +
    autoUpdatable.map(({ file, relDir }) => `   • ${relDir}/${file}`).join('\n') + '\n',
  );
}

if (customized.length > 0) {
  console.warn(
    `\n⚠️  ${customized.length} pipeline prompt(s) are customized and cannot be auto-updated.\n` +
    `   Manually merge the new template variables into each file:\n` +
    customized.map(({ file, relDir, referenceDir: sd }) =>
      `   • ${relDir}/${file}\n` +
      `     Compare with: ${sd}/${file}`,
    ).join('\n') + '\n',
  );
}
