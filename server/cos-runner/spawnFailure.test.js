import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { io as connect } from 'socket.io-client';
import { DISPOSABLE_ROOT_MARKER } from '../lib/dataRoot.js';

// index.js binds its server at import, so the only faithful way to exercise the
// real /spawn ordering is to boot it as a child process. #11761: Node reports a
// failed spawn on process.nextTick, and the route used to await the scanner
// evidence read between spawn() and the 'error' listener — the unhandled
// 'error' threw, the runner's uncaughtException handler exited the process, and
// every other agent it supervised lost its owner.
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
const CHECKOUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const snapshotTree = (root) => {
  if (!existsSync(root)) return null;
  const entries = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      entries.push({
        path: path.slice(root.length),
        size: stat.size,
        modified: stat.mtimeMs,
        isDirectory: stat.isDirectory(),
      });
      if (stat.isDirectory()) visit(path);
    }
  };
  visit(root);
  return entries;
};

const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

describe('cos-runner /spawn survives a failed CLI launch (#11761)', () => {
  let runner;
  let dataRoot;
  let base;
  let socket;
  let exited = false;
  let checkoutFixtureBefore;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'portos-runner-spawn-'));
    // A CoS worktree rejects unmarked PORTOS_DATA_ROOT overrides. Mark this
    // throwaway root so the real runner's failed-spawn recording stays inside
    // the fixture and is removed by afterAll.
    writeFileSync(join(dataRoot, DISPOSABLE_ROOT_MARKER), '');
    checkoutFixtureBefore = snapshotTree(join(CHECKOUT_ROOT, 'data/cos/agents/agent-spawn-failure'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    // The runner is a standalone service: drop the runner-under-test markers so its
    // own test-data isolation guard does not treat this boot as a test process.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
    runner = spawn(process.execPath, [RUNNER], {
      env: { ...env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', PORTOS_DATA_ROOT: dataRoot },
      stdio: 'ignore',
    });
    runner.once('exit', () => { exited = true; });
    for (let attempt = 0; attempt < 100 && !exited; attempt += 1) {
      const ready = await fetch(`${base}/health`).then((res) => res.ok, () => false);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    socket = connect(base, { transports: ['websocket'] });
    await new Promise((resolve) => socket.once('connect', resolve));
  }, 30_000);

  afterAll(async () => {
    socket?.close();
    // Windows keeps the runner's data-root files locked until the process is
    // gone, and kill() only requests that — removing first fails with EPERM.
    if (runner && runner.exitCode === null && runner.signalCode === null) {
      const gone = new Promise((resolve) => runner.once('exit', resolve));
      runner.kill('SIGKILL');
      await gone;
    }
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('reports agent:error, drops the agent and keeps the runner alive', async () => {
    const errored = new Promise((resolve, reject) => {
      socket.once('agent:error', resolve);
      runner.once('exit', () => reject(new Error('the runner process died on a failed spawn')));
    });
    const completed = new Promise((resolve, reject) => {
      socket.once('agent:completed', resolve);
      runner.once('exit', () => reject(new Error('the runner exited before recording the failed spawn')));
    });
    // A removed cwd makes the launch fail with ENOENT regardless of whether the
    // CLI is installed, so this is deterministic on any machine.
    const response = await fetch(`${base}/spawn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-spawn-failure',
        taskId: 'task-spawn-failure',
        prompt: 'example',
        workspacePath: join(dataRoot, 'removed-workspace'),
        cliCommand: 'claude',
        cliArgs: [],
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await errored).toMatchObject({ agentId: 'agent-spawn-failure' });
    expect(await completed).toMatchObject({ agentId: 'agent-spawn-failure', taskId: 'task-spawn-failure' });
    expect(exited, 'the runner process must not die on a failed spawn').toBe(false);
    const disposableAgentDir = join(dataRoot, 'data/cos/agents/agent-spawn-failure');
    expect(readdirSync(disposableAgentDir).sort()).toEqual(['metadata.json', 'output.txt']);
    expect(JSON.parse(readFileSync(join(disposableAgentDir, 'metadata.json'), 'utf8')))
      .toMatchObject({
        agentId: 'agent-spawn-failure',
        taskId: 'task-spawn-failure',
        success: false,
      });
    expect(snapshotTree(join(CHECKOUT_ROOT, 'data/cos/agents/agent-spawn-failure')))
      .toEqual(checkoutFixtureBefore);
    const health = await fetch(`${base}/health`).then((res) => res.json());
    expect(health).toMatchObject({ status: 'ok', activeAgents: 0 });
  }, 20_000);
});
