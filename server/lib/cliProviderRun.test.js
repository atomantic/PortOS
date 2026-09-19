import { describe, it, expect, vi } from 'vitest';

// Wrap the REAL resolveWindowsExecutable in a spy (not a stub) so every
// existing real-spawn test below is unaffected (a no-op pass-through on the
// non-win32 host running this suite) while one test can force a specific
// resolved path to prove runCliProviderPrompt actually spawns it.
vi.mock('./bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveWindowsExecutable: vi.fn(actual.resolveWindowsExecutable) };
});

const { pickCliProvider, runCliProviderPrompt } = await import('./cliProviderRun.js');
const { resolveWindowsExecutable } = await import('./bufferedSpawn.js');
const { resolveBootstrapEnv } = await import('./credentialBootstrap.js');

const cli = (id, extra = {}) => ({ id, type: 'cli', command: id, enabled: true, models: [], ...extra });

// A harness that reports what it actually received, and a stand-in for a real
// minting wrapper: it execs \`<harness> <args...>\` with a credential in the
// child's environment, exactly as \`<bootstrap> run <harness> -- <args>\` does at
// a shell.
async function writeBootstrapFixture(dir) {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const command = join(dir, 'claude');
  await writeFile(command, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), auth: process.env.ANTHROPIC_AUTH_TOKEN || null, wrapperToken: process.env.EXAMPLE_WRAPPER_TOKEN || null })));', { mode: 0o755 });
  const bootstrap = join(dir, 'token-cli');
  await writeFile(bootstrap, [
    '#!/usr/bin/env node',
    'const { spawn } = require("child_process");',
    'const [, , mode, harness, ...rest] = process.argv;',
    'if (mode !== "run") { process.exit(64); }',
    'const args = rest[0] === "--" ? rest.slice(1) : rest;',
    'const child = spawn(harness, args, { stdio: "inherit", env: { ...process.env, EXAMPLE_WRAPPER_TOKEN: "example-wrapper-token" } });',
    'child.on("exit", (code) => process.exit(code ?? 1));',
  ].join('\n'), { mode: 0o755 });
  return { command, bootstrap };
}

describe('pickCliProvider', () => {
  const providers = {
    'claude-code': cli('claude-code', { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7', 'claude-haiku-4-5'] }),
    'codex': cli('codex', { defaultModel: 'codex-configured-default', models: ['codex-configured-default'] }),
    'antigravity-cli': cli('antigravity-cli', { command: 'agy', defaultModel: 'antigravity-configured-default', models: ['antigravity-configured-default'] }),
    'ollama': { id: 'ollama', type: 'api', enabled: true, defaultModel: 'llama3' },
    'disabled-cli': cli('disabled-cli', { enabled: false }),
  };

  it('accepts the on-disk map shape (keyed by id)', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'codex' });
    expect(provider.id).toBe('codex');
  });

  it('accepts an array shape', () => {
    const { provider } = pickCliProvider(Object.values(providers), { providerId: 'antigravity-cli' });
    expect(provider.id).toBe('antigravity-cli');
  });

  it('falls back to claude-code when providerId is unset', () => {
    const { provider, model } = pickCliProvider(providers, {});
    expect(provider.id).toBe('claude-code');
    expect(model).toBe('claude-opus-4-7');
  });

  it('falls back to claude-code when the requested provider does not exist', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'nonexistent' });
    expect(provider.id).toBe('claude-code');
  });

  it('honors a custom fallbackId', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'nope', fallbackId: 'codex' });
    expect(provider.id).toBe('codex');
  });

  it('never selects an API provider', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'ollama' });
    expect(provider.id).not.toBe('ollama');
    expect(provider.type).toBe('cli');
  });

  it('never selects a disabled CLI provider', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'disabled-cli' });
    expect(provider.id).not.toBe('disabled-cli');
  });

  it('honors a requested model when the provider offers it', () => {
    const { model } = pickCliProvider(providers, { providerId: 'claude-code', model: 'claude-haiku-4-5' });
    expect(model).toBe('claude-haiku-4-5');
  });

  it('drops a stale model the provider does not offer, falling back to its default', () => {
    const { model } = pickCliProvider(providers, { providerId: 'claude-code', model: 'gemini-2.5-pro' });
    expect(model).toBe('claude-opus-4-7');
  });

  it('errors when no CLI provider is configured', () => {
    const result = pickCliProvider({ ollama: providers.ollama }, {});
    expect(result.error).toMatch(/No enabled CLI provider/);
  });

  // A locally-backed provider's `models` array is a cached snapshot; the daemon
  // is the authority. Judging the pin against the record drops a model the user
  // just pulled and silently downgrades the run to the provider's default.
  it('honors a model pin on a local-runtime provider whose cached list omits it', () => {
    const local = cli('grok-ollama', {
      command: 'grok', ollamaBacked: true,
      models: ['qwen3-coder:30b'], defaultModel: 'qwen3-coder:30b',
    });
    const { model } = pickCliProvider([local], { providerId: 'grok-ollama', model: 'gemma3:27b' });
    expect(model).toBe('gemma3:27b');
  });

  // A provider that enumerates nothing has no catalog to validate against, so
  // the pin stands rather than collapsing to the provider default.
  it('honors a model pin on a provider that enumerates no models', () => {
    const bare = cli('bare-cli', { defaultModel: 'configured-default' });
    const { model } = pickCliProvider([bare], { providerId: 'bare-cli', model: 'anything-goes' });
    expect(model).toBe('anything-goes');
  });
});

describe('runCliProviderPrompt', () => {
  it('refuses unknown safety profiles, unsupported commands, and extra arguments before spawning', async () => {
    for (const args of [
      { provider: cli('claude'), safetyProfile: 'unknown-profile' },
      { provider: cli('custom-agent'), safetyProfile: 'public-review-gate' },
      { provider: cli('claude'), safetyProfile: 'public-review-gate', extraArgs: ['--dangerously-skip-permissions'] },
    ]) {
      expect(await runCliProviderPrompt({ ...args, prompt: 'untrusted diff' })).toMatchObject({ error: expect.stringContaining('no enforced tool-free') });
    }
  });

  it.skipIf(process.platform === 'win32')('enforces the shared no-tool argv and environment on an actual child', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-test-'));
    const command = join(dir, 'claude');
    await writeFile(command, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({ args: process.argv.slice(2), forgeToken: process.env.GH_TOKEN || null })));', { mode: 0o755 });
    const result = await runCliProviderPrompt({
      provider: { ...cli('example-claude'), command, args: ['--dangerously-skip-permissions', '--model', 'wrong-model'], envVars: { GH_TOKEN: 'example-secret' } },
      model: 'pinned-model', prompt: 'untrusted diff', cwd: dir, safetyProfile: 'public-review-gate',
    }).finally(() => rm(dir, { recursive: true, force: true }));
    expect(result.partial).toBe(false);
    const child = JSON.parse(result.text);
    expect(child.args).toEqual(expect.arrayContaining(['--restricted', '--tools', '', '--model', 'pinned-model']));
    expect(child.args).not.toContain('--dangerously-skip-permissions');
    expect(child.args).not.toContain('wrong-model');
    expect(child.forgeToken).toBeNull();
  });

  // #7720: the tool-free reviewer spawn IS credential-bootstrap-wrapped, and
  // both halves of that have to hold at once — the harness must receive the
  // enforced recipe unchanged THROUGH the wrapper, and it must receive the
  // credential the wrapper mints, which a bare spawn could never give it.
  // Spawned bare, a bootstrap-only record answers "no matching provider is
  // authenticated" and the review gate waits out a round that never completes.
  it.skipIf(process.platform === 'win32')('runs the enforced no-tool recipe THROUGH the credential bootstrap, so the reviewer starts authenticated', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-bootstrap-'));
    const { command, bootstrap } = await writeBootstrapFixture(dir);
    const provider = { ...cli('example-claude'), command,
      credentialBootstrap: { command: bootstrap, args: ['run'], argsSeparator: '--' } };
    const result = await runCliProviderPrompt({
      provider, model: 'pinned-model', prompt: 'untrusted diff', cwd: dir, safetyProfile: 'public-review-gate',
    }).finally(() => rm(dir, { recursive: true, force: true }));
    expect(result.error).toBeUndefined();
    const child = JSON.parse(result.text);
    expect(child.args).toEqual(expect.arrayContaining(['--restricted', '--tools', '', '--model', 'pinned-model']));
    // The wrapper is an intermediary, not a way around the recipe.
    expect(child.args).not.toContain('--dangerously-skip-permissions');
    expect(child.wrapperToken).toBe('example-wrapper-token');
  });

  // The other credential shape: a bootstrap that PRINTS assignments rather than
  // exec'ing the harness. `resolveBootstrapEnv` materializes them separately —
  // the command never sees the prompt or the enforced argv — and only recognized
  // auth keys survive `buildCliChildEnv`.
  it.skipIf(process.platform === 'win32')('also delivers credentials a bootstrap prints rather than execs', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'review-cli-bootstrap-env-'));
    const { command, bootstrap } = await writeBootstrapFixture(dir);
    const provider = { ...cli('example-claude'), command, credentialBootstrap: { command: bootstrap, args: ['run'], argsSeparator: '--',
      envCommand: [process.execPath, '-e', 'console.log("ANTHROPIC_AUTH_TOKEN=example-token")'] } };
    const bootstrapEnv = await resolveBootstrapEnv(provider, { safetyProfile: 'public-review-gate' });
    const result = await runCliProviderPrompt({
      provider, bootstrapEnv, model: 'pinned-model', prompt: 'untrusted diff', cwd: dir, safetyProfile: 'public-review-gate',
    }).finally(() => rm(dir, { recursive: true, force: true }));
    expect(result.error).toBeUndefined();
    const child = JSON.parse(result.text);
    expect(child.args).toEqual(expect.arrayContaining(['--restricted', '--tools', '']));
    expect(child.auth).toBe('example-token');
  });

  it('rejects a missing command without spawning', async () => {
    const result = await runCliProviderPrompt({ provider: { id: 'x' }, prompt: 'hi' });
    expect(result.error).toMatch(/no command/i);
  });

  it('rejects an empty prompt without spawning', async () => {
    const result = await runCliProviderPrompt({ provider: cli('antigravity-cli'), prompt: '' });
    expect(result.error).toMatch(/non-empty/);
  });

  it('delivers the prompt via stdin and collects stdout', async () => {
    // A legacy gemini-cli test double with no model returns [] (no flags), so `cat`
    // simply echoes stdin back out — a clean end-to-end spawn test.
    const result = await runCliProviderPrompt({
      provider: { id: 'gemini-cli', type: 'cli', command: 'cat', args: [] },
      prompt: 'hello stdin world',
    });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('hello stdin world');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a spawn failure for a nonexistent binary', async () => {
    const result = await runCliProviderPrompt({
      provider: { id: 'gemini-cli', type: 'cli', command: 'this-binary-does-not-exist-xyz', args: [] },
      prompt: 'hi',
    });
    expect(result.error).toMatch(/Failed to spawn/);
  });

  it('settles cleanly when the child exits before reading stdin (no EPIPE crash)', async () => {
    // `true` exits 0 immediately and never drains stdin. Writing a large prompt
    // to its closed stdin would emit EPIPE — the helper must swallow that and
    // resolve via the close handler instead of throwing an unhandled error.
    const result = await runCliProviderPrompt({
      provider: { id: 'gemini-cli', type: 'cli', command: 'true', args: [] },
      prompt: 'x'.repeat(100000),
    });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });

  it('spawns the resolveWindowsExecutable-resolved path when one is found (#1865)', async () => {
    // Force resolution to a real binary (resolved via `which`, so this works
    // regardless of the host's exact PATH layout) so the round-trip still
    // completes — proves the resolved path, not the bare provider.command,
    // is what actually gets spawned.
    const { execFileSync } = await import('./childProcess.js');
    const isWin = process.platform === 'win32';
    const catPath = isWin
      ? execFileSync('where', ['node']).toString().split(/\r?\n/)[0].trim()
      : execFileSync('which', ['cat']).toString().trim();
    vi.mocked(resolveWindowsExecutable).mockReturnValueOnce(catPath);
    const result = await runCliProviderPrompt({
      provider: {
        id: 'gemini-cli',
        type: 'cli',
        command: 'this-name-is-never-spawned-directly',
        args: isWin ? ['-e', 'process.stdin.pipe(process.stdout)'] : [],
      },
      prompt: 'resolved path round-trip',
    });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('resolved path round-trip');
    expect(result.exitCode).toBe(0);
  });

  // #5302: a non-zero exit that still printed is returned for parsing, but the
  // text may be truncated — callers gate destructive use on `partial === false`.
  describe('non-zero exit agreement', () => {
    const shell = { id: 'gemini-cli', type: 'cli', command: process.platform === 'win32' ? 'cmd' : 'sh' };
    const shellArgs = (script) => (process.platform === 'win32' ? ['/c', script] : ['-c', script]);

    it.skipIf(process.platform === 'win32')('flags stdout from a non-zero exit as partial and carries a stderr tail', async () => {
      const result = await runCliProviderPrompt({
        provider: shell,
        prompt: 'ignored',
        extraArgs: shellArgs('echo \'{"calendars":[\'; echo "rate limit reached" >&2; exit 3'),
      });
      expect(result.error).toBeUndefined();
      expect(result.text).toBe('{"calendars":[');
      expect(result.exitCode).toBe(3);
      expect(result.partial).toBe(true);
      expect(result.stderrTail).toContain('rate limit reached');
    });

    it.skipIf(process.platform === 'win32')('marks a clean exit as not partial', async () => {
      const result = await runCliProviderPrompt({
        provider: shell,
        prompt: 'ignored',
        extraArgs: shellArgs('echo ok'),
      });
      expect(result.partial).toBe(false);
      expect(result.exitCode).toBe(0);
    });

    it.skipIf(process.platform === 'win32')('still errors on a non-zero exit with no stdout, exposing the tail', async () => {
      const result = await runCliProviderPrompt({
        provider: shell,
        prompt: 'ignored',
        extraArgs: shellArgs('echo "boom" >&2; exit 4'),
      });
      expect(result.error).toContain('boom');
      expect(result.exitCode).toBe(4);
      expect(result.stderrTail).toContain('boom');
      expect(result.partial).toBeUndefined();
    });
  });
});

// #7496. With a credentialBootstrap provider the direct child is the user's
// bootstrap CLI, not the harness, and `<bootstrap> run <harness> -- <args>` is
// the shape of a supervising PARENT. Stop/timeout is a safety control, so the
// timeout must take down the harness behind the wrapper, not just the wrapper.
describe('runCliProviderPrompt — credential-bootstrap process-group teardown', () => {
  // `sh -c cat <harnessId>` runs `cat` with $0 set to the harness id, so the
  // stdin round-trip still works through a real bootstrap-shaped wrap.
  const bootstrapProvider = {
    id: 'gemini-cli',
    type: 'cli',
    command: 'cat',
    args: [],
    credentialBootstrap: { command: 'sh', args: ['-c', 'cat'] },
  };

  it.skipIf(process.platform === 'win32')('round-trips the prompt through the bootstrap wrapper', async () => {
    const result = await runCliProviderPrompt({ provider: bootstrapProvider, prompt: 'wrapped round-trip' });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('wrapped round-trip');
  });

  // The end-to-end proof of the whole change: a wrapper that IGNORES SIGTERM
  // and leaves a live grandchild is exactly the shape the issue describes.
  // Under the old per-pid kill the `sleep` outlived the run; the group kill
  // reaps it with its parent.
  it.skipIf(process.platform === 'win32')('takes the harness down with the wrapper on timeout', async () => {
    const result = await runCliProviderPrompt({
      provider: {
        id: 'gemini-cli',
        type: 'cli',
        command: 'stand-in-harness',
        args: [],
        // A no-op TERM handler, so the wrapper survives the signal without
        // forwarding it — a trap of "" instead would set SIG_IGN, which the
        // grandchild INHERITS, and the test would then prove nothing about
        // reach. Print the grandchild's pid so the assertion can probe it.
        credentialBootstrap: { command: 'sh', args: ['-c', 'trap ":" TERM; sleep 30 & echo $!; wait'] },
      },
      prompt: 'ignored',
      timeoutMs: 300,
    });

    expect(result.error).toMatch(/timed out/);
    const grandchildPid = Number(result.text.trim());
    expect(Number.isInteger(grandchildPid)).toBe(true);

    // Signal 0 probes for existence without delivering anything. The group
    // SIGTERM has to have reached the `sleep`, not just the trapping wrapper.
    await new Promise(resolve => setTimeout(resolve, 200));
    let alive = true;
    try { process.kill(grandchildPid, 0); } catch { alive = false; }
    if (alive) process.kill(grandchildPid, 'SIGKILL');
    expect(alive).toBe(false);
  });
});
