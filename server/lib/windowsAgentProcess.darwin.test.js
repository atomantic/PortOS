import { afterAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lazyTempDataRoot, makePathsProxy, cleanupTempDataRoots, ownTestBodies } from './mockPathsDataRoot.js';

vi.mock('./fileUtils.js', async original => {
  const root = lazyTempDataRoot('darwin-agent-proof-');
  return makePathsProxy(await original(), { dataRoot: () => join(root, 'data') });
});
import { PATHS } from './fileUtils.js';
import { execFile, spawn } from './childProcess.js';
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
    if (Date.now() >= deadline) throw new Error('macOS agent proof did not arrive');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const ps = (pid, field) => new Promise((resolve, reject) => execFile('/bin/ps', ['-o', `${field}=`, '-p', String(pid)],
  (error, stdout) => (error ? reject(error) : resolve(stdout.trim()))));

function launch(run, command, args, options = {}) {
  const prepared = prepareWindowsAgentLaunch(run.id, command, args, { cwd: dir(run), env: process.env, ...options });
  const child = watchWindowsAgentProcess(spawn(prepared.command, prepared.args, { cwd: dir(run), stdio: 'pipe' }), prepared);
  return { prepared, child, closed: once(child, 'close') };
}

describe.skipIf(process.platform !== 'darwin')('macOS launchd-coalition release-agent boundary', () => {
  it('withholds proof while a detached grandchild outlives the root, then settles after the whole coalition exits', async () => {
    await reserveWindowsAgentProcess(agent);
    const script = join(root, 'example.cjs');
    const ready = join(root, 'child-ready');
    const parentRelease = join(root, 'parent-release');
    const childRelease = join(root, 'child-release');
    // `detached` gives the grandchild its own session (setsid), the escape a
    // PID or process-group check cannot follow.
    await writeFile(script, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
const child = process.argv[2] === 'child';
if (child) fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
else spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore', detached: true }).unref();
const timer = setInterval(() => { if (fs.existsSync(child ? ${JSON.stringify(childRelease)} : ${JSON.stringify(parentRelease)})) clearInterval(timer); }, 20);
process.stdout.write('EXAMPLE_STDOUT');
setTimeout(() => process.exit(3), 20000).unref();`);
    const { prepared, child, closed } = launch(agent, process.execPath, [script]);
    let output = '';
    child.stdout.on('data', data => { output += data; });
    expect(prepared.command).toMatch(/python3$/);
    try {
      await waitForFile(join(root, 'started.json'));
      await waitForFile(ready);
      const started = JSON.parse(await readFile(join(root, 'started.json'), 'utf8'));
      expect(started.proof).toMatchObject({ kind: 'launchd-coalition', version: 1, coalition: expect.stringMatching(/^[1-9][0-9]*$/) });
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'receipt-missing' });
      await writeFile(parentRelease, 'release');
      await vi.waitFor(() => expect(alive(started.pid)).toBe(false), { timeout: 5000 });
      const grandchild = Number(await readFile(ready, 'utf8'));
      // The grandchild leads its own session/process group and was never this supervisor's child.
      expect(Number(await ps(grandchild, 'pgid'))).toBe(grandchild);
      expect(Number(await ps(grandchild, 'ppid'))).not.toBe(child.pid);
      await new Promise(resolve => setTimeout(resolve, 300));
      await expect(readWindowsAgentSettlement(agent)).rejects.toMatchObject({ code: 'WINDOWS_AGENT_PROCESS_UNVERIFIED', reason: 'receipt-missing' });
      expect(() => prepareWindowsAgentLaunch(agent.id, process.execPath, [], { cwd: root, env: process.env })).toThrow();
      await writeFile(childRelease, 'release');
      expect((await closed)[0]).toBe(0);
      expect(alive(grandchild)).toBe(false);
      expect(output).toBe('EXAMPLE_STDOUT');
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ owner: started.owner, pid: started.pid, created: started.created,
        proof: started.proof, active: 0, exitCode: 0 });
    } finally { killProcessTree(child); await closed; }
  }, 30000);

  it('cancels the whole coalition through the supervisor, escalating past a SIGTERM-ignoring descendant, and spares a neighbor', async () => {
    await reserveWindowsAgentProcess(agent);
    const ready = join(root, 'child-ready');
    const descendant = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
    const rootScript = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore', detached: true }).unref(); setInterval(() => {}, 1000);`;
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

  it('gives a PTY agent its own controlling terminal and settles the tree when the server terminal closes', async () => {
    const pty = await import('node-pty');
    await reserveWindowsAgentProcess(agent);
    const script = join(root, 'pty.cjs');
    await writeFile(script, String.raw`const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdout.on('resize', () => process.stdout.write('EXAMPLE_RESIZE ' + process.stdout.columns + '\n'));
fs.closeSync(fs.openSync('/dev/tty', 'r'));
process.stdout.write('EXAMPLE_READY ' + process.stdout.columns + '\n');
process.stdin.on('data', data => process.stdout.write('EXAMPLE_INPUT ' + data.toString('hex') + '\n'));
setInterval(()=>{},1000);`);
    const prepared = prepareWindowsAgentLaunch(agent.id, process.execPath, [script], { cwd: root, env: process.env, pty: true });
    const child = watchWindowsAgentProcess(pty.spawn(prepared.command, prepared.args, { cwd: root, env: process.env, cols: 80, rows: 24 }), prepared);
    const closed = new Promise(resolve => child.onExit(resolve));
    let output = '';
    child.onData(data => { output += data; });
    try {
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_READY 80'), { timeout: 10000 });
      child.write('x\u0003');
      // Raw input, ^C included, reaches the agent byte for byte.
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_INPUT 7803'), { timeout: 10000 });
      child.resize(100, 30);
      await vi.waitFor(() => expect(output).toContain('EXAMPLE_RESIZE 100'), { timeout: 10000 });
      child.kill();
      await closed;
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0, proof: { kind: 'launchd-coalition' } });
    } finally { child.kill(); await closed; }
  }, 30000);

  it('still stops and settles a PTY agent whose server-side terminal has stopped draining output', async () => {
    const pty = await import('node-pty');
    await reserveWindowsAgentProcess(agent);
    const flood = `const chunk = 'x'.repeat(65536); const write = () => process.stdout.write(chunk, write); write();`;
    const prepared = prepareWindowsAgentLaunch(agent.id, process.execPath, ['-e', flood], { cwd: root, env: process.env, pty: true });
    const child = watchWindowsAgentProcess(pty.spawn(prepared.command, prepared.args, { cwd: root, env: process.env, cols: 80, rows: 24 }), prepared);
    const closed = new Promise(resolve => child.onExit(resolve));
    let received = 0;
    child.onData(data => { received += data.length; });
    try {
      await vi.waitFor(() => expect(received).toBeGreaterThan(0), { timeout: 10000 });
      child.pause();
      await new Promise(resolve => setTimeout(resolve, 500));
      child.kill();
      await waitForFile(join(root, 'settled.json'));
      expect(await readWindowsAgentSettlement(agent)).toMatchObject({ active: 0, exitCode: 143 });
    } finally { child.resume(); child.kill(); await closed; }
  }, 30000);

  it('keeps helper-missing, lost-supervisor, proofless and transplanted receipts held', async () => {
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
    // A Linux-shaped receipt (no coalition proof) is not macOS evidence.
    for (const name of ['started.json', 'settled.json']) {
      const record = JSON.parse(await readFile(join(dir(settled), name), 'utf8'));
      delete record.proof;
      await writeFile(join(dir(settled), name), JSON.stringify(record));
    }
    await expect(readWindowsAgentSettlement(settled)).rejects.toMatchObject({ reason: 'binding-invalid' });
  }, 30000);
});
