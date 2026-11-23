import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureSecureDir, writeSecureJson } from './secureAuthStore.js';

describe.skipIf(process.platform === 'win32')('secureAuthStore', () => {
  it('creates the directory 0700 and files 0600, tightening existing ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'secure-auth-'));
    try {
    const dir = join(root, 'auth');
    await ensureSecureDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    const file = join(dir, 'tokens.json');
    await writeFile(file, '{}', { mode: 0o644 });
    await chmod(dir, 0o755);
    await ensureSecureDir(dir);
    await writeSecureJson(file, { a: 1 });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
