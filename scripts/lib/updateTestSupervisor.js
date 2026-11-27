import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run the real admission supervisor against a synthetic script and private data. */
export function installUpdateTestSupervisor(repo, { standalone = false, traceDir = null } = {}) {
  writeFileSync(join(repo, '.portos-disposable-root'), '');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  if (standalone) {
    const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
    const copied = new Set();
    const copyModule = source => {
      if (copied.has(source)) return;
      copied.add(source);
      const text = readFileSync(source, 'utf8');
      const target = join(repo, relative(sourceRoot, source));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      for (const match of text.matchAll(/^\s*(?:import|export)\s+[^;]*?from\s+['"](\.[^'"]+)['"]/gm)) copyModule(resolve(dirname(source), match[1]));
    };
    copyModule(join(sourceRoot, 'scripts/deferred-update.mjs'));
    copyModule(join(sourceRoot, 'scripts/lib/updateReservationRecovery.mjs'));
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ type: 'module' }));
    return;
  }
  const supervisor = new URL('../deferred-update.mjs', import.meta.url).href;
  const admission = new URL('../../server/lib/maintenanceAdmission.js', import.meta.url).href;
  const legacyActivity = new URL('./legacyUpdateActivity.mjs', import.meta.url).href;
  writeFileSync(join(repo, 'scripts/deferred-update.mjs'), `
import { runDeferredUpdate, enterUpdate, settleInterruptedUpdate } from ${JSON.stringify(supervisor)};
import { createMaintenanceAdmission } from ${JSON.stringify(admission)};
import { observedDatabaseRestoreProcess, snapshotLegacyProcesses } from ${JSON.stringify(legacyActivity)};
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const admission = createMaintenanceAdmission(${JSON.stringify(join(repo, 'data'))}, {
  assertWrite: path => { if (path !== ${JSON.stringify(join(repo, 'data/workflow-maintenance'))}) throw new Error('Unexpected fixture write'); },
});
const [command, id, pid, code] = process.argv.slice(2);
if (command === '--enter') enterUpdate(id, Number(pid), admission);
else if (command === '--terminal') admission.deferredUpdate.terminal(id, Number(pid), code === '0');
else if (command === '--stopped') await settleInterruptedUpdate(id, { admission, cwd: ${JSON.stringify(repo)},
  snapshot: async () => [{ pid: process.pid, command: 'node stopped', state: 'S' }], probeCwds: async () => new Map(), listeners: async () => [] });
else {
  const controller = new AbortController();
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  const traceDir = ${JSON.stringify(traceDir)};
  if (traceDir) process.on('exit', code => writeFileSync(join(traceDir, 'supervisor-exit'), String(code)));
  const launch = (cmd, args, options) => {
    const child = spawn(cmd, args, options);
    // Observe the same admission before finish() consumes the terminal record.
    child.once('close', (code, signal) => {
      let terminal = 'unreadable';
      try {
        const operation = admission.deferredUpdate.get().operation;
        terminal = operation?.id === options.env.PORTOS_DEFERRED_UPDATE_ID && operation.terminal ? operation.terminal.success : 'missing';
      } catch { /* Leave the real supervisor to handle the admission read failure. */ }
      writeFileSync(join(traceDir, 'inner-shell'), JSON.stringify({ code, signal, terminal }));
    });
    return child;
  };
  process.exitCode = await runDeferredUpdate({ admission, launch: traceDir ? launch : spawn, cwd: ${JSON.stringify(repo)}, signal: controller.signal,
    // Keep real updater process attribution, but keep unrelated PostgreSQL
    // restores (including the serial DB tests) out of this fixture's inventory.
    legacySnapshot: async platform => (await snapshotLegacyProcesses(platform))
      .filter(row => !observedDatabaseRestoreProcess([row])),
    observeWork: async () => existsSync(${JSON.stringify(join(repo, 'observed-running-work'))}) ? [{ kind: 'render:example', label: '1 render running', count: 1 }] : [],
    policy: command === '--interrupt' ? 'interrupt' : command === '--automatic' ? 'automatic' : 'manual' });
}
`);
}
