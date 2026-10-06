import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  readFileSync: mocks.readFileSync,
}));

const { isProcessAlive } = await import('./processAlive.js');

describe('isProcessAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mocks.readFileSync.mockReset();
  });

  it('reports this running process as alive', () => {
    mocks.readFileSync.mockImplementation((path) => {
      if (path === `/proc/${process.pid}/stat`) {
        return `${process.pid} (node) R 1 2 3`;
      }
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('reports a non-existent pid as dead', () => {
    expect(isProcessAlive(1073741823)).toBe(false);
  });

  it('treats a zombie process (state Z in /proc/<pid>/stat) as dead on Linux', () => {
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === 12345 && sig === 0) return true;
      throw new Error('ESRCH');
    });

    mocks.readFileSync.mockImplementation((path) => {
      if (path === '/proc/12345/stat') {
        return '12345 (sh) Z 1 12345 12345 0 -1 4194304 100 0 0 0 0 0 0 0 20 0 1 0 1000 0 0';
      }
      throw new Error('ENOENT');
    });

    expect(isProcessAlive(12345)).toBe(false);
  });

  it('treats a process with parentheses in command name and state Z as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === 12345 && sig === 0) return true;
      throw new Error('ESRCH');
    });

    mocks.readFileSync.mockImplementation((path) => {
      if (path === '/proc/12345/stat') {
        return '12345 (cmd (with parens) and spaces) Z 1 12345 12345 0 -1 4194304 100';
      }
      throw new Error('ENOENT');
    });

    expect(isProcessAlive(12345)).toBe(false);
  });

  it('treats an active process (state S or R in /proc/<pid>/stat) as alive', () => {
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === 12345 && sig === 0) return true;
      throw new Error('ESRCH');
    });

    mocks.readFileSync.mockImplementation((path) => {
      if (path === '/proc/12345/stat') {
        return '12345 (worker) S 1 12345 12345 0 -1 4194304 100';
      }
      throw new Error('ENOENT');
    });

    expect(isProcessAlive(12345)).toBe(true);
  });

  it('falls back to process.kill(pid, 0) when /proc/<pid>/stat is unavailable (e.g. macOS)', () => {
    vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === 12345 && sig === 0) return true;
      throw new Error('ESRCH');
    });

    mocks.readFileSync.mockImplementation(() => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    });

    expect(isProcessAlive(12345)).toBe(true);
  });
});
