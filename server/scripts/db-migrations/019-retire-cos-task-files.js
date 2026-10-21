/**
 * Retire the Markdown task files and the config keys that pointed at them.
 *
 * Runs after 018 has committed (migrations apply in order, each in its own
 * transaction), so a task file is only ever set aside once its tasks are rows.
 * Each file is renamed to `<name>.imported`, never deleted: that is the recovery
 * copy, and nothing reads it. The two config keys are dropped from the CoS config
 * because nothing reads them either. Both steps do nothing when there is nothing
 * to do, so a re-run (or a fresh install) is a no-op.
 */
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { readJsonOrNull, writeJsonAtomic } from '../../../scripts/migrations/_lib.js';
import { resolveCosTaskFiles } from './_cosTaskFiles.js';

const RETIRED_KEYS = ['userTasksFile', 'cosTasksFile'];

async function setAsideFile(path) {
  if (!existsSync(path)) return false;
  const target = existsSync(`${path}.imported`) ? `${path}.imported-${Date.now()}` : `${path}.imported`;
  await rename(path, target);
  return true;
}

// config.json is the config; a legacy state.json nests it under `config`.
async function dropRetiredKeys() {
  for (const [name, pick] of [['config.json', (doc) => doc], ['state.json', (doc) => doc?.config]]) {
    const path = join(PATHS.cos, name);
    const doc = await readJsonOrNull(path);
    const config = doc && pick(doc);
    if (!config || typeof config !== 'object' || !RETIRED_KEYS.some((key) => key in config)) continue;
    for (const key of RETIRED_KEYS) delete config[key];
    await writeJsonAtomic(path, doc);
  }
}

export async function up() {
  let setAside = 0;
  // Resolve the paths BEFORE dropping the keys that name them.
  for (const { path } of await resolveCosTaskFiles()) {
    if (await setAsideFile(path)) setAside++;
  }
  await dropRetiredKeys();
  if (setAside > 0) console.log(`🗄️ CoS tasks: set aside ${setAside} Markdown task file(s) as *.imported`);
}
