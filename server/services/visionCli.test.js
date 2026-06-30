import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

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
    expect(inv.args).toContain('/tmp/x/vision-input.png');
    expect(inv.args).toContain('-m');
    expect(inv.args).toContain('gpt-5');
    expect(inv.args[inv.args.length - 1]).toBe('describe'); // prompt is positional
    expect(inv.stdin).toBeNull();
    expect(inv.cwd).toBe('/tmp/x');
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
    expect(inv.cwd).toBe('/tmp/y');
  });
});

// A minimal child-process double: an EventEmitter with stdin/stdout/stderr.
function makeFakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });
  child.stdin = { write: vi.fn(), end: vi.fn() };
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
