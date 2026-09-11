import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-test override so one suite can hold both the deterministic EPIPE cases
// below and a future real-binary case without vi.mock's per-file hoisting
// forcing a choice between them (see fineTuning.test.js for the same shape).
let spawnOverride = null;

vi.mock('../../lib/childProcess.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => (spawnOverride ? spawnOverride(...args) : actual.spawn(...args)) };
});

const { synthesizePiper } = await import('./tts-piper.js');
const { IS_WIN } = await import('./config.js');

// A minimal child-process double: an EventEmitter with stdin/stdout/stderr.
// stdin is itself an EventEmitter (not a bare stub) so the production
// guardChildStdin listener has something real to attach to.
function makeFakeChild() {
  const child = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), destroy: vi.fn() });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('synthesizePiper', () => {
  let voiceDir;
  let voicePath;

  beforeEach(async () => {
    voiceDir = await mkdtemp(join(tmpdir(), 'portos-piper-voice-'));
    voicePath = join(voiceDir, 'test-voice.onnx');
    await writeFile(voicePath, Buffer.from('fake-onnx-model'));
    spawnOverride = null;
  });

  afterEach(async () => {
    spawnOverride = null;
    await rm(voiceDir, { recursive: true, force: true });
  });

  // #7006: an unlistened 'error' on child.stdin re-throws in Node and crashes
  // the whole server process (there is no request lifecycle to catch it).
  // Piper emits exactly this when it exits (missing shared libs, bad flags)
  // before finishing its read of stdin.
  it('rejects cleanly instead of crashing when piper closes stdin before reading it (EPIPE)', async () => {
    const child = makeFakeChild();
    spawnOverride = vi.fn(() => child);

    const promise = synthesizePiper('hello world', { piper: { voice: 'test-voice', voicePath } });

    // The stdin guard attaches via a lazily-imported module (see tts-piper.js),
    // so wait for the listener to land before probing it.
    await vi.waitFor(() => { if (child.stdin.listenerCount('error') === 0) throw new Error('stdin guard not attached yet'); });

    // Emitting 'error' on stdin must not throw synchronously — that would mean
    // no listener was attached and Node would treat it as an uncaught error.
    expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();

    // The child's own close handler is the authoritative settle point.
    child.stderr.emit('data', Buffer.from('piper: failed to load shared library'));
    child.emit('close', 1);

    await expect(promise).rejects.toThrow(/piper exited 1/);
  });

  it('rejects cleanly when the piper binary fails to spawn at all (ENOENT)', async () => {
    const child = makeFakeChild();
    spawnOverride = vi.fn(() => child);

    const promise = synthesizePiper('hello world', { piper: { voice: 'test-voice', voicePath } });

    child.emit('error', Object.assign(new Error('spawn piper ENOENT'), { code: 'ENOENT' }));

    await expect(promise).rejects.toThrow(/ENOENT/);
  });

  // On Windows, piper writes to a temp file instead of stdout (see tts-piper.js),
  // so this stdout-streaming path only applies elsewhere.
  it.skipIf(IS_WIN)('resolves with the synthesized WAV bytes on a clean exit', async () => {
    const child = makeFakeChild();
    spawnOverride = vi.fn(() => child);

    const promise = synthesizePiper('hello world', { piper: { voice: 'test-voice', voicePath } });
    child.stdout.emit('data', Buffer.from('RIFFwav'));
    child.emit('close', 0);

    const result = await promise;
    expect(result.wav.toString()).toBe('RIFFwav');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
