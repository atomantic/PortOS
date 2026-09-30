/**
 * Where the director posts (#9287): platforms are opt-in, the account check
 * only fires when both sides are known, and post ratings roll up per platform.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../../lib/mockPathsDataRoot.js';
import { vi } from 'vitest';

vi.mock('../../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-platforms-'),
}));

const { getPublishPlatforms, updatePublishPlatforms, assertAccount, assertPlatformEnabled, publishHistory } = await import('./platforms.js');

afterAll(() => cleanupTempDataRoots());

describe('publishing platforms (#9287)', () => {
  it('starts with every platform off and saves toggles and accounts', async () => {
    const initial = await getPublishPlatforms();
    expect(Object.values(initial).every((p) => p.enabled === false && p.account === null)).toBe(true);
    const saved = await updatePublishPlatforms({ x: { enabled: true, account: '@antic' }, reddit: { enabled: false }, myspace: { enabled: true } });
    expect(saved.x).toEqual({ enabled: true, account: 'antic' });
    expect(saved.myspace).toBeUndefined();
    expect((await getPublishPlatforms()).x).toEqual({ enabled: true, account: 'antic' });
    expect((await updatePublishPlatforms({ x: { account: '' } })).x).toEqual({ enabled: true, account: null });
  });

  it('refuses disabled platforms and a known-wrong account only', () => {
    expect(() => assertPlatformEnabled({ x: { enabled: false } }, 'x')).toThrow(expect.objectContaining({ code: 'PUBLISH_PLATFORM_DISABLED' }));
    expect(() => assertPlatformEnabled({ x: { enabled: true } }, 'x')).not.toThrow();
    const platforms = { x: { enabled: true, account: 'antic' }, tiktok: { enabled: true, account: null } };
    expect(() => assertAccount(platforms, 'x', 'other')).toThrow(expect.objectContaining({ code: 'PUBLISH_WRONG_ACCOUNT' }));
    expect(() => assertAccount(platforms, 'x', '@ANTIC')).not.toThrow();
    expect(() => assertAccount(platforms, 'x', null)).not.toThrow(); // the adapter can't tell
    expect(() => assertAccount(platforms, 'tiktok', 'anyone')).not.toThrow(); // no account configured
  });

  it('rolls post ratings up per platform, newest notes first', async () => {
    const history = await publishHistory([
      { name: 'Song A', publishKit: { posts: { reddit: { url: 'u', reception: 'poor', notes: 'downvoted', ratedAt: '2026-01-01' }, x: { url: 'u', reception: 'good', ratedAt: '2026-01-02' } } } },
      { name: 'Song B', publishKit: { posts: { reddit: { url: 'u', reception: 'mixed', notes: 'a few comments', ratedAt: '2026-02-01' }, youtube: { url: 'u' } } } },
      { name: 'No kit' },
    ]);
    expect(history.reddit).toMatchObject({ posts: 2, poor: 1, mixed: 1, good: 0 });
    expect(history.reddit.notes.map((n) => n.notes)).toEqual(['a few comments', 'downvoted']);
    expect(history.youtube).toMatchObject({ posts: 1, notes: [] });
    expect(history.x.good).toBe(1);
  });
});
