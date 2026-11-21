import { it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getOriginInfo } from '../lib/gitRemote.js';
import { buildQualitySnapshot, originLookupCacheSize } from './appQualityFederation.js';

// Default path only: no injected getOriginInfo, so repositoryKey reaches the
// process-wide origin cache. The counting double stands in for the git spawn.
vi.mock('../lib/gitRemote.js', async importOriginal => ({
  ...await importOriginal(),
  getOriginInfo: vi.fn(),
}));

const now = Date.parse('2026-09-10T12:00:00Z');
// The cache is process-wide, so each test takes its own checkout path.
const appAt = repoPath => ({ id: 'managed-app', repoPath });
const origin = fullName => ({ host: 'github.com', fullName });
const deps = { now, readFile: async () => null, query: async () => ({ rows: [] }) };
const spawns = () => vi.mocked(getOriginInfo).mock.calls.length;

beforeEach(() => {
  vi.mocked(getOriginInfo).mockReset();
  vi.mocked(getOriginInfo).mockResolvedValue(origin('owner/app'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

it('shares one origin lookup per repoPath across concurrent and repeated snapshots within 60 s', async () => {
  const app = appAt('/repos/share');
  const [first, second] = await Promise.all([buildQualitySnapshot(app, 30, deps), buildQualitySnapshot(app, 30, deps)]);
  expect(first.repository).toBe(second.repository);
  expect(spawns()).toBe(1);
  await buildQualitySnapshot(app, 30, deps);
  expect(spawns()).toBe(1);
});

it('picks up a changed origin once the 60 s absolute window lapses, and not before', async () => {
  const app = appAt('/repos/expiry');
  const before = await buildQualitySnapshot(app, 30, deps);
  vi.mocked(getOriginInfo).mockResolvedValue(origin('owner/renamed'));
  vi.setSystemTime(now + 59_000);
  expect((await buildQualitySnapshot(app, 30, deps)).repository).toBe(before.repository);
  expect(spawns()).toBe(1);
  vi.setSystemTime(now + 60_001);
  expect((await buildQualitySnapshot(app, 30, deps)).repository).not.toBe(before.repository);
  expect(spawns()).toBe(2);
});

it('does not cache a failed origin lookup', async () => {
  const app = appAt('/repos/failure');
  vi.mocked(getOriginInfo).mockRejectedValueOnce(new Error('git unavailable'));
  await expect(buildQualitySnapshot(app, 30, deps)).rejects.toThrow('git unavailable');
  expect((await buildQualitySnapshot(app, 30, deps)).repository).toMatch(/^[a-f0-9]{64}$/);
  expect(spawns()).toBe(2);
});

it('drops expired origin lookups when a new checkout is looked up, so the cache tracks only the last window', async () => {
  for (const name of ['a', 'b', 'c']) await buildQualitySnapshot(appAt(`/repos/sweep-${name}`), 30, deps);
  const beforeSweep = originLookupCacheSize();
  vi.setSystemTime(now + 60_001);
  await buildQualitySnapshot(appAt('/repos/sweep-d'), 30, deps);
  // a, b and c expired and are swept; d is added. Other tests may hold live entries, so compare against the pre-sweep size.
  expect(originLookupCacheSize()).toBeLessThanOrEqual(beforeSweep - 2);
});
