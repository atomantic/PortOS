import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Run the real admission supervisor against a synthetic script and private data. */
export function installUpdateTestSupervisor(repo) {
  writeFileSync(join(repo, '.portos-disposable-root'), '');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  const supervisor = new URL('../deferred-update.mjs', import.meta.url).href;
  const admission = new URL('../../server/lib/maintenanceAdmission.js', import.meta.url).href;
  writeFileSync(join(repo, 'scripts/deferred-update.mjs'), `
import { runDeferredUpdate, enterUpdate } from ${JSON.stringify(supervisor)};
import { createMaintenanceAdmission } from ${JSON.stringify(admission)};
const admission = createMaintenanceAdmission(${JSON.stringify(join(repo, 'data'))}, {
  assertWrite: path => { if (path !== ${JSON.stringify(join(repo, 'data/workflow-maintenance'))}) throw new Error('Unexpected fixture write'); },
});
const [command, id, pid, code] = process.argv.slice(2);
if (command === '--enter') enterUpdate(id, Number(pid), admission);
else if (command === '--terminal') admission.deferredUpdate.terminal(id, Number(pid), code === '0');
else {
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  process.exitCode = await runDeferredUpdate({ admission, cwd: ${JSON.stringify(repo)}, signal: controller.signal });
}
`);
}
