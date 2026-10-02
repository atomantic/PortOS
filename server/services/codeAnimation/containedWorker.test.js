import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentContainmentMechanism, runContainedWorker, runTrustedLocalWorker } from './containedWorker.js';

// Real-mechanism suite: these run only where the enforced sandbox exists. The
// adversarial boundary and limit checks run end to end through the probe route
// (routes/codeAnimationExecution.test.js); this file pins the worker lifecycle.
const mechanism = await currentContainmentMechanism();
const supported = mechanism.supported;
if (process.env.PORTOS_REQUIRE_LINUX_CONTAINMENT === '1' && mechanism.id !== 'linux-bubblewrap') {
  throw new Error(`Real Linux containment is required by this test job: ${mechanism.reason}`);
}
const roots = [];
afterEach(() => vi.unstubAllEnvs());
const workspaceRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'portos-contained-worker-'));
  roots.push(root);
  return root;
};
const node = (extra = []) => ({ executable: process.execPath, argv: (entry) => [entry, ...extra] });
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

describe('contained worker refusal', () => {
  it.skipIf(process.platform !== 'linux')('refuses a present wrapper that cannot create namespaces before staging', async () => {
    const root = await workspaceRoot();
    await expect(runContainedWorker({
      tool: node(), workspaceRoot: root, bubblewrapPath: '/usr/bin/false',
    })).rejects.toMatchObject({ code: 'CODE_ANIMATION_CONTAINMENT_UNAVAILABLE', message: expect.stringContaining('user namespaces') });
    expect(await readdir(root)).toEqual([]);
  });


  it('refuses with no enforced mechanism and creates no workspace', async () => {
    const root = await workspaceRoot();
    await expect(runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'main.cjs',
      files: [{ path: 'main.cjs', content: 'require("fs").writeFileSync("/tmp/never", "x")' }],
      seatbeltPath: join(root, 'missing-sandbox-exec'),
      bubblewrapPath: join(root, 'missing-bwrap'),
    })).rejects.toMatchObject({ status: 503, code: 'CODE_ANIMATION_CONTAINMENT_UNAVAILABLE' });
    expect(await readdir(root)).toEqual([]);
  });
});

describe.skipIf(!supported)('contained worker lifecycle under the real host sandbox', () => {
  it('allows native worker threads to complete without granting subprocess creation', async () => {
    const root = await workspaceRoot();
    const result = await runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'main.cjs',
      files: [{ path: 'main.cjs', content: `
const { Worker } = require('worker_threads');
const worker = new Worker('require("worker_threads").parentPort.postMessage("thread complete")', { eval: true });
worker.on('message', (value) => console.log(value));
worker.on('error', () => process.exit(1));
` }],
    });
    expect(result).toMatchObject({ status: 'completed', processGroupClear: true });
    expect(result.stdout).toContain('thread complete');
    expect(await readdir(root)).toEqual([]);
  });


  it('stages input read-only, collects regular output files, then removes the workspace', async () => {
    const root = await workspaceRoot();
    let collected = null;
    const result = await runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'src/main.cjs',
      files: [
        { path: 'src/main.cjs', content: 'const fs = require("fs"); const out = process.env.PORTOS_WORKER_OUTPUT; fs.mkdirSync(out + "/frames"); fs.writeFileSync(out + "/frames/0001.txt", fs.readFileSync(__dirname + "/../assets/cue.txt")); console.log("rendered");' },
        { path: 'assets/cue.txt', content: Buffer.from('frame').toString('base64'), encoding: 'base64' },
      ],
      onOutput: async (dir, outputs) => { collected = { outputs, body: await readFile(join(dir, 'frames/0001.txt'), 'utf8') }; },
    });
    expect(result).toMatchObject({ status: 'completed', mechanism: mechanism.id, exitCode: 0, processGroupClear: true });
    expect(result.stdout).toContain('rendered');
    expect(collected).toEqual({ outputs: [{ path: 'frames/0001.txt', bytes: 5 }], body: 'frame' });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses output a worker linked rather than wrote, without handing it to the caller', async () => {
    const root = await workspaceRoot();
    let handed = false;
    const result = await runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'main.cjs',
      files: [{ path: 'main.cjs', content: 'require("fs").symlinkSync("/etc/hosts", process.env.PORTOS_WORKER_OUTPUT + "/hosts")' }],
      onOutput: async () => { handed = true; },
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'output-invalid', invalidOutputs: ['hosts'], outputs: [] });
    expect(handed).toBe(false);
  });

  it('reports a failing worker with its diagnostics and an empty process group', async () => {
    const root = await workspaceRoot();
    const result = await runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'main.cjs',
      files: [{ path: 'main.cjs', content: 'console.error("scene failed: missing camera"); process.exit(3)' }],
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'exit', exitCode: 3, processGroupClear: true });
    expect(result.stderr).toContain('scene failed: missing camera');
  });

  it('refuses an entrypoint that is not a staged file before spawning', async () => {
    const root = await workspaceRoot();
    await expect(runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: '../escape.cjs', files: [{ path: 'main.cjs', content: '' }],
    })).rejects.toMatchObject({ status: 400, code: 'CODE_ANIMATION_STAGE_PATH' });
    expect(await readdir(root)).toEqual([]);
  });
});


describe.skipIf(!['darwin', 'linux'].includes(process.platform))('explicit trusted-local worker supervision', () => {
  it('scrubs credentials and kills the owned parent and child group on cancel', async () => {
    vi.stubEnv('PORTOS_API_TOKEN', 'synthetic-worker-token');
    const root = await workspaceRoot();
    const controller = new AbortController();
    // The source announces its child, then requests cancellation through an
    // output marker observed by this test; no timing assumption about startup.
    const pending = runTrustedLocalWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'main.cjs', signal: controller.signal,
      files: [{ path: 'main.cjs', content: `
const fs = require('fs');
const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
console.log(JSON.stringify({ child: child.pid, token: !!process.env.PORTOS_API_TOKEN }));
fs.writeFileSync(process.env.PORTOS_WORKER_OUTPUT + '/ready', 'ready');
setInterval(() => {}, 1000);
` }], limits: { wallSeconds: 15 },
    });
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt += 1) {
      for (const directory of await readdir(root)) {
        ready ||= await readFile(join(root, directory, 'output', 'ready'), 'utf8').then(() => true, () => false);
      }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    controller.abort();
    const result = await pending;
    expect(ready).toBe(true);
    expect(result).toMatchObject({ status: 'terminated', reason: 'canceled', contained: false, mechanism: 'trusted-local', processGroupClear: true });
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence.child).toBeGreaterThan(0);
    expect(evidence.token).toBe(false);
    expect(() => process.kill(evidence.child, 0)).toThrow();
    expect(await readdir(root)).toEqual([]);
  }, 20000);
});
