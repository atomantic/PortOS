import { describe, it, expect, vi } from 'vitest';
import { posixPath } from '../lib/testHelper.js';

import { EventEmitter } from 'events';
import { ChildProcess } from '../lib/childProcess.js';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Wrap the REAL resolveWindowsExecutable/prepareWindowsSafeSpawn in spies
// (not stubs) so every existing test below is unaffected (both are no-op
// pass-throughs on the non-win32 host running this suite) while one test
// can force a specific resolved path, or force isWin32 on the wrap, to
// prove describeImageViaCli actually spawns the result.
vi.mock('../lib/bufferedSpawn.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveWindowsExecutable: vi.fn(actual.resolveWindowsExecutable),
    prepareWindowsSafeSpawn: vi.fn(actual.prepareWindowsSafeSpawn),
  };
});

const {
  decodeImageDataUrl,
  buildCliVisionInvocation,
  prepareCliVisionRun,
  describeImageViaCli,
} = await import('./visionCli.js');
const { resolveWindowsExecutable, prepareWindowsSafeSpawn } = await import('../lib/bufferedSpawn.js');

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;

describe('decodeImageDataUrl', () => {
  it('decodes the base64 payload to bytes', () => {
    expect(decodeImageDataUrl(PNG_DATA_URL).toString()).toBe('fake-png');
  });

  it('throws on a non-image / malformed data URL', () => {
    expect(() => decodeImageDataUrl('not-a-data-url')).toThrow(/base64 image data URL/);
    expect(() => decodeImageDataUrl('data:image/png;base64,')).toThrow(/no base64 payload/);
  });
});

describe('buildCliVisionInvocation', () => {
  it('attaches the image via -i and a positional prompt for codex', () => {
    const inv = buildCliVisionInvocation(
      { id: 'codex', command: 'codex', args: [] }, 'gpt-5', '/tmp/x', 'describe',
    );
    expect(inv.command).toBe('codex');
    expect(inv.args).toContain('-i');
    expect(posixPath(inv.args)).toContain('/tmp/x/vision-input.png');
    expect(inv.args).toContain('-m');
    expect(inv.args).toContain('gpt-5');
    expect(inv.args[inv.args.length - 1]).toBe('describe'); // prompt is positional
    // Codex's startup update check is disabled so it can't stall / brew-upgrade
    // under the vision timeout.
    expect(inv.args).toEqual(expect.arrayContaining(['-c', 'check_for_update_on_startup=false']));
    expect(inv.stdin).toBeNull();
    expect(posixPath(inv.cwd)).toBe('/tmp/x');
  });

  it('omits -m for the codex-configured-default sentinel (falls back to config.toml)', () => {
    const inv = buildCliVisionInvocation(
      { id: 'codex', command: 'codex', args: [] }, 'codex-configured-default', '/tmp/x', 'p',
    );
    expect(inv.args).not.toContain('-m');
    expect(inv.args).not.toContain('codex-configured-default');
  });

  it('does not double-add exec when the provider args already pin it', () => {
    const inv = buildCliVisionInvocation(
      { id: 'codex', command: 'codex', args: ['exec'] }, null, '/tmp/x', 'p',
    );
    expect(inv.args.filter((a) => a === 'exec')).toHaveLength(1);
  });

  it('uses stdin + cwd-local file reference for claude-code', () => {
    const inv = buildCliVisionInvocation(
      { id: 'claude-code', command: 'claude', args: [] }, 'claude-opus-4-8', '/tmp/y', 'describe',
    );
    expect(inv.command).toBe('claude');
    expect(inv.args).toEqual(expect.arrayContaining(['-p', '-', '--model', 'claude-opus-4-8']));
    expect(inv.stdin).toContain('describe');
    expect(inv.stdin).toContain('vision-input.png');
    expect(posixPath(inv.cwd)).toBe('/tmp/y');
  });

  it('attaches every named frame and injects effort for a multi-image Codex call', () => {
    const inv = buildCliVisionInvocation(
      { id: 'codex', command: 'codex', args: [] },
      'gpt-5',
      '/tmp/x',
      'describe motion',
      { imageNames: ['vision-1.jpg', 'vision-2.jpg'], effort: 'high' },
    );
    const paths = inv.args.map((a) => posixPath(a));
    expect(paths.filter((a) => a === '-i')).toHaveLength(2);
    expect(paths).toContain('/tmp/x/vision-1.jpg');
    expect(paths).toContain('/tmp/x/vision-2.jpg');
    expect(inv.args).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=high']));
  });

  it('lists every frame in the Claude stdin prompt and passes effort through buildCliArgs', () => {
    const inv = buildCliVisionInvocation(
      { id: 'claude-code', command: 'claude', args: [] },
      'claude-opus-4-8',
      '/tmp/y',
      'describe motion',
      { imageNames: ['vision-1.jpg', 'vision-2.jpg'], effort: 'high' },
    );
    expect(inv.stdin).toContain('vision-1.jpg');
    expect(inv.stdin).toContain('vision-2.jpg');
    expect(inv.stdin).toMatch(/chronological/i);
    expect(inv.args).toEqual(expect.arrayContaining(['--effort', 'high']));
  });
});

describe('prepareCliVisionRun', () => {
  it('stages multiple files for the shared runner and removes them on cleanup', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'portos-vision-source-'));
    try {
      const first = join(sourceDir, 'first.png');
      const second = join(sourceDir, 'second.jpg');
      await Promise.all([writeFile(first, 'one'), writeFile(second, 'two')]);
      const prepared = await prepareCliVisionRun({
        provider: { id: 'codex', command: 'codex', args: [] },
        imagePaths: [first, second],
        prompt: 'compare',
        model: 'gpt-5',
        effort: 'high',
      });
      expect(prepared.invocation.args.filter((arg) => arg === '-i')).toHaveLength(2);
      expect(prepared.invocation.cwd).toMatch(/portos-vision-run-/);
      await prepared.cleanup();
      await expect(import('fs/promises').then(({ stat }) => stat(prepared.invocation.cwd))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });
});

// A minimal child-process double: an EventEmitter with stdin/stdout/stderr.
function makeFakeChild() {
  const child = new EventEmitter();
  // killProcessTree tells a spawned child from a node-pty session by
  // `instanceof ChildProcess` (a pty takes a different kill shape), so the fake
  // has to carry the prototype the way a real spawn() result does.
  Object.setPrototypeOf(child, ChildProcess.prototype);
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });
  // A real ChildProcess stdin is a stream — the fake is one too, or the
  // production guardChildStdin listener has nothing to attach to (#5655).
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

// A spawnImpl that drives `child` through `script(child)` *after* the caller's
// synchronous spawn-and-listen block has run. describeImageViaCli awaits
// mkdtemp+writeFile, then synchronously spawns and attaches its data/close/error
// listeners; deferring the script to a microtask guarantees those listeners are
// attached before any event fires. A fixed `setTimeout` instead raced those
// async file ops and dropped events on the floor (no listener yet) under CI
// load, hanging the promise until the 10s test timeout.
function spawnEmitting(child, script) {
  return vi.fn(() => { queueMicrotask(() => script(child)); return child; });
}

describe('describeImageViaCli', () => {
  it('returns the trimmed stdout text in the API-compatible shape on exit 0', async () => {
    const child = makeFakeChild();
    const spawnImpl = spawnEmitting(child, (c) => {
      c.stdout.emit('data', Buffer.from('  a woman in a red cloak  '));
      c.emit('close', 0);
    });
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption this',
      model: 'gpt-5',
      spawnImpl,
    });
    const result = await promise;
    expect(result).toEqual({
      text: 'a woman in a red cloak', finishReason: null, usage: null, reasoning: '',
    });
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it('wraps a resolved .cmd shim via cmd.exe /c, preserving the multi-word prompt as one arg (#1865)', async () => {
    const resolvedPath = 'C:\\Users\\Joe\\AppData\\Roaming\\npm\\codex.cmd';
    vi.mocked(resolveWindowsExecutable).mockReturnValueOnce(resolvedPath);
    // Force the wrap's win32 branch (host running this suite is never win32)
    // to exercise the real cmd.exe /c contract, not the identity pass-through.
    const { prepareWindowsSafeSpawn: realPrepare } = await vi.importActual('../lib/bufferedSpawn.js');
    vi.mocked(prepareWindowsSafeSpawn).mockImplementationOnce((cmd, args) => realPrepare(cmd, args, true));

    const child = makeFakeChild();
    const spawnImpl = spawnEmitting(child, (c) => {
      c.stdout.emit('data', Buffer.from('caption'));
      c.emit('close', 0);
    });
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      // Free-text prompt with spaces — the exact scenario that broke under
      // the prior (rejected) shell:true approach: shell:true + an args array
      // doesn't escape arguments, so this would have silently mis-split into
      // extra shell tokens. The cmd.exe wrapper relies on Node's own correct
      // non-shell argv escaping instead, which keeps it as one token.
      prompt: 'describe this photo in detail',
      spawnImpl,
    });
    await promise;
    const [spawnedCommand, spawnedArgs, options] = spawnImpl.mock.calls[0];
    expect(spawnedCommand).toBe('cmd.exe');
    expect(spawnedArgs[0]).toBe('/c');
    expect(spawnedArgs[1]).toBe(resolvedPath);
    expect(spawnedArgs[spawnedArgs.length - 1]).toBe('describe this photo in detail');
    // Never falls back to shell:true (DEP0190) — the cmd.exe wrapper relies
    // on Node's own correct non-shell argv escaping instead.
    expect(options.shell).toBeUndefined();
  });

  it('strips the codex session transcript down to the assistant reply', async () => {
    const child = makeFakeChild();
    // A realistic codex exec transcript: banner … \ncodex\n<reply>\ntokens used …
    const transcript = [
      'OpenAI Codex v0.141.0',
      '--------',
      'user',
      'caption',
      'codex',
      'a woman in a red cloak, bust shot',
      'tokens used: 1234',
    ].join('\n');
    const spawnImpl = spawnEmitting(child, (c) => {
      c.stdout.emit('data', Buffer.from(transcript));
      c.emit('close', 0);
    });
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption',
      model: 'gpt-5',
      spawnImpl,
    });
    const result = await promise;
    expect(result.text).toBe('a woman in a red cloak, bust shot');
  });

  it('extracts the assistant reply when codex emits it AFTER the tokens-used footer', async () => {
    const child = makeFakeChild();
    // Newer codex format: the final reply follows the `tokens used\n<count>` footer.
    const transcript = [
      'OpenAI Codex v0.141.0',
      'codex',
      '(intermediate working notes)',
      'tokens used',
      '1234',
      '{"boxes":[{"x":0,"y":0,"w":0.5,"h":1}]}',
    ].join('\n');
    const spawnImpl = spawnEmitting(child, (c) => {
      c.stdout.emit('data', Buffer.from(transcript));
      c.emit('close', 0);
    });
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption',
      spawnImpl,
    });
    const result = await promise;
    expect(result.text).toBe('{"boxes":[{"x":0,"y":0,"w":0.5,"h":1}]}');
  });

  it('rejects with a tail of stderr on a non-zero exit', async () => {
    const child = makeFakeChild();
    const spawnImpl = spawnEmitting(child, (c) => {
      c.stderr.emit('data', Buffer.from('vision unavailable'));
      c.emit('close', 1);
    });
    const promise = describeImageViaCli({
      provider: { id: 'claude-code', command: 'claude', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption',
      spawnImpl,
    });
    await expect(promise).rejects.toThrow(/exited 1.*vision unavailable/s);
  });

  it('rejects when the process fails to spawn', async () => {
    const child = makeFakeChild();
    const spawnImpl = spawnEmitting(child, (c) => {
      c.emit('error', new Error('ENOENT'));
    });
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'p',
      spawnImpl,
    });
    await expect(promise).rejects.toThrow(/Failed to spawn codex.*ENOENT/s);
  });

  it('rejects (and does not hang) when the child exceeds the timeout', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'p',
      timeout: 20,
      spawnImpl,
    });
    // The child never emits `close` (simulates a wedged process); the timeout
    // must SIGTERM it and reject on its own rather than awaiting `close`.
    await expect(promise).rejects.toThrow(/timed out after 20ms/);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('contains an EPIPE on stdin from a vision CLI that died before reading the prompt (#5655)', async () => {
    // describeImageViaCli runs outside the Express request lifecycle, so an
    // unlistened 'error' on the stdin stream would kill the server process
    // instead of rejecting this promise.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const child = makeFakeChild();
    let listenersAtWriteTime = null;
    child.stdin.write = vi.fn(() => {
      listenersAtWriteTime = child.stdin.listenerCount('error');
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    const spawnImpl = spawnEmitting(child, (c) => {
      expect(() => c.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
      c.emit('close', 1);
    });

    // claude-code is the stdin-delivering vision provider (codex puts the
    // prompt in argv and never writes the pipe).
    await expect(describeImageViaCli({
      provider: { id: 'claude-code', command: 'claude', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption this',
      spawnImpl,
    })).rejects.toThrow(/exited 1/);

    expect(listenersAtWriteTime).toBe(1);
    // The pipe is closed anyway, so a child still reading stdin sees EOF.
    expect(child.stdin.destroy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('throws on a malformed data URL before spawning', async () => {
    const spawnImpl = vi.fn();
    await expect(describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: 'garbage',
      prompt: 'p',
      spawnImpl,
    })).rejects.toThrow(/base64 image data URL/);
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
