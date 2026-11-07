import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ project: null, references: vi.fn(), hydrate: vi.fn(), greybox: null }));
vi.mock('./projects.js', () => ({ getProject: async () => m.project }));
vi.mock('./clipCastReferences.js', async (original) => ({ ...(await original()), musicVideoClipReferences: (...args) => m.references(...args) }));
vi.mock('./catalogCheckin.js', async (original) => ({ ...(await original()), withCatalogCheckin: (...args) => m.hydrate(...args) }));
vi.mock('./greyboxReferences.js', () => ({ loadMusicVideoGreybox: async () => m.greybox }));

import { applyMusicVideoSubmissionGuards } from './submissionGuards.js';

const tag = { projectId: 'project', sceneId: 'shot', promptAsTyped: true, expectedClipReferenceFiles: ['a.png'], expectedClipReferenceLabels: ['Rider'] };
const request = () => ({
  body: { mode: 'ic-ingredients-25', musicVideo: tag }, backend: 'local', performance: null,
  params: { prompt: 'Reference sheet: Rider.\n\nGenerated video: A rider turns', icReferencePaths: ['/gallery/a.png'] },
  prepared: { sourceImagePath: '/gallery/start.png' },
});

beforeEach(() => {
  m.greybox = null;
  m.project = { id: 'project', scenes: [{ sceneId: 'shot', referenceImageId: 'start.png',
    clipReferenceIds: ['ref-a'], prompt: 'A rider turns' }],
  visualSpec: { references: [{ id: 'ref-a', imageId: 'a.png', role: 'character' }, { id: 'ref-b', imageId: 'b.png', role: 'character' }] } };
  m.references.mockReset().mockImplementation(async (_tag, _limit, { project }) => project.scenes[0].clipReferenceIds
    .map((id) => ({ path: `/gallery/${id === 'ref-a' ? 'a' : 'b'}.png`, promptLabel: project.label || 'Rider' })));
});

describe('LTX clip reference snapshot', () => {
  it('rejects a selection changed after the reference files were prepared', async () => {
    m.project.scenes[0].clipReferenceIds = ['ref-b'];
    await expect(applyMusicVideoSubmissionGuards(request())).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
    expect(m.references).toHaveBeenCalledWith(tag, 8, { project: m.project, excludePath: '/gallery/start.png', includePromptLabels: true });
  });

  it('rejects labels changed after the shot prompt was built', async () => {
    m.project.label = 'Another rider';
    await expect(applyMusicVideoSubmissionGuards(request())).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
  });

  it('builds reference labels for a tagged caller without a client snapshot', async () => {
    const input = request();
    input.body.musicVideo = { projectId: 'project', sceneId: 'shot', compose: true, promptAsTyped: true };
    input.params.prompt = 'A rider turns';
    await applyMusicVideoSubmissionGuards(input);
    expect(input.params.prompt).toBe('Reference sheet: Rider.\n\nGenerated video: A rider turns');
  });

  it('still rejects changed reference files when the label snapshot is omitted', async () => {
    const input = request();
    input.body.musicVideo = { projectId: 'project', sceneId: 'shot' };
    m.project.scenes[0].clipReferenceIds = ['ref-b'];
    await expect(applyMusicVideoSubmissionGuards(input)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
  });

  it('records the same snapshot that resolved the actual files', async () => {
    const input = request();
    await applyMusicVideoSubmissionGuards(input);
    expect(input.params.musicVideoDependencies.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'clipReferences', untrackedCastGuides: false }),
    ]));
  });
});

describe('local reference model with a greybox plate', () => {
  const localRequest = (paths, tagExtra = {}) => ({
    body: { mode: 'image', musicVideo: { projectId: 'project', sceneId: 'shot', promptAsTyped: true,
      greyboxPlateFile: 'layout.png', expectedClipReferenceFiles: ['a.png'], ...tagExtra } },
    backend: 'local', performance: null,
    params: { prompt: 'A rider turns', referenceImagePaths: paths },
    prepared: { sourceImagePath: '/gallery/start.png' },
  });

  // Uniquely catches the card's cast-only list being compared with the plate the local job leads with.
  it('compares the cast list without the leading plate and still requires the plate itself', async () => {
    m.greybox = { reference: { imageId: 'layout.png' }, path: '/gallery/layout.png', promptAdditions: [] };
    await expect(applyMusicVideoSubmissionGuards(localRequest(['/gallery/layout.png', '/gallery/a.png']))).resolves.toBeDefined();
    await expect(applyMusicVideoSubmissionGuards(localRequest(['/gallery/layout.png', '/gallery/b.png'])))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
    await expect(applyMusicVideoSubmissionGuards(localRequest(['/gallery/a.png'])))
      .rejects.toMatchObject({ code: 'MUSIC_VIDEO_GREYBOX_CHANGED' });
  });
});

it('rechecks catalog readiness at final video dispatch and rejects old files without a client reference snapshot', async () => {
  const input = request();
  input.body.mode = 'grok';
  input.backend = 'grok';
  input.body.musicVideo = { projectId: 'project', sceneId: 'shot', promptAsTyped: true };
  input.params = { prompt: 'A rider turns', castReferences: [{ path: '/gallery/legacy-sheet.png' }] };
  m.project.castAndSets = { source: 'catalog', status: 'approved', images: { character: { imageId: 'legacy-sheet.png' } },
    catalogCheckin: { approved: true, problems: [], items: [] } };
  m.hydrate.mockImplementation(async project => ({ ...project, castAndSets: { ...project.castAndSets,
    catalogCheckin: { approved: false, problems: [{ code: 'CATALOG_RECORD_MISSING', message: 'Restore or relink the catalog record for Lead.' }], items: [] } } }));
  await expect(applyMusicVideoSubmissionGuards(input)).rejects.toMatchObject({ code: 'CAST_SETS_CATALOG_UNRESOLVED' });
  m.hydrate.mockImplementation(async project => project);
  await expect(applyMusicVideoSubmissionGuards(input)).rejects.toMatchObject({ code: 'CAST_SETS_CATALOG_REFERENCE_CHANGED' });
  input.params.castReferences = [];
  m.project.castAndSets.catalogCheckin.basis = 'current-catalog';
  input.body.musicVideo.catalogBasis = 'stale-catalog';
  await expect(applyMusicVideoSubmissionGuards(input)).rejects.toMatchObject({ code: 'CAST_SETS_CATALOG_REFERENCE_CHANGED' });
  delete input.body.musicVideo.catalogBasis;
  input.body.icReferenceImageFiles = ['old-catalog.png'];
  await expect(applyMusicVideoSubmissionGuards(input)).rejects.toMatchObject({ code: 'CAST_SETS_CATALOG_REFERENCE_CHANGED' });
  input.body.musicVideo.catalogBasis = 'current-catalog';
  await expect(applyMusicVideoSubmissionGuards(input)).resolves.toBeDefined();
  expect(input.params.musicVideoCatalogBasis).toBe('current-catalog');
});
