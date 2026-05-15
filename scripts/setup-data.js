#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const sampleDir = join(rootDir, 'data.sample');

console.log('📁 Setting up data directory...');

if (!existsSync(dataDir)) {
  console.log('📁 Creating data directory from data.sample...');
  mkdirSync(dataDir, { recursive: true });
  cpSync(sampleDir, dataDir, { recursive: true });

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

  ensureSampleContent(sampleDir, dataDir);

  console.log('✅ Data directory already exists, ensured subdirectories and files');
}

// Merge new top-level entries from data.sample's structured JSON files into
// the user's existing copies, leaving customized entries untouched. Without
// this, only file-level "missing → copy" propagation runs above, so a new
// prompt stage or shared variable added to data.sample/prompts/ never
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
  const samplePath = join(sampleDir, relPath);
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

// Ensure migrations directory exists (not in data.sample, needed for both fresh and existing installs)
const migrationsDir = join(dataDir, 'migrations');
if (!existsSync(migrationsDir)) {
  console.log('📁 Creating missing directory: migrations');
  mkdirSync(migrationsDir, { recursive: true });
}

// Drift detection — warn when a data.sample/prompts/stages/*.md differs from
// the installed data/prompts/stages/*.md copy. Only fires on existing installs
// (fresh installs already got a full copy above). Prompt templates drift when
// a PortOS update adds new template variables (e.g. {{lengthTargets.*}}) that
// existing installs won't pick up because setup-data.js only copies *missing*
// files.
//
// NOTE: only the five files managed by data/migrations/003-update-pipeline-stage-prompts.js
// are checked here — scanning all stage prompts would produce misleading warnings for
// prompts that have no migration counterpart (e.g. cd-evaluate.md, writers-room prompts).
//
// Hash constants mirror data/migrations/003-update-pipeline-stage-prompts.js so we
// can distinguish three cases without importing that module:
//   • hash === OLD_SHIPPED_MD5 → auto-updatable, migration not yet applied
//   • hash === NEW_SHIPPED_MD5 → already up to date (migration applied or manual merge done)
//   • neither               → customized, needs manual merge
// Update these whenever 003 (or a successor migration) changes the hashes.
const PIPELINE_LENGTH_OLD_MD5 = {
  'pipeline-idea-expansion.md': 'aee25112b2c596f643b17c559b772c22',
  'pipeline-prose.md':          'bfea5aeeb471aae9749baee765b473a7',
  'pipeline-comic-script.md':   '40e5fdc1a1e68a7419b7dad936366c1a',
  'pipeline-tv-script.md':      '3f6fecc25573ed054b47db392250034a',
  'pipeline-season-episodes.md':'6e349ad26bed8a0ccb042571f03f03eb',
};
const PIPELINE_LENGTH_NEW_MD5 = {
  'pipeline-idea-expansion.md': '41facefbc0c0549d456bef9111f95ab9',
  'pipeline-prose.md':          '30ac30ec2b9d3e2a9eb869c181732cc6',
  'pipeline-comic-script.md':   'beab031951859ca13579cdb9c4dbe769',
  'pipeline-tv-script.md':      '376f779f4687b598f1c92ca4e770fd5a',
  'pipeline-season-episodes.md':'c4928e2a5f833358116b29d2d669888d',
};
const PIPELINE_LENGTH_PROMPTS = Object.keys(PIPELINE_LENGTH_OLD_MD5);

const sampleStagesDir = join(sampleDir, 'prompts', 'stages');
const dataStagesDir   = join(dataDir,   'prompts', 'stages');
if (existsSync(sampleStagesDir) && existsSync(dataStagesDir)) {
  const md5 = (s) => {
    const normalized = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return createHash('md5').update(normalized).digest('hex');
  };

  const autoUpdatable = [];
  const customized    = [];

  for (const f of PIPELINE_LENGTH_PROMPTS) {
    const dataPath = join(dataStagesDir, f);
    if (!existsSync(dataPath)) continue; // missing files handled above
    const dataMd5 = md5(readFileSync(dataPath, 'utf8'));
    if (dataMd5 === PIPELINE_LENGTH_NEW_MD5[f]) continue; // already up to date
    if (dataMd5 === PIPELINE_LENGTH_OLD_MD5[f]) {
      autoUpdatable.push(f);
    } else {
      customized.push(f);
    }
  }

  if (autoUpdatable.length > 0) {
    console.warn(
      `\n⚠️  ${autoUpdatable.length} pipeline stage prompt(s) have a pending migration — run \`npm run migrations\` to auto-update:\n` +
      autoUpdatable.map(f => `   • ${f}`).join('\n') + '\n',
    );
  }

  if (customized.length > 0) {
    console.warn(
      `\n⚠️  ${customized.length} pipeline stage prompt(s) are customized and cannot be auto-updated.\n` +
      `   Manually merge the new template variables into each file:\n` +
      customized.map(f =>
        `   • data/prompts/stages/${f}\n` +
        `     Compare with: data.sample/prompts/stages/${f}`,
      ).join('\n') + '\n',
    );
  }
}
