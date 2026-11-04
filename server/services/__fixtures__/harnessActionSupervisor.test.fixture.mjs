import { spawn } from '../../lib/childProcess.js';
import { createMaintenanceAdmission } from '../../lib/maintenanceAdmission.js';
import { installHarnessActionShutdown, runHarnessActionSupervisor } from '../harnessActionSupervisor.js';

const admission = createMaintenanceAdmission(process.env.PORTOS_TEST_HARNESS_ROOT);
const ownerId = process.env.PORTOS_TEST_HARNESS_OWNER;
const input = { ownerId, runtime: 'opencode', action: 'update', reviewed: { identity: { path: '/fixture/cli' } } };
const grandchild = process.env.PORTOS_TEST_HARNESS_SHORT === '1'
  ? `process.stdout.write('READY\\n', () => process.exit(0));`
  : `process.on('SIGTERM', () => {});
process.stdout.write('READY\\n', () => process.stdout.destroy());
setInterval(() => {}, 1000);`;
const vendor = `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: false, stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => process.stdout.write('FIXTURE_VENDOR ' + child.pid + '\\n', () => process.exit(0)));`;
const shutdown = installHarnessActionShutdown({ graceMs: Number(process.env.PORTOS_TEST_HARNESS_GRACE_MS) || 300 });

async function main() {
  if (process.env.PORTOS_TEST_HARNESS_PAUSE === '1') {
    await new Promise(resolve => {
      process.once('message', resolve);
      process.send({ type: 'fixture-before-entry' });
    });
  }
  return runHarnessActionSupervisor(input, {
  admission, runtimeFor: () => ({ id: 'opencode' }), matchesReview: async () => true, signal: shutdown.signal,
  launch: (_id, options) => {
    if (options.detached !== false) throw new Error('The fixture must remain in the supervisor group.');
    return spawn(process.execPath, ['-e', vendor], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  },
  });
}

main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(shutdown.close);
