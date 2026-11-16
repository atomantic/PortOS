/**
 * Surface contract for the visualStages barrel: every export of the leaf modules
 * it re-exports must stay reachable through it. Behavior suites live beside each
 * leaf (covers, comicPages, storyboards, visualStageHelpers.*.test.js) (#16214).
 */
import { describe, it, expect } from 'vitest';
import * as visualStages from './visualStages.js';
import * as visualStageHelpers from './visualStageHelpers.js';
import * as covers from './covers.js';
import * as comicPages from './comicPages.js';
import * as storyboards from './storyboards.js';

describe('visualStages.js barrel surface', () => {
  it.each([
    ['visualStageHelpers', visualStageHelpers],
    ['covers', covers],
    ['comicPages', comicPages],
    ['storyboards', storyboards],
  ])('re-exports every %s export unchanged', (_leaf, leafModule) => {
    const exported = Object.keys(leafModule);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) expect(visualStages[name], name).toBe(leafModule[name]);
  });
});
