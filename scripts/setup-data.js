#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync, rmdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { md5 } from './migrations/_lib.js';

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
  // idea-expansion: aee… (pre-003), 41fa… (post-003, pre-004), and
  // 1ee44c… (post-004, pre-025) all auto-updatable to the post-025
  // (role/physicalDescription/personality/background plumbing) hash.
  'pipeline-idea-expansion.md': ['aee25112b2c596f643b17c559b772c22', '41facefbc0c0549d456bef9111f95ab9', '1ee44cf95851ff8debf18729ebcd40b4'],
  // prose: bfea5a… (pre-003) and 30ac30… (post-003, pre-027) both auto-
  // updatable to the post-027 ({{worldEntitiesSummary}}) hash.
  'pipeline-prose.md':          ['bfea5aeeb471aae9749baee765b473a7', '30ac30ec2b9d3e2a9eb869c181732cc6'],
  // comic-script: 40e5fd… (pre-003), beab03… (post-003, pre-011), and 1e0af3…
  // (post-011, pre-027) all auto-updatable to the post-027 ({{worldEntitiesSummary}}) hash.
  'pipeline-comic-script.md':   ['40e5fdc1a1e68a7419b7dad936366c1a', 'beab031951859ca13579cdb9c4dbe769', '1e0af305c27d0c80c4b482d2ebcb4a0d'],
  // teleplay: 3f6fec… (pre-027) auto-updatable to the post-027
  // ({{worldEntitiesSummary}}) hash. Original 376f77… is the post-027 prior.
  'pipeline-teleplay.md':       ['3f6fecc25573ed054b47db392250034a', '376f779f4687b598f1c92ca4e770fd5a'],
  // season-episodes: 6e349a… (pre-003) and c4928e… (post-003, pre-005) both
  // auto-updatable to the post-005 (shape-aware) hash.
  'pipeline-season-episodes.md': ['6e349ad26bed8a0ccb042571f03f03eb', 'c4928e2a5f833358116b29d2d669888d'],
  // arc-overview: 6a3eca… (pre-005) and d34d72… (post-005, pre-019) both
  // auto-updatable to the post-019 (worldCanonText) hash.
  'pipeline-arc-overview.md':   ['6a3ecab43d1f46b7ef9aab6c69ea0326', 'd34d72b8e49ba303d38607845dd87f1c'],
  // arc-verify: 52e31a… (pre-005) and ff56d8… (post-005, pre-019) both
  // auto-updatable to the post-019 (worldCanonText) hash.
  'pipeline-arc-verify.md':     ['52e31abc93e3105176236fcaa5d1575a', 'ff56d8387162017e08d5d0491060ddd6'],
  // volume-verify: c6ea28… (pre-005) and 03f3c8… (post-005, pre-019) both
  // auto-updatable to the post-019 (worldCanonText) hash.
  'pipeline-volume-verify.md':  ['c6ea28e972ad6e229bafb2d602b4dda3', '03f3c874cb80e1c98abcf03168fa7a92'],
  // arc-resolve: 87bc5c… (pre-005), a8677b… (post-005, pre-019), and
  // 8e348f… (post-019, pre-023) all auto-updatable to the post-023
  // (per-episode-synopsis anchor) hash.
  'pipeline-arc-resolve.md':    ['87bc5c01f1a8a97b681727a38b05edc6', 'a8677bbe1eb38f871fb152a5b0fec7c6', '8e348f3d1894382889f9f0ee7d5c6792'],
  // Shot decomposition additions (migration 006).
  'pipeline-extract-scenes.md':  '59fa5ee305ce53d91eb15224d8b546d3',
  // setting→place rename, migration 022. Two known auto-updatable hashes:
  // pre-019 (`7f1f80…`, INT/EXT addition) and pre-022 (`24a336…`, the
  // hash that was the NEW shipped before this rename). Both can be
  // auto-bumped to the post-rename shape.
  'writers-room-places.md':      ['7f1f80eb63d67a21161994cde115045e', '24a33628cc94d80fa5ca60831d973daf'],
  // universe-character-expand: pre-027 shipped, auto-updatable to the post-027
  // (`speechPattern` field added alongside `speechAccent`) hash.
  'universe-character-expand.md': ['ef109eb8e12ddb664c11c790271b5139'],
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
  'pipeline-idea-expansion.md': '1f3c5d077a5ef9a4b610335d5e3edd9c',
  'pipeline-prose.md':          'd1f8e3f1d214725b5aa67f309a81cd7d',
  'pipeline-comic-script.md':   '133d200d069c2e8173b7c129eea58f53',
  'pipeline-teleplay.md':       '1280ef6b1ad68fa44070ca7478ec2a5f',
  'pipeline-season-episodes.md':'50c68a29c3ebc275db3095d06bd87100',
  'pipeline-arc-overview.md':   '0a1f6ffa6908522e3690c5e9e53a6ee0',
  'pipeline-arc-verify.md':     '36aa70cdfc25d7549573a4d556e7702c',
  'pipeline-volume-verify.md':  '49458d36700cb94e34806d536ffe2940',
  'pipeline-arc-resolve.md':    '5b340885c6e8f8afc63424d6b5bc7eb7',
  'pipeline-extract-scenes.md': 'c51fb208568d0d903eb43b437478b0ba',
  'writers-room-places.md':     'a7f68e51dd6b4421d20f5bd9d855d9b4',
  'cos-agent-briefing.md':      'dccb392a43cbd3dac900fee12c31619a',
  'universe-character-expand.md':'67b6e73ed47f318451a730088b4cff14',
};
const SHIPPED_PROMPT_FILES = Object.keys(SHIPPED_PROMPT_OLD_MD5);

// Shared `_partials/*.md` fragments are mustache-rendered into multiple
// stage prompts (e.g. `bible-deference.md` is included by every stage
// that references both character + place bibles). They get their own
// drift table so the loop below scans them in parallel with stage
// prompts and warns the user when a migration's pending.
const SHIPPED_PARTIAL_OLD_MD5 = {
  // setting→place rename, migration 022.
  'bible-deference.md': '218f0e85643609ed85a12b1ccc7b5a8d',
};
const SHIPPED_PARTIAL_NEW_MD5 = {
  'bible-deference.md': 'a4681348c27776e414acf6e0be566a99',
};
const SHIPPED_PARTIAL_FILES = Object.keys(SHIPPED_PARTIAL_OLD_MD5);

// Walk one directory's worth of shipped prompt files against a hash table
// and partition them into auto-updatable (still on a known old hash) vs.
// customized (hash matches neither old nor new). Used twice — once for
// stage prompts, once for partial fragments.
const collectDrift = ({ sampleSubdir, dataSubdir, files, oldMap, newMap }) => {
  const sampleSubpath = join(sampleDir, ...sampleSubdir);
  const dataSubpath   = join(dataDir,   ...dataSubdir);
  if (!existsSync(sampleSubpath) || !existsSync(dataSubpath)) {
    return { autoUpdatable: [], customized: [] };
  }
  const autoUpdatable = [];
  const customized    = [];
  for (const f of files) {
    const dataPath = join(dataSubpath, f);
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
  files: SHIPPED_PROMPT_FILES,
  oldMap: SHIPPED_PROMPT_OLD_MD5,
  newMap: SHIPPED_PROMPT_NEW_MD5,
});
const partialDrift = collectDrift({
  sampleSubdir: ['prompts', '_partials'],
  dataSubdir:   ['prompts', '_partials'],
  files: SHIPPED_PARTIAL_FILES,
  oldMap: SHIPPED_PARTIAL_OLD_MD5,
  newMap: SHIPPED_PARTIAL_NEW_MD5,
});

const autoUpdatable = [
  ...stageDrift.autoUpdatable.map((f) => ({ file: f, relDir: 'data/prompts/stages' })),
  ...partialDrift.autoUpdatable.map((f) => ({ file: f, relDir: 'data/prompts/_partials' })),
];
const customized = [
  ...stageDrift.customized.map((f) => ({ file: f, relDir: 'data/prompts/stages', sampleDir: 'data.sample/prompts/stages' })),
  ...partialDrift.customized.map((f) => ({ file: f, relDir: 'data/prompts/_partials', sampleDir: 'data.sample/prompts/_partials' })),
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
    customized.map(({ file, relDir, sampleDir: sd }) =>
      `   • ${relDir}/${file}\n` +
      `     Compare with: ${sd}/${file}`,
    ).join('\n') + '\n',
  );
}
