/**
 * Retired-hash recognition for shipped prompt templates (#16090).
 *
 * `data.reference/prompts/shipped-hashes.json` records, for every shipped
 * `prompts/<subdir>/<file>.md`, the normalized md5 of its current body and
 * every body it has ever shipped with. An installed copy whose hash is in the
 * retired set is an untouched old shipped body, so `reconcileShippedPrompts`
 * (run by `scripts/run-migrations.js` after the numbered chain) replaces it
 * with the current reference body; any other hash is the user's own edit and
 * is left alone. A template edit therefore needs no numbered migration: edit
 * the `.md`, then run `node scripts/regen-shipped-prompt-hashes.js`, which
 * retires the outgoing hash. `server/test/guards/repo/shippedPromptHashes.test.js` fails on a
 * body changed without the regen and on any current or retired hash lost
 * since the comparison base: a dropped hash strands installs still holding it.
 *
 * The same pass also seeds what an install lacks, so a newly shipped template
 * needs no first-shipment migration either: when `data/prompts/` exists, every
 * table-listed prompt absent from it is copied from the reference, and every
 * `stages[key]` entry in the reference `stage-config.json` that the installed
 * config lacks is merged in (an existing entry is never touched). A missing
 * `data/prompts/` is a fresh install that `setup-data.js` populates.
 *
 * `prompts/skills/jobs/` is excluded: the autonomous-job store keeps its own
 * `.shipped` snapshot for those templates (`syncSkillTemplatesFromSample`).
 */
import { mkdir, readdir, readFile, stat } from 'fs/promises';
import { dirname, join } from 'path';

import { md5, readJsonOrNull, writeJsonAtomic, writeTextAtomic } from './_lib.js';

export const PROMPT_HASH_SUBDIRS = ['stages', '_partials', 'skills'];
export const SHIPPED_HASHES_RELPATH = 'prompts/shipped-hashes.json';
/** Per-install record of which shipped body each customized prompt was last warned about. */
export const CUSTOMIZED_NOTICES_RELPATH = 'shipped-prompt-notices.json';

export const shippedHashesPath = (rootDir) =>
  join(rootDir, 'data.reference', ...SHIPPED_HASHES_RELPATH.split('/'));

const promptKey = (subdir, name) => `${subdir}/${name}`;
const referencePath = (rootDir, key) => join(rootDir, 'data.reference', 'prompts', ...key.split('/'));
const installedPath = (rootDir, key) => join(rootDir, 'data', 'prompts', ...key.split('/'));

const readOptional = (path) => readFile(path, 'utf-8').catch((err) => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

/**
 * The committed table, `{}` when the file is absent (a synthetic test root or
 * a checkout predating it). A present but malformed table throws: silently
 * treating it as empty would classify every shipped body as customized.
 */
export async function readShippedHashes(rootDir) {
  const raw = await readOptional(shippedHashesPath(rootDir));
  if (raw === null) return {};
  const table = JSON.parse(raw);
  if (!table || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`${SHIPPED_HASHES_RELPATH} must be an object keyed by <subdir>/<file>.md`);
  }
  return table;
}

/** `{ key: md5 }` for every managed reference prompt body in this checkout. */
export async function readReferencePromptHashes(rootDir) {
  const hashes = {};
  for (const subdir of PROMPT_HASH_SUBDIRS) {
    const dir = join(rootDir, 'data.reference', 'prompts', subdir);
    const entries = await readdir(dir, { withFileTypes: true }).catch((err) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      hashes[promptKey(subdir, entry.name)] = md5(await readFile(join(dir, entry.name), 'utf-8'));
    }
  }
  return hashes;
}

/**
 * Advance the committed table to the live reference bodies. Pure: an entry
 * whose body changed retires its recorded hash; a new prompt gets an entry; a
 * prompt removed from `data.reference` retires its last hash and keeps the
 * history. Nothing is ever dropped, so the output only grows.
 */
export function advanceShippedHashes(committed, live) {
  const table = {};
  const retired = [];
  const added = [];
  for (const key of [...new Set([...Object.keys(committed), ...Object.keys(live)])].sort()) {
    const previous = committed[key] || {};
    const history = [...(previous.retired || [])];
    const retire = (hash) => {
      if (!hash || history.includes(hash)) return;
      history.push(hash);
      retired.push({ key, hash });
    };
    if (!(key in committed)) added.push(key);
    if (previous.current !== live[key]) retire(previous.current);
    table[key] = live[key] ? { current: live[key], retired: history } : { retired: history };
  }
  return { table, retired, added };
}

export const serializeShippedHashes = (table) => `${JSON.stringify(table, null, 2)}\n`;

/**
 * `'current'` (matches the live body), `'retired'` (an untouched older shipped
 * body: safe to replace) or `'customized'` (the user's own edit).
 */
const classifyInstalledPrompt = ({ installedHash, liveHash, retired = [] }) => {
  if (installedHash === liveHash) return 'current';
  return retired.includes(installedHash) ? 'retired' : 'customized';
};

/**
 * Classify every installed copy of a managed reference prompt without writing
 * anything. Prompts absent from `data/` are skipped: `setup-data.js` creates
 * them from the reference.
 */
export async function inspectInstalledPrompts(rootDir) {
  const table = await readShippedHashes(rootDir);
  const results = [];
  for (const key of Object.keys(table).sort()) {
    const reference = await readOptional(referencePath(rootDir, key));
    if (reference === null) continue;
    const installed = await readOptional(installedPath(rootDir, key));
    if (installed === null) continue;
    const liveHash = md5(reference);
    const state = classifyInstalledPrompt({ installedHash: md5(installed), liveHash, retired: table[key].retired });
    results.push({ key, state, liveHash, reference });
  }
  return results;
}

const STAGE_CONFIG_RELPATH = 'prompts/stage-config.json';

const isDirectory = (path) => stat(path).then((info) => info.isDirectory(), (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

/** Copy every table-listed reference prompt that `data/prompts/` lacks. */
async function seedMissingPrompts(rootDir) {
  const table = await readShippedHashes(rootDir);
  const seeded = [];
  for (const key of Object.keys(table).sort()) {
    if (!table[key].current) continue;
    const reference = await readOptional(referencePath(rootDir, key));
    if (reference === null) continue;
    if (await readOptional(installedPath(rootDir, key)) !== null) continue;
    await mkdir(dirname(installedPath(rootDir, key)), { recursive: true });
    await writeTextAtomic(installedPath(rootDir, key), reference);
    seeded.push(key);
    console.log(`✅ Seeded missing shipped prompt: data/prompts/${key}`);
  }
  return seeded;
}

/**
 * Merge reference `stages[key]` entries the installed config lacks, writing
 * once. An unreadable installed config is left alone: overwriting it would
 * discard the user's stage customizations.
 */
async function seedMissingStageConfig(rootDir) {
  const referenceRaw = await readOptional(join(rootDir, 'data.reference', ...STAGE_CONFIG_RELPATH.split('/')));
  if (referenceRaw === null) return [];
  const reference = JSON.parse(referenceRaw);
  const installedFile = join(rootDir, 'data', ...STAGE_CONFIG_RELPATH.split('/'));
  const installedRaw = await readOptional(installedFile);
  let installed = { stages: {} };
  if (installedRaw !== null) {
    try {
      installed = JSON.parse(installedRaw);
    } catch (err) {
      console.warn(`⚠️ data/${STAGE_CONFIG_RELPATH} is unreadable (${err.message}); stage entries were not seeded`);
      return [];
    }
  }
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) return [];
  const stages = installed.stages && typeof installed.stages === 'object' && !Array.isArray(installed.stages) ? installed.stages : {};
  const added = Object.keys(reference.stages || {}).filter((key) => !(key in stages)).sort();
  if (!added.length) return [];
  for (const key of added) stages[key] = reference.stages[key];
  await writeJsonAtomic(installedFile, { ...installed, stages });
  console.log(`📝 Seeded ${added.length} missing stage-config entr${added.length === 1 ? 'y' : 'ies'}: ${added.join(', ')}`);
  return added;
}

/**
 * Bring every untouched shipped prompt in `data/prompts/` up to the current
 * reference body. A customized copy is left alone and warned about once per
 * shipped body, so a boot-time pass does not repeat the same warning forever.
 */
export async function reconcileShippedPrompts({ rootDir }) {
  const installedPrompts = await isDirectory(join(rootDir, 'data', 'prompts'));
  const seeded = installedPrompts ? await seedMissingPrompts(rootDir) : [];
  const configAdded = installedPrompts ? await seedMissingStageConfig(rootDir) : [];
  const results = await inspectInstalledPrompts(rootDir);
  const updated = [];
  for (const { key, state, reference } of results) {
    if (state !== 'retired') continue;
    await writeTextAtomic(installedPath(rootDir, key), reference);
    updated.push(key);
    console.log(`✅ Updated unmodified shipped prompt: data/prompts/${key}`);
  }

  const customized = results.filter(({ state }) => state === 'customized');
  // The notice ledger only dedupes a warning, so it is best-effort: an
  // unreadable or unwritable ledger means warning again, never a failed run.
  const noticesPath = join(rootDir, 'data', CUSTOMIZED_NOTICES_RELPATH);
  const stored = await readJsonOrNull(noticesPath).catch(() => null);
  const notices = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const next = Object.fromEntries(customized.map(({ key, liveHash }) => [key, liveHash]));
  for (const { key, liveHash } of customized) {
    if (notices[key] === liveHash) continue;
    console.warn(
      `⚠️ data/prompts/${key} is customized and was not auto-updated; ` +
      `merge any changes you want from data.reference/prompts/${key}`,
    );
  }
  if (JSON.stringify(next) !== JSON.stringify(notices)) {
    await writeJsonAtomic(noticesPath, next).catch((err) => {
      console.log(`⏭️ Could not record customized-prompt notices (${err.code || err.message}); they will repeat next run`);
    });
  }

  if (updated.length) console.log(`📝 Shipped prompts: ${updated.length} updated, ${customized.length} customized left as-is`);
  return { updated, seeded, configAdded, customized: customized.map(({ key }) => key) };
}
