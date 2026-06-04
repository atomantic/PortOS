import { describe, it, expect, vi, afterEach } from 'vitest';
import { getProcessStats, checkProcessRunning } from './processStats.js';

describe('cos-runner processStats', () => {
  describe('getProcessStats PID validation', () => {
    it('rejects non-numeric PIDs without spawning a process', async () => {
      const r = await getProcessStats('; rm -rf /');
      expect(r).toEqual({ active: false, pid: '; rm -rf /', cpu: 0, memoryKb: 0, state: 'invalid' });
    });
    it('rejects zero and negative PIDs', async () => {
      expect((await getProcessStats(0)).state).toBe('invalid');
      expect((await getProcessStats(-5)).state).toBe('invalid');
    });
    it('reports the current process as active', async () => {
      const r = await getProcessStats(process.pid);
      expect(r.active).toBe(true);
      expect(r.pid).toBe(process.pid);
    });
    it('reports a non-existent PID as dead', async () => {
      // 2^31-1 is effectively never a live PID on these platforms
      const r = await getProcessStats(2147483646);
      expect(r.active).toBe(false);
      expect(r.state).toBe('dead');
    });
  });

  describe('checkProcessRunning', () => {
    it('returns false for invalid PIDs', async () => {
      expect(await checkProcessRunning('bad')).toBe(false);
      expect(await checkProcessRunning(0)).toBe(false);
    });
    it('returns true for the current process', async () => {
      expect(await checkProcessRunning(process.pid)).toBe(true);
    });
  });

  describe('getProcessStats Windows branch', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    // execAsync = promisify(exec) → exec(cmd, opts, cb) with cb(err, { stdout }).
    const loadWithMockedExec = async (stdout) => {
      const calls = [];
      vi.resetModules();
      vi.doMock('child_process', () => ({
        exec: (cmd, _opts, cb) => { calls.push(cmd); cb(null, { stdout, stderr: '' }); },
      }));
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      const mod = await import('./processStats.js');
      return { getProcessStats: mod.getProcessStats, calls };
    };

    it('parses CPU/memory from the comma-quoted tasklist CSV row', async () => {
      const { getProcessStats: stats, calls } = await loadWithMockedExec(
        '"node.exe","1234","Console","1","50,000 K"\r\n'
      );
      const r = await stats(1234);
      expect(calls[0]).toContain('tasklist');
      expect(calls[0]).toContain('PID eq 1234');
      expect(r.active).toBe(true);
      expect(r.pid).toBe(1234);
      // "50,000 K" → 50000 KiB → ~48.8 MiB; the old whitespace split reported 0.
      expect(r.memoryKb).toBe(50000);
      expect(r.memoryMb).toBe(48.8);
      // tasklist /NH does not report %CPU.
      expect(r.cpu).toBe(0);
      expect(r.state).toBe('running');
    });

    it('reports a missing PID as dead from the "INFO: No tasks" line', async () => {
      const { getProcessStats: stats } = await loadWithMockedExec(
        'INFO: No tasks are running which match the specified criteria.\r\n'
      );
      const r = await stats(1234);
      expect(r.active).toBe(false);
      expect(r.state).toBe('dead');
      expect(r.memoryKb).toBe(0);
    });
  });

  describe('checkProcessRunning Windows branch', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    // execAsync = promisify(exec), so the mocked exec must honor the callback
    // convention: exec(cmd, opts, cb) → cb(err, { stdout, stderr }).
    const loadWithMockedExec = async (stdout) => {
      const calls = [];
      vi.resetModules();
      vi.doMock('child_process', () => ({
        exec: (cmd, _opts, cb) => { calls.push(cmd); cb(null, { stdout, stderr: '' }); },
      }));
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      const mod = await import('./processStats.js');
      return { checkProcessRunning: mod.checkProcessRunning, calls };
    };

    it('uses tasklist and treats a matching PID row as running', async () => {
      const { checkProcessRunning: check, calls } = await loadWithMockedExec(
        '"node.exe","1234","Console","1","50,000 K"\r\n'
      );
      expect(await check(1234)).toBe(true);
      expect(calls[0]).toContain('tasklist');
      expect(calls[0]).toContain('PID eq 1234');
    });

    it('treats an "INFO: No tasks" response as not running', async () => {
      const { checkProcessRunning: check } = await loadWithMockedExec(
        'INFO: No tasks are running which match the specified criteria.\r\n'
      );
      expect(await check(1234)).toBe(false);
    });
  });
});
