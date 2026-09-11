/** Explicit, dry-run-first recovery for premature legacy import markers.
 * Reuses the importers' INSERT mappings; never changes markers or source files.
 */
import { readdir } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { PATHS } from '../lib/fileUtils.js';
import { query, close } from '../lib/db.js';
import { legacyDirectory, readLegacyJSON } from './legacyImport.js';
import { importRecord as importSeries } from './migrateSeriesToDB.js';
import { importRecord as importIssue } from './migrateIssuesToDB.js';
import { importRecord as importStory } from './migrateStoryBuilderToDB.js';
import { importRecord as importUniverse, importRun } from './migrateUniversesToDB.js';
import { importWork, importFolder, importExercise } from './migrateWritersRoomToDB.js';

const TABLE_KINDS = {
  pipeline_series: 'series', pipeline_issues: 'issue', story_builder_sessions: 'story',
  universes: 'universe', universe_runs: 'run', writers_room_works: 'work',
  writers_room_draft_versions: 'draft', writers_room_folders: 'folder', writers_room_exercises: 'exercise',
};

export function parseRecoveryArgs(args) {
  const options = { apply: false, selections: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--apply') options.apply = true;
    else if (args[i] === '--id' && args[i + 1]) options.selections.push(args[++i]);
    else throw new Error('Usage: node server/scripts/recoverLegacyImports.js [--id kind:record-id ...] [--apply]');
  }
  return options;
}

export async function recoverLegacyImports({ apply = false, selections = [] } = {}) {
  const selected = new Set(selections);
  for (const key of selected) {
    const colon = key.indexOf(':');
    if (colon < 1 || !Object.values(TABLE_KINDS).includes(key.slice(0, colon)) || !key.slice(colon + 1).trim()) {
      throw new Error('Recovery selections must be kind:record-id');
    }
  }
  if (apply && !selected.size) throw new Error('Recovery application requires explicit --id selections');
  const results = [];
  const seen = new Set();
  const encountered = new Set();
  let sourcePath;
  // Table identifiers are accepted ONLY from our fixed mapping, never from disk
  // or CLI input. Dry-run uses SELECT only, including nested work draft rows.
  const execute = async (sql, params) => {
    const table = /INSERT INTO (\w+)/.exec(sql)?.[1];
    const kind = TABLE_KINDS[table];
    if (!kind) throw new Error('Unsupported legacy recovery table');
    const key = `${kind}:${params[0]}`;
    if (selected.size && !selected.has(key)) return { rowCount: 0 };
    encountered.add(key);
    if (seen.has(key)) return { rowCount: 0 };
    seen.add(key);
    const existing = await query(`SELECT id FROM ${table} WHERE id = $1`, [params[0]]);
    let status = existing.rows.length ? 'exists' : 'missing';
    if (apply && status === 'missing') status = (await query(sql, params)).rowCount ? 'inserted' : 'exists';
    results.push({ key, status, source: relative(PATHS.data, sourcePath) });
    return { rowCount: status === 'inserted' ? 1 : 0 };
  };
  const read = async path => {
    const source = await readLegacyJSON(path);
    if (source.status === 'invalid') results.push({ status: 'invalid-source', source: relative(PATHS.data, path) });
    return source;
  };
  const mapSource = async (path, mapper, array = false) => {
    const source = await read(path);
    if (source.status !== 'valid') return;
    if (array && !Array.isArray(source.value)) {
      results.push({ status: 'invalid-source', source: relative(PATHS.data, path) });
      return;
    }
    sourcePath = path;
    for (const record of array ? source.value : [source.value]) {
      if (await mapper(record, execute) === null) results.push({ status: 'invalid-record', source: relative(PATHS.data, path) });
    }
  };
  for (const [domain, mapper] of [
    ['pipeline-series', importSeries], ['pipeline-issues', importIssue],
    ['story-builder', importStory], ['universes', importUniverse],
  ]) {
    // Prefer a repaired canonical source over a parked historical copy.
    for (const dir of [domain, `${domain}.imported`]) {
      const root = join(PATHS.data, dir);
      if (!await legacyDirectory(root)) continue;
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        for (const filename of ['index.json', 'index.json.imported']) {
          await mapSource(join(root, entry.name, filename), mapper);
        }
      }
      if (domain === 'universes') {
        const path = join(root, 'index.json');
        const source = await read(path);
        if (source.status === 'valid' && Array.isArray(source.value)) results.push({ status: 'invalid-source', source: relative(PATHS.data, path) });
        if (source.status === 'valid') {
          const runs = source.value?.config?.runs;
          if (runs !== undefined && !Array.isArray(runs)) results.push({ status: 'invalid-source', source: relative(PATHS.data, path) });
          sourcePath = path;
          for (const run of Array.isArray(runs) ? runs : []) {
            if (await importRun(run, execute) === null) results.push({ status: 'invalid-record', source: relative(PATHS.data, path) });
          }
        }
      }
    }
  }
  const root = join(PATHS.data, 'writers-room');
  if (await legacyDirectory(root)) {
    for (const [name, mapper] of [['folders', importFolder], ['exercises', importExercise]]) {
      for (const suffix of ['.json', '.imported.json']) await mapSource(join(root, `${name}${suffix}`), mapper, true);
    }
    const works = join(root, 'works');
    if (await legacyDirectory(works)) {
      for (const entry of await readdir(works, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^wr-work-[0-9a-f-]+$/i.test(entry.name)) continue;
        for (const filename of ['manifest.json', 'manifest.imported.json']) await mapSource(join(works, entry.name, filename), importWork);
      }
    }
  }
  for (const key of selected) if (!encountered.has(key)) results.push({ key, status: 'not-found' });
  return { mode: apply ? 'apply' : 'dry-run', results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  Promise.resolve().then(() => recoverLegacyImports(parseRecoveryArgs(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(`❌ Legacy recovery failed: ${error.message}`); process.exitCode = 1; })
    .finally(close);
}
