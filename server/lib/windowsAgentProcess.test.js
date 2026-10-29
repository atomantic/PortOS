import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DISPOSABLE_ROOT_MARKER } from './dataRoot.js';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots, ownTestBodies } from './mockPathsDataRoot.js';

vi.mock('./fileUtils.js', async original => {
  const root = lazyTempDataRoot('windows-agent-proof-');
  return makePathsProxy(await original(), { dataRoot: () => join(root, 'data') });
});
import { PATHS } from './fileUtils.js';
import { spawn, execFile } from './childProcess.js';
import { killProcessTree, prepareCliSpawn } from './bufferedSpawn.js';
import { readWindowsAgentSettlement, reserveWindowsAgentProcess, prepareWindowsAgentLaunch, watchWindowsAgentProcess } from './windowsAgentProcess.js';

const { it, drain } = ownTestBodies(vitestIt);
afterAll(async () => { await drain(); await cleanupTempDataRoots(); });
let agent, root, owner;
beforeEach(async () => {
  await drain();
  agent = { id: `agent-${randomUUID()}`, taskId: 'example-task', startedAt: new Date(Date.now() - 1000).toISOString() };
  root = join(PATHS.cos, 'process-settlement', agent.id);
  owner = { version: 1, agentId: agent.id, taskId: agent.taskId, startedAt: agent.startedAt, nonce: randomUUID() };
});

async function proof() {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'owner.json'), JSON.stringify({ owner, executable: 'example-supervisor.exe' }));
  await writeFile(join(root, 'launch.json'), JSON.stringify({ owner }));
  const started = { owner, pid: 123, created: '123456789' };
  await writeFile(join(root, 'started.json'), JSON.stringify(started));
  const receipt = { ...started, version: 1, active: 0, exitCode: 0, settledAt: new Date().toISOString() };
  await writeFile(join(root, 'settled.json'), JSON.stringify(receipt));
  return receipt;
}

it('recovers a complete durable receipt and rejects reused agent/start, nonce and PID identities', async () => {
  const receipt = await proof();
  expect(await readWindowsAgentSettlement(agent)).toEqual(receipt);
  await expect(readWindowsAgentSettlement({ ...agent, startedAt: new Date(0).toISOString() })).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
  for (const update of [{ pid: 124 }, { created: '999' }, { owner: { ...owner, nonce: randomUUID() } }, { active: 1 }, { settledAt: new Date(Date.now() + 60000).toISOString() }]) {
    await writeFile(join(root, 'settled.json'), JSON.stringify({ ...receipt, ...update }));
    await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
  }
});

it('retains missing and unreadable proof rather than treating registry absence as settlement', async () => {
  await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'reservation-missing' });
  await proof();
  await writeFile(join(root, 'started.json'), '{');
  await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'started-invalid' });
});

it('reports allowlisted supervisor failure diagnostics without letting them stand in for a receipt', async () => {
  await proof();
  await rm(join(root, 'settled.json'));
  await writeFile(join(root, 'failure.json'), JSON.stringify({ version: 1, stage: 'root-exit', code: 258 }));
  const error = await readWindowsAgentSettlement(agent).catch(value => value);
  expect(error).toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'receipt-missing', supervisorStage: 'root-exit', supervisorCode: 258 });
  expect(error.message).toBe('Windows agent process settlement is unverified (receipt-missing; supervisor root-exit 258)');
  // A record outside the allowlist contributes nothing to the message.
  await writeFile(join(root, 'failure.json'), JSON.stringify({ version: 1, stage: 'example-unlisted', code: 1 }));
  const unlisted = await readWindowsAgentSettlement(agent).catch(value => value);
  expect(unlisted).not.toHaveProperty('supervisorStage');
  expect(unlisted.message).toBe('Windows agent process settlement is unverified (receipt-missing)');
});

async function waitForFile(file) {
  const deadline = Date.now() + 15000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('Native Windows agent proof did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform !== 'win32')('native Windows release-agent boundary', () => {
  it('withholds proof for a live parent and surviving detached descendant, then recovers settlement in a fresh reader', async () => {
    await reserveWindowsAgentProcess(agent);
    const script = join(root, 'example.cjs');
    const ready = join(root, 'child-ready');
    const parentRelease = join(root, 'parent-release');
    const childRelease = join(root, 'child-release');
    await writeFile(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv[2] !== 'child') {
  spawn(process.execPath, [__filename, 'child'], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}
const child = process.argv[2] === 'child';
if (child) fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
const timer = setInterval(() => { if (fs.existsSync(child ? ${JSON.stringify(childRelease)} : ${JSON.stringify(parentRelease)})) clearInterval(timer); }, 20);
setTimeout(() => process.exit(3), 20000).unref();`);
    const launch = prepareWindowsAgentLaunch(agent.id, process.execPath, [script], { cwd: root, env: process.env });
    const child = watchWindowsAgentProcess(spawn(launch.command, launch.args, { cwd: root, stdio: 'pipe' }), launch);
    const closed = once(child, 'close');
    try {
      await waitForFile(join(root, 'started.json'));
      await waitForFile(ready);
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
      await writeFile(parentRelease, 'release');
      // The descendant acknowledges that its parent really exited, avoiding a sleep.
      const started = JSON.parse(await readFile(join(root, 'started.json'), 'utf8'));
      await vi.waitFor(() => expect(() => process.kill(started.pid, 0)).toThrow(), { timeout: 5000 });
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED' });
      expect(() => prepareWindowsAgentLaunch(agent.id, process.execPath, [], { cwd: root, env: process.env })).toThrow();
      await writeFile(childRelease, 'release');
      expect((await closed)[0]).toBe(0);
      const receipt = await readWindowsAgentSettlement(agent);
      expect(receipt.active).toBe(0);
      const moduleUrl = pathToFileURL(join(import.meta.dirname, 'windowsAgentProcess.js')).href;
      // Without the marker, a reader launched from a CoS worktree ignores the pin.
      await writeFile(join(dirname(PATHS.data), DISPOSABLE_ROOT_MARKER), 'test fixture');
      const reader = `import { readWindowsAgentSettlement } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(await readWindowsAgentSettlement(JSON.parse(process.argv[1]))));`;
      const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', reader, JSON.stringify(agent)], {
        env: { ...process.env, PORTOS_DATA_ROOT: dirname(PATHS.data) }, timeout: 5000,
      });
      expect(JSON.parse(result.stdout)).toEqual(receipt);
    } finally { killProcessTree(child); await closed; }
  }, 30000);

  it('cancels the exact Job, persists descendant settlement and preserves a neighboring process', async () => {
    await reserveWindowsAgentProcess(agent);
    const launch = prepareWindowsAgentLaunch(agent.id, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env: process.env });
    const child = watchWindowsAgentProcess(spawn(launch.command, launch.args, { cwd: root, stdio: 'pipe' }), launch);
    const closed = once(child, 'close');
    const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'pipe' });
    const neighborClosed = once(neighbor, 'close');
    try {
      await waitForFile(join(root, 'started.json'));
      killProcessTree(child, 'SIGKILL');
      await closed;
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0, exitCode: 1 });
      expect(() => process.kill(neighbor.pid, 0)).not.toThrow();
    } finally { killProcessTree(child); neighbor.kill(); await Promise.all([closed, neighborClosed]); }
  }, 30000);
  it('preserves a ConPTY interaction and records tree settlement after Ctrl+C', async () => {
    const pty = await import('node-pty');
    await reserveWindowsAgentProcess(agent);
    const script = join(root, 'pty.cjs');
    await writeFile(script, String.raw`process.stdout.write('EXAMPLE_READY\n'); process.stdin.on('data', () => process.stdout.write('EXAMPLE_INPUT\n')); setInterval(()=>{},1000);`);
    const launch = prepareWindowsAgentLaunch(agent.id, process.execPath, [script], { cwd: root, env: process.env, pty: true });
    const child = watchWindowsAgentProcess(pty.spawn(launch.command, launch.args, { cwd: root, env: process.env, cols: 80, rows: 24 }), launch);
    const closed = new Promise(resolve => child.onExit(resolve));
    let output = '';
    child.onData(data => { output += data; });
    try {
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_READY'), { timeout: 15000 });
      child.write('example\r');
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_INPUT'), { timeout: 5000 });
      child.write('\x03');
      await closed;
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0 });
    } finally { child.kill(); await closed; }
  }, 30000);

  it('retains the hold after supervisor loss even when the owned Job has been terminated', async () => {
    await reserveWindowsAgentProcess(agent);
    const launch = prepareWindowsAgentLaunch(agent.id, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env: process.env });
    const child = spawn(launch.command, launch.args, { cwd: root, stdio: 'pipe' });
    const nativeKill = child.kill.bind(child);
    watchWindowsAgentProcess(child, launch);
    const closed = once(child, 'close');
    try {
      await waitForFile(join(root, 'started.json'));
      nativeKill('SIGKILL');
      await closed;
      // A killed supervisor leaves no failure record: loss stays distinct from a failed stage.
      const error = await readWindowsAgentSettlement(agent).catch(value => value);
      expect(error).toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'receipt-missing' });
      expect(error).not.toHaveProperty('supervisorStage');
    } finally { nativeKill('SIGKILL'); await closed; }
  }, 30000);

  it('preserves the shared cmd-shim escaping and quote-bearing argv bypass inside the native Job', async () => {
    const shimDir = join(root, 'CLI shim with spaces');
    await mkdir(shimDir, { recursive: true });
    const shim = join(shimDir, 'example-cli.cmd');
    await writeFile(join(shimDir, 'args.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    await writeFile(shim, [
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe" "%~dp0\\args.cjs" %*',
      ') ELSE (',
      '  node "%~dp0\\args.cjs" %*',
      ')', '',
    ].join('\r\n'));
    const cases = [['with space', 'a&b', 'c^d'], ['with space', 'say "hello"', 'line\nbreak', '%EXAMPLE_UNSET% & literal']];
    for (const [index, args] of cases.entries()) {
      const run = { ...agent, id: `${agent.id}-${index}` };
      await reserveWindowsAgentProcess(run);
      const prepared = prepareCliSpawn(shim, args, process.env);
      if (index === 0) expect(prepared.command).toBe('cmd.exe');
      else expect(prepared.command).not.toBe('cmd.exe');
      const launch = prepareWindowsAgentLaunch(run.id, prepared.command, prepared.args, { cwd: root, env: process.env });
      const child = watchWindowsAgentProcess(spawn(launch.command, launch.args, { cwd: root, stdio: 'pipe' }), launch);
      const closed = once(child, 'close');
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      try {
        expect((await closed)[0]).toBe(0);
        expect(JSON.parse(output)).toEqual(args);
        expect(await readWindowsAgentSettlement(run)).toMatchObject({ active: 0, exitCode: 0 });
      } finally { killProcessTree(child); await closed; }
    }
  }, 30000);

  it('rejects NUL argv before reserving a launch and at the native serialization boundary', async () => {
    await reserveWindowsAgentProcess(agent);
    const invalid = ['-e', 'process.stdout.write("unexpected")', 'value\0suffix'];
    expect(() => prepareWindowsAgentLaunch(agent.id, process.execPath, invalid, { cwd: root, env: process.env })).toThrow(TypeError);
    expect(existsSync(join(root, 'launch.json'))).toBe(false);
    const launch = prepareWindowsAgentLaunch(agent.id, process.execPath, ['-e', 'process.stdout.write("unexpected")'], { cwd: root, env: process.env });
    const spec = JSON.parse(await readFile(launch.args[0], 'utf8'));
    await writeFile(launch.args[0], JSON.stringify({ ...spec, args: invalid }));
    const child = watchWindowsAgentProcess(spawn(launch.command, launch.args, { cwd: root, stdio: 'pipe' }), launch);
    const closed = once(child, 'close');
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    try {
      expect((await closed)[0]).toBe(1);
      expect(output).toBe('');
      expect(existsSync(join(root, 'started.json'))).toBe(false);
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'started-missing', supervisorStage: 'launch', supervisorCode: 0 });
    } finally { killProcessTree(child); await closed; }
  }, 30000);

});
