import { describe, expect, it } from 'vitest';
import { EXCLUSIVE_CAPTURE_TESTS } from '../vitestCiPool.js';
import { BROWSER_SUITES, browserShardSlice, FULL_BROWSER_SHARD_COUNT } from './browserSuites.js';
import { browserTestProfileFiles } from './browserTestProfiles.js';

const visual = 'server/services/musicVideo/documentRender.browser.test.js';
const timeline = 'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js';
const templateParity = 'server/services/musicVideo/documentTemplateParity.browser.test.js';
const htmlComposition = 'server/services/htmlComposition/index.test.js';
const animatic = 'server/services/musicVideo/animaticCapture.browser.test.js';

describe('browser shard ownership', () => {
  it.each([1, 2, 3, 4, FULL_BROWSER_SHARD_COUNT])('assigns every registered suite once with %i shards', count => {
    for (const profile of ['smoke', 'full']) {
      const shards = Array.from({ length: count }, (_, index) => browserShardSlice(BROWSER_SUITES, { index: index + 1, count }, profile));
      expect(shards.flat().sort()).toEqual([...BROWSER_SUITES].sort());
    }
  });

  it.each([2, 4, FULL_BROWSER_SHARD_COUNT])('assigns the document render capture suites to separate runners with %i shards', count => {
    for (const profile of ['smoke', 'full']) {
      const shards = Array.from({ length: count }, (_, index) => browserShardSlice([visual, timeline], { index: index + 1, count }, profile));
      expect(shards.filter(files => files.length === 1)).toHaveLength(2);
    }
    expect(EXCLUSIVE_CAPTURE_TESTS).toEqual(expect.arrayContaining([visual, timeline].map(file => file.slice('server/'.length))));
  });

  it.each([4, FULL_BROWSER_SHARD_COUNT])('keeps template parity off the visual, HTML composition and animatic runners with %i shards after scoping', count => {
    const scope = [visual, timeline, templateParity, htmlComposition, animatic];
    for (const profile of ['smoke', 'full']) {
      const shards = Array.from({ length: count }, (_, index) => browserShardSlice(scope, { index: index + 1, count }, profile));
      const parityShard = shards.find(files => files.includes(templateParity));
      expect(parityShard).toBeDefined();
      expect(shards.filter(files => files.some(file => file !== templateParity))).toHaveLength(4);
      for (const file of [visual, htmlComposition, animatic]) expect(parityShard).not.toContain(file);
      for (const [index, files] of shards.entries()) {
        expect(files).toEqual(browserShardSlice(BROWSER_SUITES, { index: index + 1, count }, profile).filter(file => scope.includes(file)));
      }
    }
  });

  it('keeps every broad runner active with the visual suite isolated in both profiles', () => {
    const count = FULL_BROWSER_SHARD_COUNT;
    for (const profile of ['smoke', 'full']) {
      const files = browserTestProfileFiles(profile, BROWSER_SUITES);
      const shards = Array.from({ length: count }, (_, index) => browserShardSlice(files, { index: index + 1, count }, profile));
      expect(shards.every(shard => shard.length > 0)).toBe(true);
      expect(shards.find(shard => shard.includes(visual))).toEqual([visual]);
    }
  });

  it('applies the smoke GPU override only to two-shard plans', () => {
    const gpu = 'server/lib/filmLookGpu.browser.test.js';
    expect(browserShardSlice([gpu], { index: 2, count: 2 }, 'full')).toEqual([]);
    expect(browserShardSlice([gpu], { index: 2, count: 2 }, 'smoke')).toEqual([gpu]);
    const fullFourShard = Array.from({ length: 4 }, (_, index) => browserShardSlice([gpu], { index: index + 1, count: 4 }, 'full'));
    const smokeFourShard = Array.from({ length: 4 }, (_, index) => browserShardSlice([gpu], { index: index + 1, count: 4 }, 'smoke'));
    expect(smokeFourShard).toEqual(fullFourShard);
  });
});
