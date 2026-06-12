import { describe, it, expect, vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

// arcPlanner.js loads the pipeline + universe graph transitively; stub the
// peer-fan-out + filesystem the way the main arcPlanner suite does so this
// pure import-shape test stays hermetic.
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

import * as barrel from './arcPlanner.js';
import * as context from './arcPlanner/context.js';
import * as arcCore from './arcPlanner/arcCore.js';
import * as episodeSeedPass from './arcPlanner/episodeSeedPass.js';
import * as completenessPass from './arcPlanner/completenessPass.js';
import * as manuscriptDerive from './arcPlanner/manuscriptDerive.js';
import * as coverConcepts from './arcPlanner/coverConcepts.js';

// Issue #1152 split the 2137-line arcPlanner.js into ./arcPlanner/* with the
// original file kept as a re-exporting barrel. This pins that contract:
// every module export must be reachable through the barrel AS THE SAME object
// (not a divergent copy), so existing `from './arcPlanner.js'` imports survive.
describe('arcPlanner barrel re-exports (issue #1152)', () => {
  const modules = [
    ['context', context],
    ['arcCore', arcCore],
    ['episodeSeedPass', episodeSeedPass],
    ['completenessPass', completenessPass],
    ['manuscriptDerive', manuscriptDerive],
    ['coverConcepts', coverConcepts],
  ];

  it.each(modules)('%s exports are reachable from the barrel as the same objects', (_name, mod) => {
    for (const [key, value] of Object.entries(mod)) {
      expect(barrel[key], `barrel re-export of '${key}'`).toBe(value);
    }
  });

  it('the public planning entry points are present on the barrel', () => {
    for (const fn of [
      'generateArcOverview', 'generateSeasonEpisodes', 'verifyArc', 'verifyVolume',
      'resolveVerifyIssues', 'commitSeasonsWithRemap', 'analyzeManuscriptCompleteness',
      'deriveFromManuscript', 'commitDerivedManuscript', 'generateReaderMap',
      'refineReaderMap', 'refineArc', 'generateVolumeCoverConcepts', 'generateComicCoverConcepts',
      'commitEpisodesToIssues', 'extractEpisodeCanon', 'collectManuscriptSections', 'collectManuscriptByType',
    ]) {
      expect(typeof barrel[fn], fn).toBe('function');
    }
  });

  it('preserves the __testing internals bundle pulled from the split modules', () => {
    const keys = Object.keys(barrel.__testing || {});
    expect(keys.length).toBeGreaterThanOrEqual(16);
    for (const [k, v] of Object.entries(barrel.__testing)) {
      expect(v, `__testing.${k}`).toBeDefined();
    }
  });

  it('no symbol collides across the split modules (export * barrel would be ambiguous)', () => {
    const seen = new Map();
    for (const [name, mod] of modules) {
      for (const key of Object.keys(mod)) {
        expect(seen.has(key), `'${key}' exported by both ${seen.get(key)} and ${name}`).toBe(false);
        seen.set(key, name);
      }
    }
  });
});
