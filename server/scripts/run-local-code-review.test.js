import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from '../lib/childProcess.js';

it('runs a saved provider reviewer from the standalone claim bridge without bootstrapping PortOS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-bridge-test-'));
  const bodies = [];
  const api = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(body);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: 'NO FINDINGS' } }] }));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  // Run under a temporary install path: source in a CoS worktree intentionally
  // ignores PORTOS_DATA_ROOT. Preserve this test-only junction's module paths
  // rather than weakening that live-data protection.
  await symlink(fileURLToPath(new URL('../', import.meta.url)), join(root, 'server'), 'junction');
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(data, 'providers.json'), JSON.stringify({ activeProvider: 'example-gpu', providers: {
    'example-gpu': { id: 'example-gpu', name: 'Example GPU', type: 'api', enabled: true,
      endpoint: `http://127.0.0.1:${api.address().port}/v1`, models: ['default-model', 'review-model'], defaultModel: 'default-model' },
  } }));
  await writeFile(join(data, 'settings.json'), JSON.stringify({ codeReview: {
    reviewers: ['provider:example-gpu'], providerModels: { 'provider:example-gpu': 'review-model' },
  } }));
  const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs')], {
    env: { ...process.env, NODE_ENV: 'test', MEMORY_BACKEND: 'file', PORTOS_DATA_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Review bridge timed out')); }, 10000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ backend: 'provider:example-gpu', diff: 'diff --git a/example.js b/example.js' }));
  }).finally(async () => {
    await new Promise(resolve => api.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, backend: 'provider:example-gpu', model: 'review-model', findings: 'NO FINDINGS' });
  expect(bodies).toHaveLength(1);
  expect(JSON.parse(bodies[0])).toMatchObject({ model: 'review-model' });
  expect(JSON.parse(bodies[0])).not.toHaveProperty('tools');
}, 15000);
