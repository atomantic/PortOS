import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  decodeImageDataUrl,
  buildCliVisionInvocation,
  describeImageViaCli,
} from './visionCli.js';

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

describe('describeImageViaCli', () => {
  it('returns the trimmed stdout text in the API-compatible shape on exit 0', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption this',
      model: 'gpt-5',
      spawnImpl,
    });
    // Let the mkdtemp/writeFile awaits settle before emitting process events.
    await new Promise((r) => setTimeout(r, 10));
    child.stdout.emit('data', Buffer.from('  a woman in a red cloak  '));
    child.emit('close', 0);
    const result = await promise;
    expect(result).toEqual({
      text: 'a woman in a red cloak', finishReason: null, usage: null, reasoning: '',
    });
    expect(spawnImpl).toHaveBeenCalledOnce();
  });

  it('rejects with a tail of stderr on a non-zero exit', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = describeImageViaCli({
      provider: { id: 'claude-code', command: 'claude', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'caption',
      spawnImpl,
    });
    await new Promise((r) => setTimeout(r, 10));
    child.stderr.emit('data', Buffer.from('vision unavailable'));
    child.emit('close', 1);
    await expect(promise).rejects.toThrow(/exited 1.*vision unavailable/s);
  });

  it('rejects when the process fails to spawn', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const promise = describeImageViaCli({
      provider: { id: 'codex', command: 'codex', args: [] },
      dataUrl: PNG_DATA_URL,
      prompt: 'p',
      spawnImpl,
    });
    await new Promise((r) => setTimeout(r, 10));
    child.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toThrow(/Failed to spawn codex.*ENOENT/s);
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
