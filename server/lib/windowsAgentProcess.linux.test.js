import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots, ownTestBodies } from './mockPathsDataRoot.js';

vi.mock('./fileUtils.js', async original => {
  const root = lazyTempDataRoot('linux-agent-proof-');
  return makePathsProxy(await original(), { dataRoot: () => join(root, 'data') });
});
import { PATHS } from './fileUtils.js';
import { spawn } from './childProcess.js';
import { killProcessTree } from './bufferedSpawn.js';
import { readWindowsAgentSettlement, reserveWindowsAgentProcess, prepareWindowsAgentLaunch, watchWindowsAgentProcess } from './windowsAgentProcess.js';

const { it, drain } = ownTestBodies(vitestIt);
afterAll(async () => { await drain(); await cleanupTempDataRoots(); });
const newAgent = () => ({ id: `agent-${randomUUID()}`, taskId: 'example-task', startedAt: new Date(Date.now() - 1000).toISOString() });
const dir = run => join(PATHS.cos, 'process-settlement', run.id);
let agent, root;
beforeEach(async () => {
  await drain();
  agent = newAgent();
  root = dir(agent);
});

async function waitForFile(file) {
  const deadline = Date.now() + 15000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error('Linux agent proof did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Fields after the last ')': index 1 is ppid, index 3 is the session id.
const stat = pid => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');

function launch(run, command, args, options = {}) {
  const prepared = prepareWindowsAgentLaunch(run.id, command, args, { cwd: dir(run), env: process.env, ...options });
  const child = watchWindowsAgentProcess(spawn(prepared.command, prepared.args, { cwd: dir(run), stdio: 'pipe' }), prepared);
  return { prepared, child, closed: once(child, 'close') };
}

describe.skipIf(process.platform !== 'linux')('Linux subreaper release-agent boundary', () => {
  it('withholds proof while a setsid grandchild outlives the root, then settles after the whole tree exits', async () => {
    await reserveWindowsAgentProcess(agent);
    const script = join(root, 'example.cjs');
    const ready = join(root, 'child-ready');
    const parentRelease = join(root, 'parent-release');
    const childRelease = join(root, 'child-release');
    await writeFile(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = process.argv[2] === 'child';
if (child) fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
else spawn('setsid', [process.execPath, __filename, 'child'], { stdio: 'ignore' }).unref();
const timer = setInterval(() => { if (fs.existsSync(child ? ${JSON.stringify(childRelease)} : ${JSON.stringify(parentRelease)})) clearInterval(timer); }, 20);
setTimeout(() => process.exit(3), 20000).unref();`);
    const { prepared, child, closed } = launch(agent, process.execPath, [script]);
    expect(prepared.command).toMatch(/python3$/);
    try {
      await waitForFile(join(root, 'started.json'));
      await waitForFile(ready);
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'receipt-missing' });
      await writeFile(parentRelease, 'release');
      const started = JSON.parse(await readFile(join(root, 'started.json'), 'utf8'));
      await vi.waitFor(() => expect(alive(started.pid)).toBe(false), { timeout: 5000 });
      const grandchild = Number(await readFile(ready, 'utf8'));
      // The detached session escaped its parent, not the subreaper.
      expect(Number(stat(grandchild)[1])).toBe(child.pid);
      expect(stat(grandchild)[3]).not.toBe(stat(child.pid)[3]);
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'receipt-missing' });
      expect(() => prepareWindowsAgentLaunch(agent.id, process.execPath, [], { cwd: root, env: process.env })).toThrow();
      await writeFile(childRelease, 'release');
      expect((await closed)[0]).toBe(0);
      expect(alive(grandchild)).toBe(false);
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ owner: started.owner, pid: started.pid, created: started.created, active: 0, exitCode: 0 });
    } finally { killProcessTree(child); await closed; }
  }, 30000);

  it('cancels the tracked tree through the supervisor, escalating past a SIGTERM-ignoring descendant, and spares a neighbor', async () => {
    await reserveWindowsAgentProcess(agent);
    const ready = join(root, 'child-ready');
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const rootScript = `require('node:child_process').spawn('setsid', [process.execPath, '-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref(); setInterval(() => {}, 1000);`;
    const { child, closed } = launch(agent, process.execPath, ['-e', rootScript]);
    const neighbor = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const neighborClosed = once(neighbor, 'close');
    try {
      await waitForFile(ready);
      const grandchild = Number(await readFile(ready, 'utf8'));
      // A forced stop still reaches the supervisor as a cancellation request.
      killProcessTree(child, 'SIGKILL');
      expect((await closed)[0]).toBe(143);
      expect(alive(grandchild)).toBe(false);
      expect(alive(neighbor.pid)).toBe(true);
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0, exitCode: 143 });
    } finally { killProcessTree(child); neighbor.kill(); await Promise.all([closed, neighborClosed]); }
  }, 30000);

  it('honors a stop requested before the supervisor finished starting', async () => {
    await reserveWindowsAgentProcess(agent);
    const { child, closed } = launch(agent, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    killProcessTree(child);
    await closed;
    expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0 });
  }, 30000);

  it('preserves a PTY interaction and settles the tree when the terminal is closed', async () => {
    const pty = await import('node-pty');
    await reserveWindowsAgentProcess(agent);
    const script = join(root, 'pty.cjs');
    await writeFile(script, String.raw`process.stdout.write('EXAMPLE_READY\n'); process.stdin.on('data', () => process.stdout.write('EXAMPLE_INPUT\n')); setInterval(()=>{},1000);`);
    const prepared = prepareWindowsAgentLaunch(agent.id, process.execPath, [script], { cwd: root, env: process.env, pty: true });
    const child = watchWindowsAgentProcess(pty.spawn(prepared.command, prepared.args, { cwd: root, env: process.env, cols: 80, rows: 24 }), prepared);
    const closed = new Promise(resolve => child.onExit(resolve));
    let output = '';
    child.onData(data => { output += data; });
    try {
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_READY'), { timeout: 10000 });
      child.write('x\r');
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_INPUT'), { timeout: 10000 });
      child.kill();
      await closed;
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0 });
    } finally { child.kill(); await closed; }
  }, 30000);

  it('keeps helper-missing, lost-supervisor and transplanted receipts held', async () => {
    const path = process.env.PATH;
    const empty = join(PATHS.data, 'no-python');
    await mkdir(empty, { recursive: true });
    process.env.PATH = empty;
    try { await reserveWindowsAgentProcess(agent); } finally { process.env.PATH = path; }
    expect(prepareWindowsAgentLaunch(agent.id, process.execPath, ['-e', ''], { cwd: tmpdir(), env: process.env })).toEqual({ command: process.execPath, args: ['-e', ''] });
    await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ reason: 'reservation-missing' });

    const settled = newAgent();
    await reserveWindowsAgentProcess(settled);
    const { closed } = launch(settled, process.execPath, ['-e', '']);
    expect((await closed)[0]).toBe(0);
    await readWindowsAgentSettlement(settled);
    // A reserved launch whose supervisor never ran cannot borrow another run's proof.
    const lost = newAgent();
    await reserveWindowsAgentProcess(lost);
    prepareWindowsAgentLaunch(lost.id, process.execPath, ['-e', ''], { cwd: dir(lost), env: process.env });
    await expect(readWindowsAgentSettlement(lost)).rejects.toMatchObject({ reason: 'started-missing' });
    for (const name of ['started.json', 'settled.json']) await copyFile(join(dir(settled), name), join(dir(lost), name));
    await expect(readWindowsAgentSettlement(lost)).rejects.toMatchObject({ reason: 'binding-invalid' });
  }, 30000);
});
