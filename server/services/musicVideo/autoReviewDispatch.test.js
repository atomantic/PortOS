import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRevisedSections } from './autoReviewDispatch.js';
import { loadSceneCastMedia } from './castGuideMedia.js';
import { dispatchProductionStep } from './productionDispatch.js';
import { loadPoolEnv, routeUnavailableReason } from './productionPool.js';
import { getProject } from './projects.js';
import { releaseRevisionSection } from './revisionService.js';

vi.mock('./projects.js', () => ({ getProject: vi.fn() }));
vi.mock('./revisionService.js', () => ({ releaseRevisionSection: vi.fn() }));
vi.mock('./productionDispatch.js', () => ({ dispatchProductionStep: vi.fn() }));
vi.mock('./productionPool.js', () => ({ loadPoolEnv: vi.fn(), routeUnavailableReason: vi.fn(), sceneRequirement: vi.fn() }));
vi.mock('./castGuideMedia.js', () => ({ loadSceneCastMedia: vi.fn() }));

const sections = [{ sceneId: 'first', kind: 'image' }, { sceneId: 'second', kind: 'video' }, { sceneId: 'third', kind: 'video' }];
const scenes = sections.map(({ sceneId }) => ({ sceneId, label: sceneId, startSec: 0, endSec: 5 }));
const project = { id: 'project-1', videoSettings: { backend: 'local', modelId: 'example-model' }, scenes };
const settings = { imageGen: { mode: 'local' } };
const input = { projectId: project.id, revisionId: 'revision-1', sections };
const dispatch = () => dispatchRevisedSections(input);

beforeEach(() => {
  vi.resetAllMocks();
  getProject.mockResolvedValue(project);
  loadPoolEnv.mockResolvedValue({ settings });
  routeUnavailableReason.mockResolvedValue(null);
  releaseRevisionSection.mockResolvedValue(undefined);
  dispatchProductionStep.mockImplementation(async ({ scene }) => ({ jobId: `job-${scene.sceneId}` }));
});

describe('dispatchRevisedSections', () => {
  it('submits frames and clips in order with their revision tags', async () => {
    expect(await dispatch()).toEqual({
      submitted: sections.map((section) => ({ ...section, jobId: `job-${section.sceneId}` })), halt: null,
    });
    expect(dispatchProductionStep.mock.calls.map(([call]) => [call.stepKind, call.route, call.tag])).toEqual([
      ['frame', { kind: 'image', mode: 'local', model: null }, { projectId: project.id, revisionId: input.revisionId, sceneId: 'first' }],
      ...['second', 'third'].map((sceneId) => ['clip', { kind: 'video', mode: 'local', model: 'example-model' },
        { projectId: project.id, revisionId: input.revisionId, sceneId }]),
    ]);
    expect(loadSceneCastMedia).toHaveBeenCalledExactlyOnceWith(scenes[0], { project });
    expect(releaseRevisionSection).not.toHaveBeenCalled();
  });

  it('leaves an already in-flight section claimed and continues', async () => {
    dispatchProductionStep.mockRejectedValueOnce(Object.assign(new Error('Already queued'), { code: 'AUTO_REVIEW_SECTION_IN_FLIGHT' }));
    expect(await dispatch()).toEqual({
      submitted: sections.slice(1).map((section) => ({ ...section, jobId: `job-${section.sceneId}` })), halt: null,
    });
    expect(releaseRevisionSection).not.toHaveBeenCalled();
  });

  it.each([
    ['route refusal', 'needs-human', 'cannot be generated automatically: renderer is offline'],
    ['spend limit', 'limit-reached', 'Budget exhausted'],
    ['submission failure', 'needs-human', 'was refused: Queue closed'],
  ])('keeps submitted work and releases the refused section and the remainder on %s', async (kind, status, reason) => {
    if (kind === 'route refusal') routeUnavailableReason.mockResolvedValueOnce(null).mockResolvedValueOnce('renderer is offline');
    else dispatchProductionStep.mockResolvedValueOnce({ jobId: 'job-first' }).mockRejectedValueOnce(kind === 'spend limit'
      ? Object.assign(new Error('Budget exhausted'), { code: 'AUTO_REVIEW_SPEND_LIMIT' })
      : new Error('Queue closed'));

    expect(await dispatch()).toEqual({
      submitted: [{ ...sections[0], jobId: 'job-first' }], halt: { status, reason: expect.stringContaining(reason) },
    });
    expect(releaseRevisionSection.mock.calls).toEqual([
      [project.id, input.revisionId, 'second'], [project.id, input.revisionId, 'third'],
    ]);
    expect(dispatchProductionStep.mock.calls.map(([call]) => call.scene.sceneId))
      .toEqual(kind === 'route refusal' ? ['first'] : ['first', 'second']);
  });

  it('releases every section if the pool cannot load, even when one release fails', async () => {
    loadPoolEnv.mockRejectedValueOnce(new Error('Settings unavailable'));
    releaseRevisionSection.mockRejectedValueOnce(new Error('Section disappeared'));
    expect(await dispatch()).toEqual({ submitted: [], halt: {
      status: 'needs-human', reason: expect.stringContaining('Settings unavailable'),
    } });
    expect(releaseRevisionSection.mock.calls).toEqual(sections.map(({ sceneId }) => [project.id, input.revisionId, sceneId]));
    expect(dispatchProductionStep).not.toHaveBeenCalled();
  });

  it('stops before dispatch when a revised shot has an invalid action contract', async () => {
    getProject.mockResolvedValueOnce({ ...project, scenes: [{ ...scenes[0], direction: { actionContract: { version: 2 } } }] });
    expect(await dispatch()).toEqual({ submitted: [], halt: {
      status: 'needs-human', reason: expect.stringContaining('version 1 action contract'),
    } });
    expect(dispatchProductionStep).not.toHaveBeenCalled();
    expect(releaseRevisionSection).toHaveBeenCalledTimes(3);
  });
});
