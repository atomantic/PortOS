import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_ANIMATION_SEATBELT } from '../../lib/codeAnimationContainment.js';
import { runContainedWorker } from './containedWorker.js';

// Real-mechanism suite: these run only where the enforced sandbox exists. The
// adversarial boundary and limit checks run end to end through the probe route
// (routes/codeAnimationExecution.test.js); this file pins the worker lifecycle.
const seatbelt = process.platform === 'darwin' && existsSync(CODE_ANIMATION_SEATBELT);
const roots = [];
const workspaceRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'portos-contained-worker-'));
  roots.push(root);
  return root;
};
const node = (extra = []) => ({ executable: process.execPath, argv: (entry) => [entry, ...extra] });
afterAll(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });

describe('contained worker refusal', () => {
  it('refuses with no enforced mechanism and creates no workspace', async () => {
    const root = await workspaceRoot();
    await expect(runContainedWorker({
      tool: node(), workspaceRoot: root, entrypoint: 'main.cjs',
      files: [{ path: 'main.cjs', content: 'require("fs").writeFileSync("/tmp/never", "x")' }],
      seatbeltPath: join(root, 'missing-sandbox-exec'),
    })).rejects.toMatchObject({ status: 503, code: 'CODE_ANIMATION_CONTAINMENT_UNAVAILABLE' });
    expect(await readdir(root)).toEqual([]);
  });
});

describe.skipIf(!seatbelt)('contained worker lifecycle under macOS Seatbelt', () => {
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
    expect(result).toMatchObject({ status: 'completed', mechanism: 'macos-seatbelt', exitCode: 0, processGroupClear: true });
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
