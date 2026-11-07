import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalStringify } from '../../server/lib/objects.js';
import { capture } from './nativeUsageSources.testFixture.js';
import { NATIVE_USAGE_SOURCE_REPLAY_LIMITS, replayNativeUsageSources } from './nativeUsageSourceReplay.js';
import { getNativeTranscriptCoverage } from '../../server/services/nativeTranscriptCoverage.js';

vi.mock('node:os', async importOriginal => ({ ...await importOriginal(), homedir: vi.fn(() => { throw new Error('ambient-home-access'); }) }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal();
  return { ...original, lstat: vi.fn(original.lstat) };
});
vi.mock('../../server/services/nativeTranscriptCoverage.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, getNativeTranscriptCoverage: vi.fn(original.getNativeTranscriptCoverage) };
});
let temporary;
afterEach(async () => { vi.restoreAllMocks(); vi.clearAllMocks(); if (temporary) await rm(temporary, { recursive: true, force: true }); });
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const rehash = report => {
  report.evidenceHash = hash(report.providers);
  const { contentHash: ignored, ...body } = report;
  return { ...body, contentHash: hash(body) };
};
const input = async () => {
  temporary = await mkdtemp(join(tmpdir(), 'native-replay-budget-'));
  const roots = Object.fromEntries(['claudeProjects', 'grokSessions', 'agyCliConversations', 'agyLegacyBrain', 'agyAppConversations', 'agyIdeConversations']
    .map(role => [role, join(temporary, role)]));
  return { roots, report: await capture(temporary) };
};

it('replays explicit absent sources without resolving the ambient home', async () => {
  const { roots, report } = await input();
  expect(await replayNativeUsageSources(report, roots)).toMatchObject({ matched: true, codex: { status: 'report-evidence-only' } });
  expect(homedir).not.toHaveBeenCalled();
});

it.each(Object.entries(NATIVE_USAGE_SOURCE_REPLAY_LIMITS))('refuses unsupported %s before invoking any reader', async (field, maximum) => {
  const { roots, report } = await input();
  // Deliberately bind the last provider: every budget must be checked up front.
  report.providers.find(provider => provider.family === 'grok').scanCaps.limits[field] = maximum + 1;
  vi.clearAllMocks();
  await expect(replayNativeUsageSources(rehash(report), roots)).rejects.toThrow('native-source-scan-limits-unsupported');
  expect(lstat).not.toHaveBeenCalled();
  expect(homedir).not.toHaveBeenCalled();
});

it('accepts bounded capture budgets without clamping report metadata', async () => {
  const { roots, report } = await input();
  for (const provider of report.providers) if (provider.family !== 'codex') provider.scanCaps.limits = { ...NATIVE_USAGE_SOURCE_REPLAY_LIMITS };
  const replay = await replayNativeUsageSources(rehash(report), roots);
  expect(replay.matched).toBe(true);
  for (const provider of replay.providers) expect(provider.entry.scanCaps.limits).toEqual(NATIVE_USAGE_SOURCE_REPLAY_LIMITS);
});

it('refuses a detached identity-memory stop rather than projecting it as matching evidence', async () => {
  const { roots, report } = await input();
  vi.mocked(getNativeTranscriptCoverage).mockResolvedValueOnce({ executionLimit: 'identity-limit' });
  await expect(replayNativeUsageSources(report, roots)).rejects.toThrow('native-source-identity-limit-exceeded');
  expect(getNativeTranscriptCoverage).toHaveBeenLastCalledWith('claude', expect.objectContaining({ identityLimit: 100000 }));
});

it.each([1, 3])('refuses an expired shared deadline after %i clock reads', async validReads => {
  const { roots, report } = await input();
  vi.clearAllMocks();
  let reads = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => ++reads <= validReads ? 0 : 15 * 60_000);
  await expect(replayNativeUsageSources(report, roots)).rejects.toThrow('native-source-replay-deadline-exceeded');
  if (validReads === 1) expect(lstat).not.toHaveBeenCalled();
  expect(homedir).not.toHaveBeenCalled();
});
