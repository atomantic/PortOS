/**
 * Surface contract for the local.js facade: every export of the leaf modules it
 * re-exports must stay reachable through it. Behavior suites live beside each
 * leaf (generateVideo.*.test.js, chainedVideo.local.test.js, ...).
 */
import { describe, it, expect } from 'vitest';
import * as local from './local.js';
import * as generateVideo from './generateVideo.js';
import * as chainedVideo from './chainedVideo.js';
import * as frameExtraction from './frameExtraction.js';
import * as historyOps from './historyOps.js';
import * as stitchVideos from './stitchVideos.js';
import * as upscaleVideo from './upscaleVideo.js';

describe('local.js facade surface', () => {
  it.each([
    ['generateVideo', generateVideo],
    ['chainedVideo', chainedVideo],
    ['frameExtraction', frameExtraction],
    ['historyOps', historyOps],
    ['stitchVideos', stitchVideos],
    ['upscaleVideo', upscaleVideo],
  ])('re-exports every %s export unchanged', (_leaf, leafModule) => {
    const exported = Object.keys(leafModule);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) expect(local[name], name).toBe(leafModule[name]);
  });
});
