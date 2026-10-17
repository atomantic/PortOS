import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDatabaseStubs } from './databaseTransferStubs.js';

describe.skipIf(process.platform === 'win32')('paused database transfer stubs', () => {
  it.each([['dump', 'pg_dump', []], ['import', 'psql', ['--single-transaction']]])(
    '%s exits unsuccessfully when its fixture directory disappears',
    async (kind, executable, args) => {
      const root = mkdtempSync(join(tmpdir(), 'transfer-stub-lifecycle-'));
      let child;
      let closed;
      try {
        const stubs = installDatabaseStubs(root);
        stubs.setMode(kind, 'pause');
        child = spawn(join(stubs.bin, executable), args, { stdio: 'ignore' });
        closed = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        await vi.waitFor(() => expect(stubs.started(kind)).toBe(true));
        rmSync(stubs.dir, { recursive: true, force: true });
        const result = await Promise.race([
          closed,
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(Error('paused stub outlived its fixture directory')), 1_000);
            closed.finally(() => clearTimeout(timer)).catch(() => {});
          }),
        ]);
        expect(result.signal).toBeNull();
        expect(result.code).toBeGreaterThan(0);
      } finally {
        if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        if (closed) await closed.catch(() => {});
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
