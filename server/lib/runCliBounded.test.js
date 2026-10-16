import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const children = [];
vi.mock('./childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    children.push(child);
    return child;
  }),
}));

const { runCliBounded } = await import('./runCliBounded.js');

afterEach(() => { vi.useRealTimers(); children.length = 0; });

describe('runCliBounded', () => {
  it('kills a child that never exits and resolves a timeout result', async () => {
    vi.useFakeTimers();
    const p = runCliBounded('gh', ['issue', 'list'], { timeoutMs: 5000 });
    children[0].stderr.emit('data', Buffer.from('partial'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ code: -1, stdout: '', stderr: 'partial' });
    expect(children[0].kill).toHaveBeenCalled();
  });

  it('reports "timed out" when no stderr was produced', async () => {
    vi.useFakeTimers();
    const p = runCliBounded('gh', []);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await p).stderr).toBe('timed out');
  });

  it('resolves normally on close and on spawn error', async () => {
    const ok = runCliBounded('gh', []);
    children[0].stdout.emit('data', Buffer.from('out'));
    children[0].emit('close', 0);
    expect(await ok).toEqual({ code: 0, stdout: 'out', stderr: '' });
    const bad = runCliBounded('gh', []);
    children[1].emit('error', new Error('ENOENT'));
    expect(await bad).toMatchObject({ code: -1, stderr: 'ENOENT' });
  });
});
