// @vitest-environment node

import { describe, it, expect, vi } from 'vitest';
import { compareBuildStamps, createBuildDriftWatcher, describeBuild, resolveBuildFrame } from './buildStamp.js';

describe('compareBuildStamps', () => {
  it('matches a bundle short commit against the server short commit', () => {
    const result = compareBuildStamps({ commit: 'abc1234' }, { shortCommit: 'abc1234', commit: 'abc1234def' });
    expect(result.state).toBe('match');
    expect(result.bundleCommit).toBe('abc1234');
    expect(result.serverCommit).toBe('abc1234');
  });

  it('matches a short bundle commit against a full server commit on the common prefix', () => {
    // The server may have sent only the full sha; comparing full-vs-short
    // verbatim would report a permanent false mismatch.
    const result = compareBuildStamps(
      { commit: 'abc1234' },
      { shortCommit: null, commit: 'abc1234567890abcdef1234567890abcdef1234' }
    );
    expect(result.state).toBe('match');
  });

  it('flags a genuine mismatch — the stale-bundle case this exists for', () => {
    expect(compareBuildStamps({ commit: 'abc1234' }, { shortCommit: 'def5678' }).state).toBe('mismatch');
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(compareBuildStamps({ commit: ' ABC1234 ' }, { shortCommit: 'abc1234' }).state).toBe('match');
  });

  it('reports unknown — never match — when either side is missing', () => {
    // Claiming 'match' here would assert a verification that never happened.
    for (const [bundle, server] of [
      [null, { shortCommit: 'abc1234' }],
      [{ commit: 'abc1234' }, null],
      [undefined, undefined],
      [{ commit: null }, { shortCommit: 'abc1234' }],
      [{ commit: 'abc1234' }, { shortCommit: null, commit: null }],
      [{ commit: '' }, { shortCommit: 'abc1234' }],
    ]) {
      expect(compareBuildStamps(bundle, server).state).toBe('unknown');
    }
  });

  it('treats a branch or commit literally named "unknown" as a real value', () => {
    // The absent sentinel is `null` on both halves, so no placeholder string is
    // reserved — a real ref named "unknown" must not be swallowed as absent.
    expect(compareBuildStamps({ commit: 'unknown' }, { shortCommit: 'unknown' }).state).toBe('match');
    expect(describeBuild({ commit: 'abc1234', branch: 'unknown' })).toBe('abc1234 · unknown');
  });

  it('ignores a non-string commit rather than coercing it', () => {
    expect(compareBuildStamps({ commit: 12345 }, { shortCommit: 'abc1234' }).state).toBe('unknown');
  });
});

describe('describeBuild', () => {
  it('renders commit, branch, and an uncommitted-changes badge', () => {
    expect(describeBuild({ commit: 'abc1234def', branch: 'main', dirty: true }))
      .toBe('abc1234 · main · uncommitted changes');
    expect(describeBuild({ commit: 'abc1234', branch: 'main', dirty: false }))
      .toBe('abc1234 · main');
  });

  it('omits a dirty badge when the check did not run', () => {
    // `null` is "we could not tell" — not "clean", and not "dirty".
    expect(describeBuild({ commit: 'abc1234', branch: 'main', dirty: null }))
      .toBe('abc1234 · main');
  });

  it('drops blank parts instead of printing placeholder text', () => {
    expect(describeBuild({ commit: 'abc1234', branch: '   ' })).toBe('abc1234');
    expect(describeBuild({ commit: 'abc1234', branch: null })).toBe('abc1234');
  });

  it('returns null when there is nothing worth rendering', () => {
    expect(describeBuild({})).toBeNull();
    expect(describeBuild()).toBeNull();
    expect(describeBuild({ commit: null, branch: null, dirty: null })).toBeNull();
  });
});

describe('resolveBuildFrame', () => {
  const embeddedBuildId = 'aaaa1111bbbb';
  const bundle = { commit: 'abc1234', branch: 'main' };

  it('asks for a reload when the bundle on disk moved since this tab loaded', () => {
    expect(resolveBuildFrame(
      { buildId: 'cccc2222dddd', commit: 'abc1234' },
      { embeddedBuildId, bundle }
    )).toBe('reload');
  });

  it('reports drift when the tab is current but the dist was built from another commit', () => {
    // Reloading would re-serve the same stale dist, so this must NOT be 'reload'.
    expect(resolveBuildFrame(
      { buildId: embeddedBuildId, commit: 'def5678' },
      { embeddedBuildId, bundle }
    )).toBe('drift');
  });

  it('prefers reload over drift when the bundle is stale on both counts', () => {
    // A reload is the prerequisite: once the tab is current, the drift check
    // becomes meaningful. Showing both at once would be two contradictory asks.
    expect(resolveBuildFrame(
      { buildId: 'cccc2222dddd', commit: 'def5678' },
      { embeddedBuildId, bundle }
    )).toBe('reload');
  });

  it('says nothing when the tab and the server agree', () => {
    expect(resolveBuildFrame(
      { buildId: embeddedBuildId, commit: 'abc1234' },
      { embeddedBuildId, bundle }
    )).toBeNull();
  });

  it('stays silent under `npm run dev`, where there is no dist to be stale', () => {
    // Vite serves its own index.html, so the server never injects the build-id
    // meta tag — and the Vite define is frozen at dev-server start, so a drift
    // check would fire the moment the developer commits.
    expect(resolveBuildFrame(
      { buildId: 'dev', commit: 'def5678' },
      { embeddedBuildId: null, bundle }
    )).toBeNull();
  });

  it('stays silent on a malformed or empty frame', () => {
    expect(resolveBuildFrame(undefined, { embeddedBuildId, bundle })).toBeNull();
    expect(resolveBuildFrame({}, { embeddedBuildId, bundle })).toBeNull();
  });

  it('stays silent when the server sent no commit (older server)', () => {
    // A newer client talking to a server that predates the field must not read
    // "absent" as "different".
    expect(resolveBuildFrame(
      { buildId: embeddedBuildId },
      { embeddedBuildId, bundle }
    )).toBeNull();
  });

  it('stays silent when this bundle has no commit of its own (source tarball)', () => {
    expect(resolveBuildFrame(
      { buildId: embeddedBuildId, commit: 'def5678' },
      { embeddedBuildId, bundle: { commit: null } }
    )).toBeNull();
  });
});

describe('createBuildDriftWatcher', () => {
  const embeddedBuildId = 'aaaa1111bbbb';

  // `__BUILD_STAMP__` is absent under vitest, so the bundle side is always
  // unknown here and every case below turns on the reload half plus the
  // never-assert-drift-without-both-sides rule. The commit comparison itself is
  // covered directly by the compareBuildStamps cases above.
  function makeWatcher({ commit = 'abc1234', fail = false } = {}) {
    const shown = [];
    const cleared = [];
    const fetchIdentity = vi.fn(() =>
      fail ? Promise.reject(new Error('404')) : Promise.resolve({ commit }));
    const watcher = createBuildDriftWatcher({
      embeddedBuildId,
      fetchIdentity,
      onShow: (a) => shown.push(a),
      onClear: (a) => cleared.push(a)
    });
    return { watcher, shown, cleared, fetchIdentity };
  }

  it('raises the reload notice when the bundle hash moved', () => {
    const { watcher, shown } = makeWatcher();

    watcher.onBuildId('cccc2222dddd');

    expect(shown).toEqual(['reload']);
  });

  it('raises each notice at most once, however many signals arrive', () => {
    const { watcher, shown } = makeWatcher();

    watcher.onBuildId('cccc2222dddd');
    watcher.onBuildId('cccc2222dddd');
    watcher.onBuildId('cccc2222dddd');

    expect(shown).toEqual(['reload']);
  });

  it('clears the reload notice once the tab is current again', () => {
    // A sticky notice with no path down is worse than none: it keeps asserting
    // a problem the user already fixed.
    const { watcher, shown, cleared } = makeWatcher();

    watcher.onBuildId('cccc2222dddd');
    watcher.onBuildId(embeddedBuildId);

    expect(shown).toEqual(['reload']);
    expect(cleared).toEqual(['reload']);
  });

  it('re-raises after a clear, so a second genuine problem is not swallowed', () => {
    const { watcher, shown } = makeWatcher();

    watcher.onBuildId('cccc2222dddd');
    watcher.onBuildId(embeddedBuildId);
    watcher.onBuildId('eeee3333ffff');

    expect(shown).toEqual(['reload', 'reload']);
  });

  it('drops the previous commit before re-reading it on reconnect', async () => {
    // The old commit belongs to the server we were talking to before. Judging a
    // restarted server by it would assert drift against a server that is gone.
    const { watcher, fetchIdentity } = makeWatcher();

    await watcher.refreshIdentity();
    await watcher.refreshIdentity();

    expect(fetchIdentity).toHaveBeenCalledTimes(2);
  });

  it('does not assert drift when the identity fetch fails (older server)', async () => {
    const { watcher, shown } = makeWatcher({ fail: true });

    watcher.onBuildId(embeddedBuildId);
    await watcher.refreshIdentity();

    expect(shown).toEqual([]);
  });

  it('stays silent under the dev server, where no build id is embedded', async () => {
    const shown = [];
    const watcher = createBuildDriftWatcher({
      embeddedBuildId: null,
      fetchIdentity: () => Promise.resolve({ commit: 'def5678' }),
      onShow: (a) => shown.push(a),
      onClear: () => {},
    });

    watcher.onBuildId('dev');
    await watcher.refreshIdentity();

    expect(shown).toEqual([]);
  });
});
