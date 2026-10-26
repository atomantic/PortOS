import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from './childProcess.js';

const compilerKey = Symbol.for('portos.windowsGitSupervisor');

// One private compiler result per Node process, including module reloads. Never
// execute a pre-existing cache binary, or compile into a checkout being mutated.
function supervisor() {
  let state = process[compilerKey];
  if (!state) {
    state = { active: new Set(), held: false };
    process[compilerKey] = state;
    state.ready = (async () => {
      const directory = await mkdtemp(join(tmpdir(), 'portos-git-supervisor-'));
      state.directory = directory;
      const executable = join(directory, 'supervisor.exe');
      const source = fileURLToPath(new URL('./windowsGitSupervisor.cs', import.meta.url));
      const { windowsPowerShell51Path } = await import('./processEnv.js');
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const script = `$ErrorActionPreference='Stop'; Add-Type -Path ${quote(source)} -ReferencedAssemblies System.Web.Extensions -OutputAssembly ${quote(executable)} -OutputType ConsoleApplication`;
      await new Promise((resolve, reject) => {
        const compiler = spawn(windowsPowerShell51Path(),
          ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: directory, stdio: 'ignore' });
        const timer = setTimeout(() => compiler.kill(), 15000);
        compiler.once('error', () => { clearTimeout(timer); reject(unavailable()); });
        compiler.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(unavailable()); });
      });
      return { directory, executable, state };
    })();
  }
  const exitKey = Symbol.for('portos.windowsGitSupervisorExit');
  if (!process[exitKey]) {
    process[exitKey] = true;
    process.once('exit', () => {
      const current = process[compilerKey];
      if (current?.directory && !current.active.size && !current.held) {
        try { rmSync(current.directory, { recursive: true, force: true }); } catch { /* preserve a locked resource */ }
      }
    });
  }
  // Vitest workers do not necessarily exit after a suite. Their existing
  // resource teardown invokes this without importing the Git dependency graph.
  globalThis.__portosGitSupervisorCleanup = async () => {
    await state.ready.catch(() => {});
    const directory = state.directory;
    if (state.active.size || state.held) throw Object.assign(new Error('Git work settlement is held'), { code: 'GIT_SETTLEMENT_HELD' });
    if (directory) await rm(directory, { recursive: true, force: true });
    if (process[compilerKey] === state) delete process[compilerKey];
    delete globalThis.__portosGitSupervisorCleanup;
  };
  return state.ready;
}

const unavailable = () => Object.assign(new Error('Windows Git containment unavailable'), { code: 'GIT_CONTAINMENT_UNAVAILABLE' });

/** Wire terminal listeners in the spawn tick, before sending the launch request. */
export function startGit(args, options, wire) {
  if (process.platform !== 'win32') { wire(spawn('git', args, options)); return; }
  return supervisor().then(async ({ directory, executable, state }) => {
    const commandDirectory = await mkdtemp(join(directory, 'command-'));
    const receipt = join(commandDirectory, 'settlement.json');
    const child = spawn(executable, [receipt], options);
    child.gitSupervisor = true;
    state.active.add(child);
    child.cancelOwnedGit = () => child.stdin.end('cancel\n');
    child.gitSettlement = new Promise(resolve => {
      child.once('close', () => {
        readFile(receipt, 'utf8').then(text => {
          const result = JSON.parse(text);
          if (typeof result.settled !== 'boolean' || typeof result.launched !== 'boolean'
            || !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 0xffffffff
            || !['settled', 'launch-failed', 'inspection-failed', 'termination-unconfirmed'].includes(result.reason)) throw unavailable();
          return result;
        }).catch(() => ({ settled: false, reason: 'supervisor-unconfirmed' }))
          .then(result => {
            state.active.delete(child);
            state.held ||= !result.settled && Boolean(child.pid);
            resolve(result);
            if (result.settled || !child.pid) return rm(commandDirectory, { recursive: true, force: true });
          })
          .catch(() => {});
      });
    });
    child.stdin.on('error', () => {}); // A racing supervisor exit is handled by its receipt.
    wire(child);
    child.stdin.write(`${JSON.stringify(args)}\n`);
  }).catch(() => { throw unavailable(); });
}
