import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import EventEmitter from 'events';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: vi.fn() };
});

const { spawn } = await import('child_process');
const { createRunnerService } = await import('./runner.js');

describe('AI Toolkit runner service', () => {
  const tempDirs = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('checks provider readiness through the injected hook before API fetches', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    const provider = {
      id: 'ollama',
      name: 'Ollama',
      endpoint: 'http://localhost:11434/v1',
      defaultModel: 'llama3'
    };
    const ensureProviderReady = vi.fn(async () => ({ success: false, error: 'service offline' }));
    const onComplete = vi.fn();
    const onRunFailed = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: {
        ensureProviderReady,
        onRunFailed
      }
    });

    await runner.executeApiRun({
      runId: 'run-ready-hook',
      provider,
      model: null,
      prompt: 'hello',
      workspacePath: process.cwd(),
      screenshots: [],
      onData: undefined,
      onComplete
    });

    expect(ensureProviderReady).toHaveBeenCalledWith(provider);
    expect(fetch).not.toHaveBeenCalled();
    expect(onRunFailed).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: false }));

    const metadata = JSON.parse(
      await readFile(join(dataDir, 'runs', 'run-ready-hook', 'metadata.json'), 'utf8')
    );
    expect(metadata).toMatchObject({
      success: false,
      errorCategory: 'unknown'
    });
  });

  const stubStreamingFetch = () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`),
      encoder.encode('data: [DONE]\n')
    ];
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: chunks[i++] }
          : { done: true, value: undefined })
      })
    };
    const fetch = vi.fn(async () => ({ ok: true, body }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  const runReady = (overrides = {}) => ({
    id: 'ollama',
    name: 'Ollama',
    endpoint: 'http://localhost:11434/v1',
    defaultModel: 'llama3',
    ...overrides
  });

  it('sends num_ctx in the request body when the provider opts in', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-numctx', provider: runReady({ numCtx: 32768 }), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0][1].body).num_ctx).toBe(32768);
  });

  it('omits num_ctx when the provider does not set it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);
    const fetch = stubStreamingFetch();

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });
    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({ runId: 'run-no-numctx', provider: runReady(), model: null, prompt: 'hi', workspacePath: process.cwd(), screenshots: [], onData: undefined, onComplete: () => done() });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect('num_ctx' in JSON.parse(fetch.mock.calls[0][1].body)).toBe(false);
  });

  it('anchors relative screenshot refs under screenshotsDir so `../` traversal cannot escape it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    const screenshotsDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-shots-'));
    const secretsDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-secret-'));
    tempDirs.push(dataDir, screenshotsDir, secretsDir);

    // A legitimate in-dir screenshot, plus a secret sitting one level up that a
    // relative `../`-traversal would try to read off disk.
    await writeFile(join(screenshotsDir, 'valid.png'), 'PNGDATA');
    await writeFile(join(secretsDir, 'secret.png'), 'TOPSECRET');

    const fetch = stubStreamingFetch();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const runner = createRunnerService({
      dataDir,
      screenshotsDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-screenshot-guard',
      provider: runReady(),
      model: null,
      prompt: 'describe these',
      workspacePath: process.cwd(),
      // The loader applies basename() to relative refs, so this `../`-traversal
      // collapses to `secret.png` under screenshotsDir (absent there) instead of
      // reading the real sibling file it points at.
      screenshots: ['valid.png', `../${basename(secretsDir)}/secret.png`],
      onData: undefined,
      onComplete: () => done()
    });
    await completed;

    expect(fetch).toHaveBeenCalledTimes(1);
    const sentContent = JSON.parse(fetch.mock.calls[0][1].body).messages[0].content;
    const imageParts = sentContent.filter((p) => p.type === 'image_url');
    // Only the valid in-dir screenshot is forwarded; the traversal entry
    // collapses to a basename that isn't present in screenshotsDir and is
    // skipped.
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0].image_url.url.startsWith('data:image/png;base64,')).toBe(true);
    // The secret file's contents are never base64-encoded into the payload.
    const secretB64 = Buffer.from('TOPSECRET').toString('base64');
    expect(JSON.stringify(sentContent)).not.toContain(secretB64);

    errSpy.mockRestore();
  });

  it('times out a hung API run: aborts the fetch and releases activeRuns', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-'));
    tempDirs.push(dataDir);

    // Simulate a provider that opens the stream then stalls forever — the
    // reader only settles when the run's AbortController fires. Without the
    // wall-clock timeout this would hold `activeRuns` open indefinitely.
    const fetch = vi.fn(async (_url, opts) => {
      const { signal } = opts;
      const body = {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            if (signal.aborted) return fail();
            signal.addEventListener('abort', fail, { once: true });
          }),
          cancel: async () => {}
        })
      };
      return { ok: true, body };
    });
    vi.stubGlobal('fetch', fetch);

    const runner = createRunnerService({
      dataDir,
      hooks: { ensureProviderReady: async () => ({ success: true }) }
    });

    let done;
    const completed = new Promise((resolve) => { done = resolve; });
    await runner.executeApiRun({
      runId: 'run-timeout',
      provider: runReady(),
      model: null,
      prompt: 'hi',
      workspacePath: process.cwd(),
      screenshots: [],
      timeout: 20,
      onData: undefined,
      onComplete: (m) => done(m)
    });

    // The stream is still hanging, so the run is active until the timer fires.
    expect(await runner.isRunActive('run-timeout')).toBe(true);

    const metadata = await completed;
    // Timeout aborted the run, and the slot is released — not leaked.
    expect(await runner.isRunActive('run-timeout')).toBe(false);
    expect(metadata).toMatchObject({ success: false });
  });
});

describe('AI Toolkit runner — declared extension points', () => {
  it('setCliRunner delegates executeCliRun to the host runner and back to the built-in on null', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const builtin = runner.executeCliRun;

    const hostRunner = vi.fn(async (opts) => `host:${opts.runId}`);
    runner.setCliRunner(hostRunner);
    const result = await runner.executeCliRun({ runId: 'r1', provider: { command: 'noop' } });
    expect(result).toBe('host:r1');
    expect(hostRunner).toHaveBeenCalledTimes(1);
    // The override receives the full opts object verbatim.
    expect(hostRunner).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1' }));

    // Reverting restores the built-in implementation.
    runner.setCliRunner(null);
    expect(runner.executeCliRun).toBe(builtin);
  });

  it('setCliRunner / setTuiRunner reject non-function, non-null values', () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(() => runner.setCliRunner(42)).toThrow(/expects a function/);
    expect(() => runner.setTuiRunner('nope')).toThrow(/expects a function/);
  });

  it('setTuiRunner attaches/detaches executeTuiRun so the runs-router gate stays honest', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    // No built-in TUI executor — the runs router gates on typeof === 'function'.
    expect(typeof runner.executeTuiRun).toBe('undefined');

    const tui = vi.fn(async () => 'tui-run');
    runner.setTuiRunner(tui);
    expect(typeof runner.executeTuiRun).toBe('function');
    await runner.executeTuiRun({ runId: 'tui-1' });
    expect(tui).toHaveBeenCalledTimes(1);

    runner.setTuiRunner(null);
    expect(typeof runner.executeTuiRun).toBe('undefined');
  });

  it('external-run registry drives isRunActive / stopRun and reports unknown ids as inactive', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    expect(await runner.isRunActive('x')).toBe(false);

    const child = { kill: vi.fn(), killed: false };
    runner.registerExternalRun('x', child);
    expect(runner.hasExternalRun('x')).toBe(true);
    expect(await runner.isRunActive('x')).toBe(true);

    expect(await runner.stopRun('x')).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    // stopRun drops the entry, so a follow-up reports inactive.
    expect(await runner.isRunActive('x')).toBe(false);
    expect(await runner.stopRun('x')).toBe(false);
  });

  it('stopRun aborts an AbortController-style external run', async () => {
    const runner = createRunnerService({ dataDir: './data' });
    const controller = { abort: vi.fn() };
    runner.registerExternalRun('api-run', controller);
    expect(await runner.stopRun('api-run')).toBe(true);
    expect(controller.abort).toHaveBeenCalledTimes(1);
  });

  it('deleteRun kills an in-flight external run before removing its dir', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-del-'));
    const runner = createRunnerService({ dataDir });
    const child = { kill: vi.fn(), killed: false };
    runner.registerExternalRun('live', child);

    // No on-disk dir for this run, but the live process must still be killed.
    const deleted = await runner.deleteRun('live');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(runner.hasExternalRun('live')).toBe(false);
    // deleteRun returns false when the run dir doesn't exist on disk.
    expect(deleted).toBe(false);

    await rm(dataDir, { recursive: true, force: true });
  });
});

describe('AI Toolkit runner — built-in executeCliRun spawn (#1865)', () => {
  // Mirrors server/services/runner.test.js's equivalent assertion — this is
  // the toolkit's OWN spawn path (inert in PortOS, which always registers a
  // host CLI runner via setCliRunner, but must stay behaviorally in sync per
  // the override-consistency contract in ./CLAUDE.md).
  function makeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.kill = vi.fn();
    child.killed = false;
    return child;
  }

  it('never enables shell:true — resolveWindowsExecutable (not a shell) is the Windows fix', async () => {
    // resolveWindowsExecutable is module-private here, and its IS_WIN32 default
    // is bound once at module load like the rest of the codebase's win32-gated
    // logic (see bufferedSpawn.test.js) — it can't be faked by mutating
    // process.platform mid-test. The resolution ALGORITHM itself is exhaustively
    // covered by server/lib/bufferedSpawn.test.js's injectable-isWin32 tests
    // (this file's copy is a byte-for-byte mirror); this test only pins the
    // wiring — that the built-in spawn never falls back to shell:true (the
    // DEP0190-unsafe approach this directory rejected — see resolveWindowsExecutable
    // docstring above) regardless of platform.
    const dataDir = await mkdtemp(join(tmpdir(), 'ai-toolkit-runner-spawn-'));
    const runner = createRunnerService({ dataDir });
    const child = makeChild();
    spawn.mockReturnValue(child);

    const provider = { id: 'opencode', command: 'opencode', args: [], timeout: 5000, defaultModel: null };
    let resolveComplete;
    const completed = new Promise((resolve) => { resolveComplete = resolve; });

    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('output'));
      child.emit('close', 0);
    });

    await runner.executeCliRun({
      runId: 'builtin-run', provider, prompt: 'test prompt', onComplete: resolveComplete,
    });

    const [command, , options] = spawn.mock.calls.at(-1);
    expect(options.shell).toBeFalsy();
    // Off win32 (the host actually running this suite), resolution is a no-op
    // and the bare command is spawned unchanged.
    if (process.platform !== 'win32') expect(command).toBe('opencode');

    // The 'close' handler's atomicWrite calls run after executeCliRun returns
    // — wait for completion before removing dataDir, or rm races the writes.
    await completed;
    await rm(dataDir, { recursive: true, force: true });
  });
});
