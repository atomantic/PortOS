import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { io as connect } from 'socket.io-client';

// index.js binds its server at import, so the only faithful way to exercise the
// real /spawn ordering is to boot it as a child process. #11761: Node reports a
// failed spawn on process.nextTick, and the route used to await the scanner
// evidence read between spawn() and the 'error' listener — the unhandled
// 'error' threw, the runner's uncaughtException handler exited the process, and
// every other agent it supervised lost its owner.
const RUNNER = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

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

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), 'portos-runner-spawn-'));
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

  afterAll(() => {
    socket?.close();
    runner?.kill('SIGKILL');
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('reports agent:error, drops the agent and keeps the runner alive', async () => {
    const errored = new Promise((resolve, reject) => {
      socket.once('agent:error', resolve);
      runner.once('exit', () => reject(new Error('the runner process died on a failed spawn')));
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
    expect(exited, 'the runner process must not die on a failed spawn').toBe(false);
    const health = await fetch(`${base}/health`).then((res) => res.json());
    expect(health).toMatchObject({ status: 'ok', activeAgents: 0 });
  }, 20_000);
});
