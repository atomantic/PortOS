import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
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
  const harness = join(root, 'harness.cjs');
  await writeFile(join(root, 'context.txt'), 'example surrounding source');
  await writeFile(harness, `
    const { readFileSync } = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      const context = readFileSync('context.txt', 'utf8');
      if (context !== 'example surrounding source' || args.includes('baked-model') || args[args.indexOf('--model') + 1] !== 'review-model') process.exit(1);
      process.stdout.write('NO FINDINGS');
    });
  `);
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(data, 'providers.json'), JSON.stringify({ activeProvider: 'example-gpu', providers: {
    'example-gpu': { id: 'example-gpu', name: 'Example GPU', type: 'api', enabled: true,
      endpoint: `http://127.0.0.1:${api.address().port}/v1`, models: ['default-model', 'review-model'], defaultModel: 'default-model' },
    'example-cli': { id: 'example-cli', name: 'Example CLI', type: 'cli', enabled: true, command: process.execPath, args: [harness, '--model', 'baked-model'], defaultModel: 'default-model' },
  } }));
  await writeFile(join(data, 'settings.json'), JSON.stringify({ codeReview: {
    reviewers: ['provider:example-gpu'], providerModels: { 'provider:example-gpu': 'review-model' },
  } }));
  const runReview = request => {
    const env = { ...process.env, NODE_ENV: 'test', MEMORY_BACKEND: 'file', PORTOS_DATA_ROOT: root };
    delete env.VITEST;
    const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Review bridge timed out')); }, 10000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify(request));
    });
  };
  const results = await (async () => {
    const request = { backend: 'provider:example-gpu', diff: 'diff --git a/example.js b/example.js' };
    return [await runReview(request), await runReview({ ...request, inheritDefaults: false }), await runReview({ backend: 'provider:example-cli', model: 'review-model', diff: request.diff })];
  })().finally(async () => {
    await new Promise(resolve => api.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  expect(results).toHaveLength(3);
  expect(results[2].code, results[2].stderr).toBe(0);
  expect(JSON.parse(results[2].stdout)).toMatchObject({ ok: true, backend: 'provider:example-cli', model: 'review-model', findings: 'NO FINDINGS' });
  for (const [index, model] of ['review-model', 'default-model'].entries()) {
    const result = results[index];
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, backend: 'provider:example-gpu', model, findings: 'NO FINDINGS' });
    expect(JSON.parse(bodies[index])).toMatchObject({ model });
    expect(JSON.parse(bodies[index])).not.toHaveProperty('tools');
  }
  expect(bodies).toHaveLength(2);
}, 15000);

it('shuts down the Codex app-server child and cleans up scratch resources after successful and timed-out reviews', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-bridge-codex-test-'));
  await symlink(fileURLToPath(new URL('../', import.meta.url)), join(root, 'server'), 'junction');

  const binDir = join(root, 'bin');
  await mkdir(binDir);
  const fakeCodex = join(binDir, 'fake-codex.cjs');
  await writeFile(fakeCodex, `
    const { writeFileSync, appendFileSync } = require('node:fs');
    const readline = require('node:readline');

    if (process.env.FAKE_CODEX_INVOCATION_FILE) {
      appendFileSync(process.env.FAKE_CODEX_INVOCATION_FILE, String(process.pid) + '\\n');
    }
    if (process.env.FAKE_CODEX_PID_FILE) {
      writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
    }

    const mode = process.env.FAKE_CODEX_MODE || 'success';
    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { user: { email: 'user@example.com' } }
          }) + '\\n');
        } else if (msg.method === 'thread/start') {
          if (msg.params?.cwd && process.env.FAKE_CODEX_CWD_FILE) {
            writeFileSync(process.env.FAKE_CODEX_CWD_FILE, msg.params.cwd);
          }
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { thread: { id: 'thread-test' }, model: 'gpt-5.3-codex' }
          }) + '\\n');
        } else if (msg.method === 'turn/start') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { turn: { id: 'turn-test', items: [], status: 'inProgress' } }
          }) + '\\n');
          if (mode === 'success') {
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-test', turnId: 'turn-test', itemId: 'i1', delta: 'NO FINDINGS' }
            }) + '\\n');
            process.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { threadId: 'thread-test', turn: { id: 'turn-test', items: [], status: 'completed' } }
            }) + '\\n');
          }
        }
      } catch (err) {}
    });

    const keepAlive = setInterval(() => {}, 1000);
    process.on('SIGTERM', () => {
      clearInterval(keepAlive);
      process.exit(0);
    });
    process.on('SIGINT', () => {
      clearInterval(keepAlive);
      process.exit(0);
    });
  `);

  const codexBin = join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (process.platform === 'win32') {
    await writeFile(codexBin, `@node "${fakeCodex}" %*\r\n`);
  } else {
    await writeFile(codexBin, `#!${process.execPath}\nrequire(${JSON.stringify(fakeCodex)});\n`);
    await chmod(codexBin, 0o755);
  }

  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(data, 'providers.json'), JSON.stringify({
    activeProvider: 'codex',
    providers: {
      codex: {
        id: 'codex',
        name: 'ChatGPT Subscription (Codex)',
        type: 'cli',
        command: 'codex',
        enabled: true,
        textTransport: 'codex-app-server',
        textTransportEnabled: true,
        textTransportReadRiskAcknowledged: true,
        defaultModel: 'gpt-5.3-codex',
        models: ['gpt-5.3-codex'],
      },
      unsupported: {
        id: 'unsupported',
        name: 'Disabled Provider',
        type: 'cli',
        command: 'codex',
        enabled: false,
      },
    },
  }));

  const settingsFile = join(data, 'settings.json');
  await writeFile(settingsFile, JSON.stringify({
    codeReview: {
      reviewers: ['provider:codex'],
      providerModels: { 'provider:codex': 'gpt-5.3-codex' },
      reviewerHealth: {
        'provider:codex': {
          code: 'NO_MODEL',
          reason: 'configuration',
          lastFailureAt: 1000,
        },
      },
    },
  }));

  const invocationsFile = join(root, 'codex-invocations.txt');
  const unrelatedChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

  const runReview = (request, envOverrides = {}) => {
    const env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH || ''}`,
      Path: `${binDir}${delimiter}${process.env.Path || ''}`,
      NODE_ENV: 'test',
      MEMORY_BACKEND: 'file',
      PORTOS_DATA_ROOT: root,
      FAKE_CODEX_INVOCATION_FILE: invocationsFile,
      ...envOverrides,
    };
    delete env.VITEST;
    const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs')], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Review bridge timed out')); }, 10000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify(request));
    });
  };

  try {
    // 1. Successful review: proves child exits, scratch dir is removed, health cleared
    const pidFile1 = join(root, 'codex-success.pid');
    const cwdFile1 = join(root, 'codex-success-cwd.txt');
    const successRes = await runReview(
      { backend: 'provider:codex', diff: 'diff --git a/a.js b/a.js' },
      { FAKE_CODEX_MODE: 'success', FAKE_CODEX_PID_FILE: pidFile1, FAKE_CODEX_CWD_FILE: cwdFile1 },
    );

    expect(successRes.code, successRes.stderr).toBe(0);
    const successStdout = JSON.parse(successRes.stdout.trim());
    expect(successStdout).toMatchObject({ ok: true, backend: 'provider:codex', model: 'gpt-5.3-codex', findings: 'NO FINDINGS' });
    expect(successRes.stderr).toContain('Codex app-server stopped');

    const pid1 = parseInt(await readFile(pidFile1, 'utf8'), 10);
    expect(pid1).toBeGreaterThan(0);
    expect(() => process.kill(pid1, 0)).toThrow();

    const scratchCwd1 = await readFile(cwdFile1, 'utf8');
    expect(scratchCwd1).toContain('portos-codex-text-');
    expect(existsSync(scratchCwd1)).toBe(false);

    // Health reporting: successful review cleared the prior config fault
    const settingsAfterSuccess = JSON.parse(await readFile(settingsFile, 'utf8'));
    expect(settingsAfterSuccess.codeReview?.reviewerHealth?.['provider:codex']).toBeUndefined();

    // 2. Timed-out review: proves child exits, scratch dir is removed, failure exit code
    const pidFile2 = join(root, 'codex-timeout.pid');
    const cwdFile2 = join(root, 'codex-timeout-cwd.txt');
    const timeoutRes = await runReview(
      { backend: 'provider:codex', diff: 'diff --git a/b.js b/b.js', timeoutMs: 250 },
      { FAKE_CODEX_MODE: 'timeout', FAKE_CODEX_PID_FILE: pidFile2, FAKE_CODEX_CWD_FILE: cwdFile2 },
    );

    expect(timeoutRes.code).toBe(1);
    const timeoutStdout = JSON.parse(timeoutRes.stdout.trim());
    expect(timeoutStdout).toMatchObject({ ok: false, error: expect.stringMatching(/did not finish/i) });
    expect(timeoutStdout.error).toContain('250ms');
    expect(timeoutStdout.error).toContain('1 KiB');
    expect(timeoutRes.stderr).toContain('Codex app-server stopped');

    const pid2 = parseInt(await readFile(pidFile2, 'utf8'), 10);
    expect(pid2).toBeGreaterThan(0);
    expect(() => process.kill(pid2, 0)).toThrow();

    const scratchCwd2 = await readFile(cwdFile2, 'utf8');
    expect(scratchCwd2).toContain('portos-codex-text-');
    expect(existsSync(scratchCwd2)).toBe(false);

    // 3. Standalone non-Codex reviewers do not spawn Codex child solely for cleanup
    const invocationsBefore = existsSync(invocationsFile)
      ? (await readFile(invocationsFile, 'utf8')).trim().split('\n').filter(Boolean).length
      : 0;
    expect(invocationsBefore).toBe(2);

    const nonCodexRes = await runReview(
      { backend: 'provider:unsupported', diff: 'diff --git a/c.js b/c.js' },
      { FAKE_CODEX_MODE: 'success' },
    );
    expect(nonCodexRes.code).toBe(1);
    const nonCodexStdout = JSON.parse(nonCodexRes.stdout.trim());
    expect(nonCodexStdout).toMatchObject({ ok: false, code: 'REVIEWER_UNAVAILABLE' });

    const invocationsAfter = (await readFile(invocationsFile, 'utf8')).trim().split('\n').filter(Boolean).length;
    expect(invocationsAfter).toBe(2);

    // 4. Unrelated processes remain untouched
    expect(() => process.kill(unrelatedChild.pid, 0)).not.toThrow();
  } finally {
    try { process.kill(unrelatedChild.pid, 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
