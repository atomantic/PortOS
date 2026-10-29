import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn, execFile } from '../lib/childProcess.js';

it('runs a saved provider reviewer from the standalone claim bridge without bootstrapping PortOS', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-bridge-test-'));
  await promisify(execFile)('git', ['init', '--quiet'], { cwd: root });
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
    const { existsSync } = require('node:fs');
    process.stdin.resume();
    process.stdin.on('end', () => {
      const args = process.argv.slice(2);
      // No reviewer mode means ordinary argv, so it must run outside the caller's checkout.
      if (existsSync('context.txt') || args.includes('baked-model') || args[args.indexOf('--model') + 1] !== 'review-model') process.exit(1);
      if (args.includes('--refuse')) {
        process.stderr.write('jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. synthetic-private-path-or-credential');
        process.exit(1);
      }
      process.stdout.write('NO FINDINGS');
    });
  `);
  const data = join(root, 'data');
  await mkdir(data);
  await writeFile(join(data, 'providers.json'), JSON.stringify({ activeProvider: 'example-gpu', providers: {
    'example-gpu': { id: 'example-gpu', name: 'Example GPU', type: 'api', enabled: true,
      endpoint: `http://127.0.0.1:${api.address().port}/v1`, models: ['default-model', 'review-model'], defaultModel: 'default-model' },
    'example-refusal': { id: 'example-refusal', name: 'Example Refusal', type: 'cli', enabled: true, command: process.execPath, args: [harness, '--refuse'], defaultModel: 'review-model' },
    'example-cli': { id: 'example-cli', name: 'Example CLI', type: 'cli', enabled: true, command: process.execPath, args: [harness, '--model', 'baked-model'], defaultModel: 'default-model' },
  } }));
  await writeFile(join(data, 'settings.json'), JSON.stringify({ codeReview: {
    reviewers: ['provider:example-gpu'], providerModels: { 'provider:example-gpu': 'review-model' },
    reviewerHealth: { 'provider:example-gpu': { code: 'NO_MODEL', reason: 'configuration', lastFailureAt: 1000 } },
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
      child.stdin.end(JSON.stringify({ recordAttribution: true, ...request }));
    });
  };
  const results = await (async () => {
    const request = { backend: 'provider:example-gpu', diff: 'diff --git a/example.js b/example.js' };
    // A resumed claim can complete its review before attribution was initialized
    // (#14102): the evidence file is created on demand, never failing publication.
    const noState = await runReview(request);
    expect(noState.code).toBe(0);
    expect(JSON.parse(noState.stdout)).toMatchObject({ ok: true, model: 'review-model', verdict: 'clean', findings: 'NO FINDINGS' });
    expect(JSON.parse(noState.stdout).attributionError).toBeUndefined();
    const healthy = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
    expect(healthy.codeReview?.reviewerHealth?.['provider:example-gpu']).toBeUndefined();
    expect(await readFile(join(root, '.git/portos-local-review-models'), 'utf8')).toBe('review-model\n');
    expect(JSON.parse(bodies.shift())).toMatchObject({ model: 'review-model' });
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./local-review-attribution.mjs', import.meta.url)), 'reset'], { cwd: root });
    expect(await readFile(join(root, '.git/portos-local-review-models'), 'utf8')).toBe('');
    const cliRequest = { backend: 'provider:example-cli', model: 'review-model', diff: request.diff };
    const results = [await runReview(request), await runReview({ ...request, inheritDefaults: false }), await runReview(cliRequest),
      await runReview({ ...cliRequest, kind: 'claim-review' }),
      await runReview({ kind: 'claim-comments', backend: 'provider:example-cli', model: 'review-model', comments: [{ login: 'example-user', type: 'User', body: 'I will work on this' }] }),
      await runReview({ ...cliRequest, backend: 'provider:example-refusal', kind: 'claim-review', inheritDefaults: false })];
    expect(await readFile(join(root, '.git/portos-local-review-models'), 'utf8')).toBe('review-model\ndefault-model\nreview-model\nreview-model\n');
    const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./local-review-attribution.mjs', import.meta.url)), 'labels'], { cwd: root });
    expect(JSON.parse(stdout).labels).toEqual(['reviewer:review-model', 'reviewer:default-model']);
    return results;
  })().finally(async () => {
    await new Promise(resolve => api.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  expect(results).toHaveLength(6);
  expect(results[5].code).not.toBe(0);
  expect(JSON.parse(results[5].stdout)).toMatchObject({ ok: false, code: 'REVIEWER_COMMAND_PERMISSION_DENIED' });
  expect(results[5].stderr).toContain('Reviewer configuration fault (REVIEWER_COMMAND_PERMISSION_DENIED) for provider:example-refusal');
  expect(results[5].stdout + results[5].stderr).not.toContain('synthetic-private');
  // Ordinary and claim code reviews both use the scratch review procedure.
  // Public-comment screening still requires an enforced reviewer mode.
  for (const result of [results[2], results[3]]) {
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, backend: 'provider:example-cli', verdict: 'clean', findings: 'NO FINDINGS' });
  }
  for (const result of [results[4]]) {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/REVIEWER_UNSUPPORTED/);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'REVIEWER_UNSUPPORTED' });
  }
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
  // Freeze budget accounting and hold only the review's 250ms deadlines.
  // The synthetic server advances
  // them after it has reached the phase this case is intended to exercise.
  // The outer watchdog and app-server shutdown timers still use real time.
  const clockPreload = join(root, 'review-clock.cjs');
  await writeFile(clockPreload, `
    const cp = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const { writeFileSync } = require('node:fs');
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Map();
    let now = Date.now();
    if (process.env.FAKE_CODEX_CLOCK_FILE) Date.now = () => now;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (!process.env.FAKE_CODEX_CLOCK_FILE || ms !== 250) return realSetTimeout(callback, ms, ...args);
      const handle = realSetTimeout(() => {}, 2147483647);
      pending.set(handle, () => callback(...args));
      return handle;
    };
    globalThis.clearTimeout = handle => {
      pending.delete(handle);
      return realClearTimeout(handle);
    };
    const realSpawn = cp.spawn;
    cp.spawn = (...args) => {
      const child = realSpawn(...args);
      let buffered = '';
      child.stdout?.on('data', chunk => {
        buffered += chunk;
        const lines = buffered.split('\\n');
        buffered = lines.pop();
        for (const line of lines) {
          if (!line.includes('test/advance-review-clock')) continue;
          setImmediate(() => {
            now += 250;
            const timers = [...pending];
            writeFileSync(process.env.FAKE_CODEX_CLOCK_FILE, JSON.stringify({ timersFired: timers.length }));
            for (const [handle, fire] of timers) {
              globalThis.clearTimeout(handle);
              fire();
            }
          });
        }
      });
      return child;
    };
    syncBuiltinESMExports();
  `);
  const fakeCodex = join(binDir, 'fake-codex.cjs');
  await writeFile(fakeCodex, `
    const { writeFileSync, appendFileSync, readdirSync } = require('node:fs');
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
          if (mode === 'pre-turn-timeout') {
            const scratch = readdirSync(process.env.TMPDIR).filter(name => name.startsWith('portos-codex-text-'));
            writeFileSync(process.env.FAKE_CODEX_SCRATCH_FILE, JSON.stringify(scratch));
            process.stdout.write(JSON.stringify({ method: 'test/advance-review-clock' }) + '\\n');
            return;
          }
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
          if (mode === 'timeout') {
            process.stdout.write(JSON.stringify({ method: 'test/advance-review-clock' }) + '\\n');
          }
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

  const scratchDir = join(root, 'scratch');
  await mkdir(scratchDir);
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
      TMPDIR: scratchDir,
      TMP: scratchDir,
      TEMP: scratchDir,
      ...envOverrides,
    };
    delete env.VITEST;
    const child = spawn(process.execPath, ['--require', clockPreload, '--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs')], {
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

    // 2. Expire only after turn/start: child exit and scratch cleanup must hold
    // even when the reviewer accepts a turn but never completes it.
    const pidFile2 = join(root, 'codex-timeout.pid');
    const cwdFile2 = join(root, 'codex-timeout-cwd.txt');
    const timeoutRes = await runReview(
      { backend: 'provider:codex', diff: 'diff --git a/b.js b/b.js', timeoutMs: 250 },
      { FAKE_CODEX_MODE: 'timeout', FAKE_CODEX_PID_FILE: pidFile2, FAKE_CODEX_CWD_FILE: cwdFile2, FAKE_CODEX_CLOCK_FILE: join(root, 'turn-clock.json') },
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

    expect(JSON.parse(await readFile(join(root, 'turn-clock.json'), 'utf8')).timersFired).toBeGreaterThan(0);

    // 3. Expire during initialize: no thread/CWD evidence exists yet, but the
    // scratch directory created before connecting and the owned child must go.
    const preTurnPidFile = join(root, 'codex-pre-turn.pid');
    const preTurnCwdFile = join(root, 'codex-pre-turn-cwd.txt');
    const preTurnScratchFile = join(root, 'pre-turn-scratch.json');
    const preTurnRes = await runReview(
      { backend: 'provider:codex', diff: 'diff --git a/b.js b/b.js', timeoutMs: 250 },
      { FAKE_CODEX_MODE: 'pre-turn-timeout', FAKE_CODEX_PID_FILE: preTurnPidFile,
        FAKE_CODEX_CWD_FILE: preTurnCwdFile, FAKE_CODEX_SCRATCH_FILE: preTurnScratchFile,
        FAKE_CODEX_CLOCK_FILE: join(root, 'pre-turn-clock.json') },
    );
    expect(preTurnRes.code, preTurnRes.stderr).toBe(1);
    expect(JSON.parse(preTurnRes.stdout)).toMatchObject({ ok: false, error: expect.stringMatching(/250ms/) });
    expect(preTurnRes.stderr).toContain('Codex app-server stopped');
    const preTurnPid = Number(await readFile(preTurnPidFile, 'utf8'));
    expect(preTurnPid).toBeGreaterThan(0);
    expect(() => process.kill(preTurnPid, 0)).toThrow();
    expect(existsSync(preTurnCwdFile)).toBe(false);
    const preTurnScratch = JSON.parse(await readFile(preTurnScratchFile, 'utf8'));
    expect(preTurnScratch).toHaveLength(1);
    expect(existsSync(join(scratchDir, preTurnScratch[0]))).toBe(false);
    expect(JSON.parse(await readFile(join(root, 'pre-turn-clock.json'), 'utf8')).timersFired).toBeGreaterThan(0);

    // 4. Standalone non-Codex reviewers do not spawn Codex child solely for cleanup
    const invocationsBefore = existsSync(invocationsFile)
      ? (await readFile(invocationsFile, 'utf8')).trim().split('\n').filter(Boolean).length
      : 0;
    expect(invocationsBefore).toBe(3);

    const nonCodexRes = await runReview(
      { backend: 'provider:unsupported', diff: 'diff --git a/c.js b/c.js' },
      { FAKE_CODEX_MODE: 'success' },
    );
    expect(nonCodexRes.code).toBe(1);
    const nonCodexStdout = JSON.parse(nonCodexRes.stdout.trim());
    expect(nonCodexStdout).toMatchObject({ ok: false, code: 'REVIEWER_UNAVAILABLE' });

    const invocationsAfter = (await readFile(invocationsFile, 'utf8')).trim().split('\n').filter(Boolean).length;
    expect(invocationsAfter).toBe(3);

    // 5. Unrelated processes remain untouched
    expect(() => process.kill(unrelatedChild.pid, 0)).not.toThrow();
  } finally {
    try { process.kill(unrelatedChild.pid, 'SIGKILL'); } catch {}
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it('projects malformed diagnostics through the bridge and health store, clearing them only after a validated verdict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-verdict-bridge-'));
  const reviewer = 'provider:example-reviewer';
  const health = { code: 'REVIEWER_UNSUPPORTED', reason: 'configuration', lastFailureAt: 1 };
  let finishReason;
  let content = '## Blocking\n\n- `example.js:12`: Hardcoding `allowUnconfined: true\nNo findings.';
  const api = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }));
    });
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    await symlink(fileURLToPath(new URL('../', import.meta.url)), join(root, 'server'), 'junction');
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/providers.json'), JSON.stringify({ activeProvider: 'example-reviewer', providers: {
      'example-reviewer': { id: 'example-reviewer', name: 'Example Reviewer', type: 'api', enabled: true,
        endpoint: `http://127.0.0.1:${api.address().port}/v1`, models: ['example-model'], defaultModel: 'example-model' },
    } }));
    await writeFile(join(root, 'data/settings.json'), JSON.stringify({ codeReview: { reviewerHealth: { [reviewer]: health } } }));
    const runReview = () => new Promise((resolve, reject) => {
      const env = { ...process.env, NODE_ENV: 'test', MEMORY_BACKEND: 'file', PORTOS_DATA_ROOT: root };
      delete env.VITEST;
      const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs')], {
        cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Review bridge timed out')); }, 10000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
      child.stdin.end(JSON.stringify({ backend: reviewer, model: 'example-model', inheritDefaults: false, kind: 'claim-review', diff: 'example diff' }));
    });
    const cases = [
      ['invalid_json', 'synthetic-private-output', 'length', 'length'],
      ['oversized_content', 'x'.repeat(25000), 'stop', 'stop'],
      ['invalid_envelope', '{"verdict":"clean","findings":[],"secret":"synthetic-secret"}', undefined, 'unknown'],
      ['incomplete_finding', '{"verdict":"findings","findings":[{}]}', 'synthetic-private-metadata', 'unknown'],
      ['verdict_findings_mismatch', '{"verdict":"findings","findings":[]}', undefined, 'unknown'],
    ];
    for (const [reason, responseContent, finish, normalizedFinish] of cases) {
      content = responseContent;
      finishReason = finish;
      const malformed = await runReview();
      expect(malformed.code).toBe(1);
      const result = JSON.parse(malformed.stdout);
      const diagnostics = { reason, finishReason: normalizedFinish, responseLengthChars: Math.min(content.length, 20001), responseLengthCapped: content.length > 20001 };
      expect(result).toMatchObject({ ok: false, code: 'MALFORMED_REVIEW', diagnostics });
      expect(result).not.toHaveProperty('findings');
      expect(result).not.toHaveProperty('verdict');
      const persisted = JSON.parse(await readFile(join(root, 'data/settings.json'), 'utf8'));
      expect(persisted.codeReview.reviewerHealth[reviewer]).toEqual({ code: 'MALFORMED_REVIEW', reason: 'malformed', failureCount: expect.any(Number), lastFailureAt: expect.any(Number), diagnostics });
      expect(malformed.stdout + malformed.stderr + JSON.stringify(persisted)).not.toContain(content);
      expect(malformed.stdout + malformed.stderr + JSON.stringify(persisted)).not.toContain('synthetic-private-metadata');
    }
    content = JSON.stringify({ verdict: 'findings', findings: [{ severity: 'blocking', location: 'example.js:12', outcome: 'Overlapping writes lose edits.', fix: 'Serialize writes.' }] });
    const completed = await runReview();
    expect(completed.code, completed.stderr).toBe(0);
    expect(JSON.parse(completed.stdout)).toMatchObject({ ok: true, verdict: 'findings' });
    expect(JSON.parse(await readFile(join(root, 'data/settings.json'), 'utf8')).codeReview).not.toHaveProperty('reviewerHealth');
  } finally {
    await new Promise(resolve => api.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('supports --report-failure and --active-group directly via the standalone bridge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-bridge-report-test-'));
  try {
    await symlink(fileURLToPath(new URL('../', import.meta.url)), join(root, 'server'), 'junction');
    const data = join(root, 'data');
    await mkdir(data);
    await writeFile(join(data, 'settings.json'), JSON.stringify({
      codeReview: {
        reviewerFallbackGroups: [['ollama'], ['lmstudio']],
        reviewerHealth: {},
      },
    }));

    const testEnv = { ...process.env, NODE_ENV: 'test', MEMORY_BACKEND: 'file', PORTOS_DATA_ROOT: root };
    delete testEnv.VITEST;

    // 1. Query initial active group via CLI flag
    const initialActive = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs'), '--active-group'], {
        cwd: root,
        env: testEnv,
      });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', code => resolve({ code, stdout }));
      child.on('error', reject);
    });
    expect(initialActive.code).toBe(0);
    expect(JSON.parse(initialActive.stdout)).toEqual({ ok: true, activeGroup: ['ollama'] });

    // 2. Report quota failure directly via CLI flag
    const reported = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs'), '--report-failure', 'ollama', '--reason', 'quota'], {
        cwd: root,
        env: testEnv,
      });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', code => resolve({ code, stdout }));
      child.on('error', reject);
    });
    expect(reported.code).toBe(0);
    expect(JSON.parse(reported.stdout)).toEqual({ ok: true, recorded: true });

    // 3. Fallback tier is now active
    const nextActive = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', join(root, 'server/scripts/run-local-code-review.mjs'), '--active-group'], {
        cwd: root,
        env: testEnv,
      });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('close', code => resolve({ code, stdout }));
      child.on('error', reject);
    });
    expect(nextActive.code).toBe(0);
    expect(JSON.parse(nextActive.stdout)).toEqual({ ok: true, activeGroup: ['lmstudio'] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

