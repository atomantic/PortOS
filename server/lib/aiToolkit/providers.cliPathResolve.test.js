import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// Mock child_process so testProvider's command-resolution branch runs against a
// controllable `which`/`where` + version probe instead of the host's real PATH.
// execFile is replaced with a plain vi.fn (the real one carries a custom
// util.promisify symbol; the mock doesn't, so promisify resolves to the single
// value we hand the callback — we pass a `{ stdout, stderr }` object to keep the
// `const { stdout } = await execFileAsync(...)` destructure working).
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import { createProviderService } from './providers.js';

const TEST_DATA_DIR = join(process.cwd(), 'test-data-cli-resolve');

describe('testProvider — cli command resolution (cross-platform PATH)', () => {
  let providerService;
  let originalPlatform;

  beforeEach(async () => {
    originalPlatform = process.platform;
    if (!existsSync(TEST_DATA_DIR)) await mkdir(TEST_DATA_DIR, { recursive: true });
    providerService = createProviderService({ dataDir: TEST_DATA_DIR, providersFile: 'providers.json' });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.mocked(execFile).mockReset();
    if (existsSync(TEST_DATA_DIR)) await rm(TEST_DATA_DIR, { recursive: true });
  });

  const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

  // Drive the mocked execFile: `lookup` is the stdout the which/where call emits,
  // `version` is the stdout the resolved-binary --version probe emits.
  const stubExec = ({ lookup, version = 'claude 1.0.0\n' }) => {
    vi.mocked(execFile).mockImplementation((cmd, argv, cb) => {
      if (cmd === 'which' || cmd === 'where') {
        if (lookup === null) return cb(new Error('not found'));
        return cb(null, { stdout: lookup, stderr: '' });
      }
      // version probe against the resolved path
      return cb(null, { stdout: version, stderr: '' });
    });
  };

  const makeCliProvider = (command = 'claude') =>
    providerService.createProvider({ name: 'Claude CLI', type: 'cli', command });

  it('uses `where` (not `which`) on win32 and reports success when the command resolves', async () => {
    setPlatform('win32');
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
    expect(result.version).toBe('claude 1.0.0');
    // The lookup must have gone through `where`, never `which`, on Windows.
    const lookupCmds = vi.mocked(execFile).mock.calls.map((c) => c[0]);
    expect(lookupCmds).toContain('where');
    expect(lookupCmds).not.toContain('which');
  });

  it('takes the first line when `where` returns multiple matches', async () => {
    setPlatform('win32');
    stubExec({ lookup: 'C:\\a\\claude.exe\r\nC:\\b\\claude.exe\r\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('C:\\a\\claude.exe');
  });

  it('invokes the resolved path for the version probe (so win32 runs the exact .exe)', async () => {
    setPlatform('win32');
    stubExec({ lookup: 'C:\\Users\\Joe\\.local\\bin\\claude.exe\r\n' });
    const p = await makeCliProvider();

    await providerService.testProvider(p.id);

    const versionCall = vi.mocked(execFile).mock.calls.find((c) => c[0] !== 'where' && c[0] !== 'which');
    expect(versionCall?.[0]).toBe('C:\\Users\\Joe\\.local\\bin\\claude.exe');
    expect(versionCall?.[1]).toEqual(['--version']);
  });

  it('uses `which` on non-win32 platforms', async () => {
    setPlatform('linux');
    stubExec({ lookup: '/usr/local/bin/claude\n' });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.path).toBe('/usr/local/bin/claude');
    const lookupCmds = vi.mocked(execFile).mock.calls.map((c) => c[0]);
    expect(lookupCmds).toContain('which');
    expect(lookupCmds).not.toContain('where');
  });

  it('reports not-found when the lookup resolves nothing', async () => {
    setPlatform('win32');
    stubExec({ lookup: null });
    const p = await makeCliProvider('claude');

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Command 'claude' not found in PATH");
  });

  it('falls back to "available" when no version flag yields output', async () => {
    setPlatform('linux');
    vi.mocked(execFile).mockImplementation((cmd, argv, cb) => {
      if (cmd === 'which' || cmd === 'where') return cb(null, { stdout: '/usr/local/bin/claude\n', stderr: '' });
      return cb(new Error('unknown flag')); // every --version / -v probe fails
    });
    const p = await makeCliProvider();

    const result = await providerService.testProvider(p.id);

    expect(result.success).toBe(true);
    expect(result.version).toBe('available');
  });
});
