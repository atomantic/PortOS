import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../lib/childProcess.js', () => ({ spawn: vi.fn() }));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn()
}));
vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(),
  ensureDir: vi.fn(),
  safeJSONParse: vi.fn()
}));

import { scaffoldVite } from './scaffoldVite.js';
import { spawn } from '../lib/childProcess.js';
import { readFile } from 'fs/promises';

function fakeChild({ code = 0, stderr = '', error } = {}) {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    if (error) proc.emit('error', error);
    else proc.emit('close', code, null);
  });
  return proc;
}

const opts = (addStep) => ({
  repoPath: '/w/app', dirName: 'app', parentDir: '/w', template: 'vite-express',
  uiPort: 3100, apiPort: 3101, addStep
});

describe('scaffoldVite failure handling (#9650)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('runs npm create non-interactively with a timeout', async () => {
    spawn.mockReturnValueOnce(fakeChild({ code: 1, stderr: 'boom' }));
    await scaffoldVite(opts(vi.fn())).catch(() => {});
    const [cmd, args, o] = spawn.mock.calls[0];
    expect(cmd).toBe('npm');
    expect(args).toContain('--yes');
    expect(o.stdio[0]).toBe('ignore');
    expect(o.timeout).toBeGreaterThan(0);
  });

  it('aborts on a non-zero exit instead of reading the missing package.json', async () => {
    const addStep = vi.fn();
    spawn.mockReturnValueOnce(fakeChild({ code: 1, stderr: 'npm error ENOTFOUND' }));
    await expect(scaffoldVite(opts(addStep))).rejects.toMatchObject({ code: 'SCAFFOLD_FAILED' });
    expect(addStep).toHaveBeenCalledWith('Create Vite project', 'error', expect.stringContaining('ENOTFOUND'));
    expect(readFile).not.toHaveBeenCalled();
  });

  it('aborts when the spawn itself errors', async () => {
    spawn.mockReturnValueOnce(fakeChild({ error: new Error('spawn npm ENOENT') }));
    await expect(scaffoldVite(opts(vi.fn()))).rejects.toMatchObject({ code: 'SCAFFOLD_FAILED' });
    expect(readFile).not.toHaveBeenCalled();
  });
});
