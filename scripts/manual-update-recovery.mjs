import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createMaintenanceJournal } from '../server/lib/maintenanceJournal.js';
import { continueManualUpdateRecovery } from './lib/manualUpdateRecovery.mjs';
import { isDirectlyInvoked } from './lib/directInvocation.js';

export async function requestManualUpdate({ args = process.argv.slice(2),
  root = resolve(fileURLToPath(new URL('..', import.meta.url))), directory, launch,
  emit = (step, status, message) => console.log(`STEP:${step}:${status}:${message}`) } = {}) {
  const [id, extra] = args;
  if (extra) throw new Error('Use --request or the attempt shown on the manual update confirmation page.');
  if (id !== '--request') return continueManualUpdateRecovery({ id, root, directory: directory ?? createMaintenanceJournal().directory, launch, emit });
  const run = launch ?? (await import('../server/services/updateExecutor.js')).launchUpdate;
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const update = await run(`v${version}`, emit);
  if (!update.started) throw new Error(update.result?.errorMessage || 'The updater refused this request.');
  return update;
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    const update = await requestManualUpdate();
    const result = await update.completion;
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    console.error(`❌ Manual update did not complete: ${error.message}`);
    process.exitCode = 1;
  }
}
