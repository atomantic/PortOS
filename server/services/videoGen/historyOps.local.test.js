/**
 * historyOps.local.test.js
 *
 * Split from local.test.js (#16214); shared mocks live in local.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';


// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way so its state objects outlive vi.resetModules().
const fx = await vi.hoisted(() => import('./local.testFixtures.js'));

vi.mock('os', async (importOriginal) => fx.osFactory(importOriginal));
vi.mock('../../lib/heavyJobClaim.js', () => fx.heavyJobClaimFactory());
vi.mock('../localMemory.js', async (importOriginal) => fx.localMemoryFactory(importOriginal));
vi.mock('../../lib/fileUtils.js', () => fx.fileUtilsFactory());
vi.mock('../settings.js', () => fx.settingsFactory());
vi.mock('../../lib/mediaModels.js', async () => fx.mediaModelsFactory());
vi.mock('../../lib/sseUtils.js', () => fx.sseUtilsFactory());
vi.mock('../../lib/ffmpeg.js', async () => fx.ffmpegFactory());
vi.mock('./extendSplice.js', () => fx.extendSpliceFactory());
vi.mock('../../lib/lipsyncAlign.js', () => fx.lipsyncAlignFactory());
vi.mock('../hfToken.js', () => fx.hfTokenFactory());
vi.mock('../../lib/hfCache.js', async (original) => fx.hfCacheFactory(original));
vi.mock('fs', () => fx.fsFactory());
vi.mock('../../lib/frameQuality.js', async (importOriginal) => fx.frameQualityFactory(importOriginal));
vi.mock('./runtimes.js', async (importOriginal) => fx.runtimesFactory(importOriginal));
vi.mock('../loras.js', () => fx.lorasFactory());
vi.mock('../loraEffectProbe.js', () => fx.loraEffectProbeFactory());
vi.mock('./ensureWeights.js', async (importOriginal) => fx.ensureWeightsFactory(importOriginal));
vi.mock('../../lib/childProcess.js', () => fx.childProcessFactory());
vi.mock('../../lib/detachedSpawn.js', () => fx.detachedSpawnFactory());
vi.mock('fs/promises', () => fx.fsPromisesMock);

// ─── module under test ───────────────────────────────────────────────────────
let updateHistoryItemPrompt;

beforeEach(async () => {
  vi.resetModules();
  fx.resetFsPromisesReadFile();
  ({ updateHistoryItemPrompt } = await import('./local.js'));
});

afterEach(async () => {
  await fx.resetSharedMocks();
});

describe('updateHistoryItemPrompt — trigger-weave provenance (#4665)', () => {
  const seedHistory = async (item) => {
    const { readJSONFile, atomicWrite } = await import('../../lib/fileUtils.js');
    vi.mocked(readJSONFile).mockResolvedValue([item]);
    vi.mocked(atomicWrite).mockClear();
    return () => {
      const calls = vi.mocked(atomicWrite).mock.calls;
      return calls[calls.length - 1]?.[1]?.[0];
    };
  };

  it('drops renderPrompt + addedTriggerWords when the user edits the prompt', async () => {
    // The provenance describes the prompt this render was MADE with. Leaving it
    // after an edit has the row claim a renderPrompt derived from text that is
    // no longer there, and name tokens as "added" to a prompt they never were.
    const written = await seedHistory({
      id: 'woven-1',
      prompt: 'a rooftop at dusk',
      renderPrompt: 'a rooftop at dusk, fox_tok',
      addedTriggerWords: ['fox_tok'],
    });
    await updateHistoryItemPrompt('woven-1', 'a beach at noon');
    const item = written();
    expect(item.prompt).toBe('a beach at noon');
    expect(item.renderPrompt).toBeUndefined();
    expect(item.addedTriggerWords).toBeUndefined();
  });

  it('leaves an un-woven row otherwise untouched', async () => {
    const written = await seedHistory({ id: 'plain-1', prompt: 'a rooftop', seed: 42 });
    await updateHistoryItemPrompt('plain-1', 'a beach');
    const item = written();
    expect(item).toEqual({ id: 'plain-1', prompt: 'a beach', seed: 42 });
  });
});
