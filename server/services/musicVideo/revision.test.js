import { describe, expect, it } from 'vitest';
import { assertRevisionOpenForGeneration, startRevisionOnProject } from './revision.js';

const scene = (sceneId, startSec, endSec) => ({ sceneId, startSec, endSec });
const direction = (sceneId, medium) => ({ sceneId, medium, mediumRationale: 'Approved for this shot.' });

function documentProject(percent = 20) {
  const scenes = [scene('code', 0, 30), scene('still', 30, 50), scene('clip', 50, 70)];
  return {
    id: 'mv-example',
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: percent },
    audioAnalysis: { durationSec: 100 },
    treatment: { shotDirections: [direction('code', 'procedural'), direction('still', 'still'), direction('clip', 'generated-footage')] },
    scenes,
    excerpts: [{ id: 'mve-example', status: 'complete', startSec: 0, endSec: 70,
      sections: scenes.map(({ sceneId, startSec, endSec }) => ({ sceneId, startSec, endSec })) }],
  };
}

describe('code-first document review revisions', () => {
  it('routes selected still and footage shots to their approved medium despite document excerpts having no layer', () => {
    const project = documentProject();
    const { project: revised, revision } = startRevisionOnProject(project, 'mve-example', { sceneIds: ['still', 'clip'] });
    expect(revision.sections.filter((section) => section.verdict === 'rejected').map(({ sceneId, kind }) => [sceneId, kind]))
      .toEqual([['still', 'image'], ['clip', 'video']]);
    expect(assertRevisionOpenForGeneration(revised, revision.id, { sceneId: 'clip', kind: 'video' })).toBeTruthy();
    expect(() => assertRevisionOpenForGeneration(revised, revision.id, { sceneId: 'still', kind: 'video' }))
      .toThrow(/approved medium/);
  });

  it('stops review at a procedural finding instead of silently promoting it to footage', () => {
    const project = documentProject();
    expect(() => startRevisionOnProject(project, 'mve-example', { sceneIds: ['code', 'clip'] }))
      .toThrow(/procedural or existing-footage/);
  });

  it('refuses zero or exceeded video share, and a policy edit after the revision opened', () => {
    expect(() => startRevisionOnProject(documentProject(0), 'mve-example', { sceneIds: ['clip'] }))
      .toThrow(/allowance/);
    const project = documentProject();
    const { project: revised, revision } = startRevisionOnProject(project, 'mve-example', { sceneIds: ['clip'] });
    expect(() => assertRevisionOpenForGeneration({ ...revised,
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
    }, revision.id, { sceneId: 'clip', kind: 'video' })).toThrow(/changed/);
    const retimed = { ...revised, scenes: revised.scenes.map((shot) => shot.sceneId === 'clip' ? { ...shot, endSec: 71 } : shot) };
    expect(() => assertRevisionOpenForGeneration(retimed, revision.id, { sceneId: 'clip', kind: 'video' })).toThrow(/changed/);
  });
});
