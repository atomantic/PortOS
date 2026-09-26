import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

const writeJsonAtomic = (path, value) => {
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmpPath, path);
};

/**
 * Add missing starter entries to an installed JSON document without replacing
 * custom values. A present but malformed merge map is preserved as-is.
 *
 * `seededKeys` is the list of starter keys a previous run already offered for
 * this target (from the setup-data seed ledger). A key in that list that is
 * missing from the installed map was deleted by the user and stays deleted.
 * Omit it (no ledger entry yet) to add every missing key — the one-time
 * bootstrap for installs that predate the ledger. On a successful merge the
 * result carries `sampleKeys` so the caller can record them in the ledger.
 */
export const mergeJsonStarter = ({ samplePath, dataPath, mergeKey, seededKeys, displayPath = dataPath, log = console.log }) => {
  if (!existsSync(samplePath) || !existsSync(dataPath)) return { status: 'missing', added: [] };

  let sample;
  let data;
  try {
    sample = JSON.parse(readFileSync(samplePath, 'utf8'));
    data = JSON.parse(readFileSync(dataPath, 'utf8'));
  } catch (err) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: ${err.message}`);
    return { status: 'invalid-json', added: [] };
  }

  if (!isPlainObject(sample)) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: expected a starter object document`);
    return { status: 'invalid-sample', added: [] };
  }
  const sampleEntries = sample[mergeKey];
  if (!isPlainObject(sampleEntries)) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: starter has no object at ${mergeKey}`);
    return { status: 'invalid-sample-map', added: [] };
  }
  if (!isPlainObject(data)) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: expected an object document`);
    return { status: 'invalid-document', added: [] };
  }

  const hasMap = Object.hasOwn(data, mergeKey);
  if (hasMap && !isPlainObject(data[mergeKey])) {
    log(`⚠️ Skipping JSON merge for ${displayPath}: ${mergeKey} is present but is not an object`);
    return { status: 'invalid-map', added: [] };
  }
  if (!hasMap) data[mergeKey] = {};

  const alreadyOffered = new Set(Array.isArray(seededKeys) ? seededKeys : []);
  const added = [];
  for (const [key, value] of Object.entries(sampleEntries)) {
    if (!Object.hasOwn(data[mergeKey], key) && !alreadyOffered.has(key)) {
      data[mergeKey][key] = value;
      added.push(key);
    }
  }
  if (added.length > 0) {
    writeJsonAtomic(dataPath, data);
    log(`📝 ${displayPath}: merged ${added.length} new ${mergeKey} ${added.length === 1 ? 'entry' : 'entries'} (${added.join(', ')})`);
  }
  return { status: 'merged', added, sampleKeys: Object.keys(sampleEntries) };
};

/**
 * Read the setup-data seed ledger: `{ "<relPath>": ["<key>", …] }`. A missing
 * or unreadable ledger reads as empty, so every target bootstraps; a target
 * whose entry is not a string array likewise has no entry.
 */
export const readSeedLedger = (ledgerPath, log = console.log) => {
  if (!existsSync(ledgerPath)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (err) {
    log(`⚠️ Ignoring unreadable seed ledger ${ledgerPath}: ${err.message}`);
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed)
    .filter(([, keys]) => Array.isArray(keys) && keys.every((key) => typeof key === 'string')));
};

/**
 * Merge every JSON starter target and record what each successful merge
 * offered in the seed ledger (written atomically, only when it changed). A
 * target that was skipped (missing or invalid) keeps its prior ledger entry.
 */
export const mergeJsonStarterTargets = ({ targets, referenceDir, dataDir, ledgerPath, log = console.log }) => {
  const ledger = readSeedLedger(ledgerPath, log);
  let changed = false;
  const results = {};
  for (const { relPath, mergeKey } of targets) {
    const result = mergeJsonStarter({
      samplePath: join(referenceDir, relPath),
      dataPath: join(dataDir, relPath),
      mergeKey,
      seededKeys: ledger[relPath],
      displayPath: relPath,
      log,
    });
    results[relPath] = result;
    if (result.status !== 'merged') continue;
    const prior = ledger[relPath] || [];
    const next = [...new Set([...prior, ...result.sampleKeys])];
    if (!ledger[relPath] || next.length !== prior.length) {
      ledger[relPath] = next;
      changed = true;
    }
  }
  if (changed) writeJsonAtomic(ledgerPath, ledger);
  return results;
};
