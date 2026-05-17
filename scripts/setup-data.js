#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, rmdirSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const sampleDir = join(rootDir, 'data.sample');

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

// Drift detection — warn when a data.sample/prompts/stages/*.md differs from
// the installed data/prompts/stages/*.md copy. Only fires on existing installs
// (fresh installs already got a full copy above). Prompt templates drift when
// a PortOS update adds new template variables (e.g. {{lengthTargets.*}}) that
// existing installs won't pick up because setup-data.js only copies *missing*
// files.
//
// NOTE: only the files managed by scripts/migrations/003+ are checked here —
// scanning all stage prompts would produce misleading warnings for prompts
// that have no migration counterpart (e.g. cd-evaluate.md, writers-room prompts).
//
// Mirror scripts/migrations/003+ NEW/OLD hashes. Array values let the check
// recognize multi-migration lineages (file evolved through 003 → 004 → 005);
// a user at any intermediate hash still gets the "run migrations" prompt.
const SHIPPED_PROMPT_OLD_MD5 = {
  // idea-expansion: aee… (pre-003) and 41fa… (post-003, pre-004) both
  // auto-updatable to the post-004 hash.
  'pipeline-idea-expansion.md': ['aee25112b2c596f643b17c559b772c22', '41facefbc0c0549d456bef9111f95ab9'],
  'pipeline-prose.md':          'bfea5aeeb471aae9749baee765b473a7',
  // comic-script: 40e5fd… (pre-003) and beab03… (post-003, pre-011) both
  // auto-updatable to the post-011 (back-cover) hash.
  'pipeline-comic-script.md':   ['40e5fdc1a1e68a7419b7dad936366c1a', 'beab031951859ca13579cdb9c4dbe769'],
  'pipeline-teleplay.md':       '3f6fecc25573ed054b47db392250034a',
  // season-episodes: 6e349a… (pre-003) and c4928e… (post-003, pre-005) both
  // auto-updatable to the post-005 (shape-aware) hash.
  'pipeline-season-episodes.md': ['6e349ad26bed8a0ccb042571f03f03eb', 'c4928e2a5f833358116b29d2d669888d'],
  // Shape-aware additions (migration 005).
  'pipeline-arc-overview.md':    '6a3ecab43d1f46b7ef9aab6c69ea0326',
  'pipeline-arc-verify.md':      '52e31abc93e3105176236fcaa5d1575a',
  'pipeline-volume-verify.md':   'c6ea28e972ad6e229bafb2d602b4dda3',
  'pipeline-arc-resolve.md':     '87bc5c01f1a8a97b681727a38b05edc6',
  // Shot decomposition additions (migration 006).
  'pipeline-extract-scenes.md':  '59fa5ee305ce53d91eb15224d8b546d3',
  // INT/EXT + time-of-day additions to the places extractor (migration 007).
  'writers-room-places.md':      '7f1f80eb63d67a21161994cde115045e',
  // CoS agent prompt: drop obsolete "# Chief of Staff Agent Briefing" header
  // and "You are an autonomous agent…" preamble (migration 009). Every
  // historical shipped hash is auto-updatable to the new sample.
  'cos-agent-briefing.md': [
    '699d053875472df455258724a0162bd5',
    '181b26838e526427173e4dccfc884d01',
    '3e1ca7f7b14b799f89a193c568003624',
    'af73fd50d6f29d561772474c12346e53',
    '9bcd3a0167dd4aed7cfff7f404494dfb',
    'd761133753da290a0c02eca1c87709e4',
  ],
};
const SHIPPED_PROMPT_NEW_MD5 = {
  'pipeline-idea-expansion.md': '1ee44cf95851ff8debf18729ebcd40b4',
  'pipeline-prose.md':          '30ac30ec2b9d3e2a9eb869c181732cc6',
  'pipeline-comic-script.md':   '1e0af305c27d0c80c4b482d2ebcb4a0d',
  'pipeline-teleplay.md':       '376f779f4687b598f1c92ca4e770fd5a',
  'pipeline-season-episodes.md':'50c68a29c3ebc275db3095d06bd87100',
  'pipeline-arc-overview.md':   'd34d72b8e49ba303d38607845dd87f1c',
  'pipeline-arc-verify.md':     'ff56d8387162017e08d5d0491060ddd6',
  'pipeline-volume-verify.md':  '03f3c874cb80e1c98abcf03168fa7a92',
  'pipeline-arc-resolve.md':    'a8677bbe1eb38f871fb152a5b0fec7c6',
  'pipeline-extract-scenes.md': 'c51fb208568d0d903eb43b437478b0ba',
  'writers-room-places.md':     '24a33628cc94d80fa5ca60831d973daf',
  'cos-agent-briefing.md':      'dccb392a43cbd3dac900fee12c31619a',
};
const SHIPPED_PROMPT_FILES = Object.keys(SHIPPED_PROMPT_OLD_MD5);

const sampleStagesDir = join(sampleDir, 'prompts', 'stages');
const dataStagesDir   = join(dataDir,   'prompts', 'stages');
if (existsSync(sampleStagesDir) && existsSync(dataStagesDir)) {
  const md5 = (s) => {
    const normalized = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return createHash('md5').update(normalized).digest('hex');
  };

  const autoUpdatable = [];
  const customized    = [];

  for (const f of SHIPPED_PROMPT_FILES) {
    const dataPath = join(dataStagesDir, f);
    if (!existsSync(dataPath)) continue; // missing files handled above
    const dataMd5 = md5(readFileSync(dataPath, 'utf8'));
    if (dataMd5 === SHIPPED_PROMPT_NEW_MD5[f]) continue; // already up to date
    const oldExpected = SHIPPED_PROMPT_OLD_MD5[f];
    const oldHashes = Array.isArray(oldExpected) ? oldExpected : [oldExpected];
    if (oldHashes.includes(dataMd5)) {
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
