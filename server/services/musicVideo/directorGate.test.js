// Who is exempt from the approval gates: only a render or generation the director starts from a route
// (it carries DIRECTOR_STARTED, a symbol no request body can hold). Technical problems refuse everyone.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ project: null }));
vi.mock('./projects.js', () => ({
  getProject: vi.fn(async () => h.project),
  updateProject: vi.fn(),
  listProjects: vi.fn(async () => []),
  mutateProjectRecord: vi.fn(async (_id, transform) => transform(h.project)),
}));
vi.mock('../promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: vi.fn(async () => ({ provider: { id: 'stub-provider' }, selectedModel: 'fixture-model' })),
  runPromptThroughProvider: vi.fn(async () => { throw Object.assign(new Error('model reached'), { code: 'MODEL_REACHED' }); }),
}));

const { DIRECTOR_STARTED, assertProductionApproval, approveProductionStage, productionReadiness, productionAlignmentBasis } = await import('./productionReview.js');
const { renderMusicVideo } = await import('./render.js');
const { generateMusicVideoCode, regenerateMusicVideoCodeSection } = await import('./codeGeneration.js');
const { generateMixedMediaDocument, regenerateMixedMediaSection, reviseMixedMediaEvents } = await import('./documentGeneration.js');

const base = () => ({
  id: 'p1', audioAnalysis: { durationSec: 8, sections: [{ id: 'a', label: 'Verse', startSec: 0, endSec: 8 }], beats: [0, 1, 2] },
  concept: { logline: 'x', subjects: [{ id: 'a', name: 'A', kind: 'character' }] }, visualSpec: { palette: ['#000000'] },
  lyricCues: [], lyricMarkers: [],
  castAndSets: { status: 'approved', direction: { world: { camera: 'Handheld', transitions: 'Cut' } } },
  devArtifacts: [{ id: 'g1', mimeType: 'image/png', file: 'guide.png', version: 1 }],
  composition: { mode: 'code' },
  scenes: [{ sceneId: 's1', label: 'Verse', startSec: 0, endSec: 4, visualIntent: 'a', framePrompt: 'b' }, { sceneId: 's2', label: 'Outro', startSec: 4, endSec: 8, visualIntent: 'c', framePrompt: 'd' }],
  productionReview: { draft: { lyricsMode: 'instrumental', storyboard: [], cast: 'c', environments: 'e', visualLanguage: 'v', motionLanguage: 'm', guideArtifactId: 'g1' } },
});
const approved = () => {
  let p = base();
  p = approveProductionStage(p, { stage: 'art', basis: productionReadiness(p).basis.art });
  return approveProductionStage(p, { stage: 'storyboard', basis: productionReadiness(p).basis.storyboard });
};
/** An approved project whose palette then changed: both approvals are revoked, nothing technical is wrong. */
const revoked = () => ({ ...approved(), visualSpec: { palette: ['#ffffff'] } });
/** The same, with a hole in the song coverage. */
const gapped = () => ({ ...revoked(), scenes: [{ ...base().scenes[0] }, { ...base().scenes[1], startSec: 5 }] });

const director = { startedBy: DIRECTOR_STARTED };
const APPROVAL = { code: 'MUSIC_VIDEO_APPROVAL_REQUIRED' };
const INCOMPLETE = { code: 'MUSIC_VIDEO_STORYBOARD_INCOMPLETE' };

beforeEach(() => { h.project = revoked(); });

describe('fixtures', () => {
  it('start approved, lose both approvals to a palette change and keep no technical problem', () => {
    expect(productionReadiness(approved()).storyboard.approved).toBe(true);
    const r = productionReadiness(revoked());
    expect(r.art.approved || r.storyboard.approved).toBe(false);
    expect(r.storyboard.technicalProblems).toEqual([]);
    expect(r.renderable).toBe(true);
    expect(productionReadiness(gapped()).storyboard.technicalProblems.length).toBeGreaterThan(0);
    expect(productionReadiness(gapped()).renderable).toBe(false);
    expect(productionAlignmentBasis(revoked())).toBeTruthy();
  });
});

describe('assertProductionApproval', () => {
  it('lets only a director-started call past revoked approvals', () => {
    expect(() => assertProductionApproval(revoked(), 'storyboard')).toThrow(expect.objectContaining(APPROVAL));
    expect(() => assertProductionApproval(revoked(), 'storyboard', { startedBy: 'director' })).toThrow(expect.objectContaining(APPROVAL));
    expect(() => assertProductionApproval(revoked(), 'storyboard', { startedBy: true })).toThrow(expect.objectContaining(APPROVAL));
    expect(() => assertProductionApproval(revoked(), 'storyboard', director)).not.toThrow();
  });

  it('refuses a coverage gap for everyone', () => {
    expect(() => assertProductionApproval(gapped(), 'storyboard')).toThrow(expect.objectContaining(APPROVAL));
    expect(() => assertProductionApproval(gapped(), 'storyboard', director)).toThrow(expect.objectContaining(INCOMPLETE));
  });

  it('never relaxes the proof stage', () => {
    expect(() => assertProductionApproval(revoked(), 'proof', director)).toThrow(expect.objectContaining(APPROVAL));
  });
});

// Each entry point: unattended halts, the director gets past the gate, a coverage gap refuses both.
const entries = {
  'final render': (options) => renderMusicVideo('p1', { codeDirectory: 'unreviewed', ...options }),
  'code generation': (options) => generateMusicVideoCode('p1', options),
  'code section regeneration': (options) => regenerateMusicVideoCodeSection('p1', 'a', options),
  'document generation': (options) => generateMixedMediaDocument('p1', options),
  'document section regeneration': (options) => regenerateMixedMediaSection('p1', 'a', options),
  'document event revision': (options) => reviseMixedMediaEvents('p1', options),
};
// Past the gate each entry fails (or succeeds) on something else; reaching it proves the gate let the call through.
const gateCodes = ['MUSIC_VIDEO_APPROVAL_REQUIRED', 'MUSIC_VIDEO_STORYBOARD_INCOMPLETE'];
const outcome = (call) => call().then(() => null, (err) => err?.code ?? err?.message);

describe.each(Object.entries(entries))('%s', (_name, call) => {
  it('halts an unattended caller on revoked approvals', async () => {
    h.project = revoked();
    expect(await outcome(() => call({}))).toBe('MUSIC_VIDEO_APPROVAL_REQUIRED');
  });

  it('does not let a request-body field stand in for the director', async () => {
    h.project = revoked();
    expect(await outcome(() => call({ startedBy: 'director', directorStarted: true }))).toBe('MUSIC_VIDEO_APPROVAL_REQUIRED');
  });

  it('lets the director past revoked approvals', async () => {
    h.project = revoked();
    expect(gateCodes).not.toContain(await outcome(() => call(director)));
  });

  it('refuses a storyboard with a coverage gap for both', async () => {
    h.project = gapped();
    expect(await outcome(() => call({}))).toBe('MUSIC_VIDEO_APPROVAL_REQUIRED');
    expect(await outcome(() => call(director))).toBe('MUSIC_VIDEO_STORYBOARD_INCOMPLETE');
  });
});
