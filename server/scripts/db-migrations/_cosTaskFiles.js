/**
 * Where an install kept its CoS task queues before they moved into `cos_tasks`,
 * resolved exactly as the retired Markdown reader did: the configured
 * `userTasksFile` / `cosTasksFile` (relative to the checkout root) when the
 * install's CoS config sets one, else `data/TASKS.md` / `data/COS-TASKS.md`.
 * Shared by migrations 018 (import) and 019 (retire), which must agree.
 */
import { dirname, isAbsolute, join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { readCosConfig } from '../../../scripts/migrations/_lib.js';

const QUEUES = [
  { source: 'user', configKey: 'userTasksFile', fallback: 'data/TASKS.md' },
  { source: 'internal', configKey: 'cosTasksFile', fallback: 'data/COS-TASKS.md' },
];

/** `[{ source, path }]` for both queues, whether or not the files exist. */
export async function resolveCosTaskFiles() {
  // config.json lives under the install's data root, which is not always the checkout root.
  const config = await readCosConfig({ rootDir: dirname(PATHS.data), label: 'CoS task import' });
  return QUEUES.map(({ source, configKey, fallback }) => {
    const configured = typeof config[configKey] === 'string' && config[configKey].trim() ? config[configKey].trim() : fallback;
    return { source, path: isAbsolute(configured) ? configured : join(PATHS.root, configured) };
  });
}
