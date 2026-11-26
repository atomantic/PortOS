import { describe, expect, it } from 'vitest';
import { EXCLUSIVE_CAPTURE_TESTS } from '../vitestCiPool.js';
import { BROWSER_SUITES, browserShardSlice, FULL_BROWSER_SHARD_COUNT } from './browserSuites.js';
import { browserTestProfileFiles } from './browserTestProfiles.js';

const visual = 'server/services/musicVideo/documentRender.browser.test.js';
const templates = 'server/services/musicVideo/documentRenderTemplates.browser.test.js';
const timeline = 'server/services/musicVideo/documentRenderAudioTimeline.browser.test.js';
const templateParity = 'server/services/musicVideo/documentTemplateParity.browser.test.js';
const htmlComposition = 'server/services/htmlComposition/index.test.js';
const animatic = 'server/services/musicVideo/animaticCapture.browser.test.js';
const overlays = 'server/services/musicVideo/animaticCaptureOverlays.browser.test.js';

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

  it('balances the broad matrix with identical owners across profiles and scoped selections', () => {
    const count = FULL_BROWSER_SHARD_COUNT;
    const smoke = browserTestProfileFiles('smoke', BROWSER_SUITES);
    const full = Array.from({ length: count }, (_, index) => browserShardSlice(BROWSER_SUITES, { index: index + 1, count }, 'full'));
    for (const [i, files] of full.entries()) {
      const shard = { index: i + 1, count };
      expect(browserShardSlice(BROWSER_SUITES, shard, 'smoke')).toEqual(files);
      expect(browserShardSlice(smoke, shard, 'smoke')).toEqual(files.filter(file => smoke.includes(file)));
      expect(files.length).toBeGreaterThanOrEqual(4);
      expect(files.length).toBeLessThanOrEqual(7);
    }
  });

  it.each([2, 4, FULL_BROWSER_SHARD_COUNT])('gives each split capture a separate runner with %i shards', count => {
    const files = [visual, templates, animatic, overlays];
    expect(EXCLUSIVE_CAPTURE_TESTS).toEqual(expect.arrayContaining(files.map(file => file.slice('server/'.length))));
    for (const profile of ['smoke', 'full']) {
      const owners = new Map(Array.from({ length: count }, (_, i) =>
        browserShardSlice(files, { index: i + 1, count }, profile).map(file => [file, i])).flat());
      expect(owners.get(visual)).not.toBe(owners.get(templates));
      expect(owners.get(animatic)).not.toBe(owners.get(overlays));
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
