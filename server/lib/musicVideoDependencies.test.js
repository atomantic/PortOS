import { afterEach, expect, it, vi } from 'vitest';
import * as checksums from './snapshotChecksum.js';
import { captureMusicVideoEvidence, presentMusicVideoDependencies } from './musicVideoDependencies.js';

afterEach(() => vi.restoreAllMocks());

const projectFixture = () => ({
  id: 'mv-synthetic',
  lyricCues: [{ id: 'cue', text: 'Synthetic lyric', startSec: 0, endSec: 10 }],
  composition: { cues: [{ startSec: 0, endSec: 5, text: 'First' }, { startSec: 5, endSec: 10, text: 'Second' }] },
  scenes: [0, 1].map(i => ({ sceneId: `scene-${i}`, startSec: i * 5, endSec: i * 5 + 5,
    visualLayer: 'still', referenceImageId: `image-${i}.png`, takes: [] })),
});

it('bounds checksum work by distinct current inputs across historical snapshots and refreshes after edits', () => {
  const project = projectFixture();
  const dependencies = captureMusicVideoEvidence(project);
  project.renderHistoryId = 'final';
  project.renderDependencies = dependencies;
  project.excerpts = Array.from({ length: 40 }, (_, i) => ({ id: `excerpt-${i}`, dependencies: structuredClone(dependencies) }));
  const checksum = vi.spyOn(checksums, 'canonicalSnapshotChecksum');

  presentMusicVideoDependencies({ ...project, excerpts: project.excerpts.slice(0, 1) });
  const oneSnapshotWork = checksum.mock.calls.length;
  checksum.mockClear();
  const current = presentMusicVideoDependencies(project);
  expect(current.excerpts.every(excerpt => excerpt.dependencyState.status === 'current')).toBe(true);
  expect(checksum.mock.calls.length).toBe(oneSnapshotWork);

  project.lyricCues[0].text = 'Revised synthetic lyric';
  const songChanged = presentMusicVideoDependencies(project);
  expect(songChanged.renderDependencyState.status).toBe('stale');
  expect(songChanged.excerpts.every(excerpt => excerpt.dependencyState.reasons.includes('Master audio, lyrics or alignment changed'))).toBe(true);

  project.lyricCues[0].text = 'Synthetic lyric';
  project.scenes[0].referenceImageId = 'replacement.png';
  expect(presentMusicVideoDependencies(project).renderDependencyState.reasons).toEqual(['Selected plate or its crop/mask inputs changed']);
  expect(dependencies).toEqual(project.excerpts[0].dependencies);
});

it('keeps distinct rendered windows independent when caching composition and scene-set references', () => {
  const project = projectFixture();
  project.excerpts = [0, 5].map(startSec => ({ dependencies: captureMusicVideoEvidence(project, { startSec, endSec: startSec + 5 }) }));
  project.composition.cues[0].text = 'Revised first window';

  const changed = presentMusicVideoDependencies(project);
  expect(changed.excerpts.map(excerpt => excerpt.dependencyState.status)).toEqual(['stale', 'current']);
  expect(changed.excerpts[0].dependencyState.reasons).toEqual(['Composition changed']);

  project.scenes[0].endSec = 6;
  expect(presentMusicVideoDependencies(project).excerpts.map(excerpt => excerpt.dependencyState.status)).toEqual(['stale', 'stale']);
});
