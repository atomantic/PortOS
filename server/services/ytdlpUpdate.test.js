import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `fs/promises#realpath` decides whether the yt-dlp on PATH really is
// Homebrew's keg, and the tests below need to answer for paths that don't exist
// on the machine running them.
vi.mock('fs/promises', () => ({ realpath: vi.fn(async (p) => p) }));
vi.mock('../lib/bufferedSpawn.js', () => ({ bufferedSpawn: vi.fn() }));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn(async () => ({ success: true })) }));
vi.mock('../lib/ytdlp.js', () => ({ findYtDlp: vi.fn(), resetYtDlpCache: vi.fn() }));

import { bufferedSpawn } from '../lib/bufferedSpawn.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { getYtDlpUpdateStatus, updateYtDlp, resetYtDlpLatestCache } from './ytdlpUpdate.js';

const BREW_PREFIX = '/opt/homebrew/opt/yt-dlp';
const BREW_BINARY = `${BREW_PREFIX}/bin/yt-dlp`;

const brewPayload = (formula) => JSON.stringify({ formulae: [{ name: 'yt-dlp', ...formula }] });

const ok = (stdout) => ({ success: true, stdout, stderr: '' });
const fail = () => ({ success: false, stdout: '', stderr: '', code: 1 });

/**
 * Route each probe by the command it runs. `getYtDlpUpdateStatus` fires
 * `yt-dlp --version`, `brew info` and `brew --prefix` — asserting on call order
 * would pin an implementation detail (two of them run in parallel), so the
 * double answers by question instead.
 */
function stubProbes({ version = '2026.07.04', brew = null, prefix = BREW_PREFIX } = {}) {
  bufferedSpawn.mockImplementation(async (cmd, args) => {
    if (args?.[0] === '--version') return ok(`${version}\n`);
    if (cmd === 'brew' && args?.[0] === 'info') return brew ? ok(brewPayload(brew)) : fail();
    if (cmd === 'brew' && args?.[0] === '--prefix') return prefix ? ok(`${prefix}\n`) : fail();
    return fail();
  });
}

const LINKED_CURRENT_BREW = { installed: [{ version: '2026.08.19' }], versions: { stable: '2026.08.19' }, linked_keg: '2026.08.19', outdated: false };

describe('ytdlpUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetYtDlpLatestCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ tag_name: '2026.08.19' }) })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a missing binary as not installed and not updatable', async () => {
    findYtDlp.mockResolvedValue(null);
    const status = await getYtDlpUpdateStatus();
    expect(status).toMatchObject({ installed: false, canUpdate: false, version: null });
    expect(status.blockedReason).toMatch(/not on PATH/);
  });

  it('takes Homebrew\'s own outdated flag rather than comparing version strings', async () => {
    // Homebrew writes the stable version unpadded (`2026.8.19`) while the binary
    // prints `2026.07.04`, so a lexicographic comparison of the two reports the
    // stale install as CURRENT. That is the exact live case this shipped for.
    findYtDlp.mockResolvedValue(BREW_BINARY);
    stubProbes({
      version: '2026.07.04',
      brew: { installed: [{ version: '2026.07.04' }], versions: { stable: '2026.8.19' }, linked_keg: '2026.07.04', outdated: true },
    });
    const status = await getYtDlpUpdateStatus();
    expect(status).toMatchObject({ method: 'brew', updateAvailable: true, canUpdate: true, version: '2026.07.04' });
  });

  it('refuses a pinned Homebrew formula and names why', async () => {
    findYtDlp.mockResolvedValue(BREW_BINARY);
    stubProbes({ brew: { ...LINKED_CURRENT_BREW, pinned: true, outdated: true } });
    const status = await getYtDlpUpdateStatus();
    expect(status.canUpdate).toBe(false);
    expect(status.blockedReason).toMatch(/pinned/);
  });

  it('falls back to yt-dlp -U when the binary on PATH is not the Homebrew keg', async () => {
    // A pip or standalone install earlier on PATH coexists with a linked
    // formula; `brew upgrade` would leave the binary that actually runs alone.
    findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
    stubProbes({ brew: LINKED_CURRENT_BREW });
    const status = await getYtDlpUpdateStatus();
    expect(status).toMatchObject({ method: 'self', updateCommand: 'yt-dlp -U', canUpdate: true });
  });

  it('compares the GitHub release tag against the installed version on the self-update path', async () => {
    findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
    stubProbes({ version: '2026.07.04', brew: null });
    expect(await getYtDlpUpdateStatus()).toMatchObject({ latestVersion: '2026.08.19', updateAvailable: true });
  });

  it('does not offer a downgrade to a nightly ahead of the latest stable tag', async () => {
    findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
    stubProbes({ version: '2026.08.19.232702', brew: null });
    expect(await getYtDlpUpdateStatus()).toMatchObject({ updateAvailable: false });
  });

  it('runs brew upgrade for a Homebrew install and reports the new version', async () => {
    findYtDlp.mockResolvedValue(BREW_BINARY);
    const stale = { installed: [{ version: '2026.07.04' }], versions: { stable: '2026.8.19' }, linked_keg: '2026.07.04', outdated: true };
    stubProbes({ version: '2026.07.04', brew: stale });
    // The post-upgrade status re-reads the binary, which is how the caller
    // learns what actually landed rather than what the command claimed.
    runStreamingCommand.mockImplementationOnce(async () => {
      stubProbes({ version: '2026.08.19', brew: { ...stale, installed: [{ version: '2026.08.19' }], linked_keg: '2026.08.19', outdated: false } });
      return { success: true };
    });

    const result = await updateYtDlp();
    expect(runStreamingCommand).toHaveBeenCalledWith('brew', ['upgrade', 'yt-dlp'], expect.any(Function), expect.any(Object));
    expect(result).toMatchObject({ success: true, version: '2026.08.19', previousVersion: '2026.07.04', note: null });
  });

  it('runs yt-dlp -U for a non-Homebrew install', async () => {
    findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
    stubProbes({ brew: null });
    await updateYtDlp();
    expect(runStreamingCommand).toHaveBeenCalledWith('/usr/local/bin/yt-dlp', ['-U'], expect.any(Function), expect.any(Object));
  });

  // Both `brew upgrade` on a current formula and `yt-dlp -U` with nothing to do
  // exit 0, so a success that moved nothing must not imply a new build landed.
  it('says "already on" when the version did not move', async () => {
    findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
    stubProbes({ version: '2026.08.19', brew: null });
    expect(await updateYtDlp()).toMatchObject({ success: true, note: 'already on 2026.08.19' });
  });

  it('returns a failed upgrade rather than throwing out of the child-process boundary', async () => {
    findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
    stubProbes({ brew: null });
    runStreamingCommand.mockResolvedValueOnce({ success: false, error: 'exit 1: network unreachable' });
    const result = await updateYtDlp();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/network unreachable/);
  });

  it('refuses to update a binary that is not installed', async () => {
    findYtDlp.mockResolvedValue(null);
    expect(await updateYtDlp()).toMatchObject({ success: false });
    expect(runStreamingCommand).not.toHaveBeenCalled();
  });
});
