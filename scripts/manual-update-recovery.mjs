import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createMaintenanceJournal } from '../server/lib/maintenanceJournal.js';
import { continueManualUpdateRecovery } from './lib/manualUpdateRecovery.mjs';
import { isDirectlyInvoked } from './lib/directInvocation.js';

if (isDirectlyInvoked(import.meta.url)) {
  const [id, extra] = process.argv.slice(2);
  try {
    if (extra) throw new Error('Use the attempt shown on the manual update confirmation page.');
    const update = await continueManualUpdateRecovery({ id,
      root: resolve(fileURLToPath(new URL('..', import.meta.url))), directory: createMaintenanceJournal().directory,
      emit: (step, status, message) => console.log(`STEP:${step}:${status}:${message}`) });
    const result = await update.completion;
    process.exitCode = result.success ? 0 : 1;
  } catch (error) {
    console.error(`❌ Manual update did not complete: ${error.message}`);
    process.exitCode = 1;
  }
}
