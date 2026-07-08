/**
 * CDO Phase 3 (#2185) — autopilot/pipeline → Creative Director bridge.
 *
 * Locks the mint-and-start contract: produceVideoFromIssue generates a treatment
 * from the issue's prose (via the shared CD-bridge stage + shaper), mints a FRESH
 * CD project seeded with sourceIssueId, applies the treatment, auto-casts the
 * series canon, and STARTS it — never mutating an existing project (the #842
 * rule). Rolls back on a post-create failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunStagedLLM = vi.fn();
const mockGetIssue = vi.fn();
const mockGetSeries = vi.fn();
const mockCreateProject = vi.fn();
const mockSetTreatment = vi.fn();
const mockDeleteProject = vi.fn();
const mockApplyAutoCast = vi.fn();
const mockDeleteCollection = vi.fn();
const mockStartProject = vi.fn();

// stageRunner is shared by bridgeFromIssue AND liveDirector (which provides the
// real shapeProposal/CD_BRIDGE_STAGE we deliberately keep unmocked).
vi.mock('../../lib/stageRunner.js', () => ({ runStagedLLM: (...a) => mockRunStagedLLM(...a) }));
vi.mock('../pipeline/issues.js', () => ({ getIssue: (...a) => mockGetIssue(...a) }));
vi.mock('../pipeline/series.js', () => ({ getSeries: (...a) => mockGetSeries(...a) }));
vi.mock('../videoGen/local.js', () => ({ defaultVideoModelId: () => 'ltx-model' }));
// './local.js' from here === '../creativeDirector/local.js' from liveDirector —
// one mock covers both importers.
vi.mock('./local.js', () => ({
  createProject: (...a) => mockCreateProject(...a),
  setTreatment: (...a) => mockSetTreatment(...a),
  deleteProject: (...a) => mockDeleteProject(...a),
  updateProject: vi.fn(),
}));
vi.mock('./autoCast.js', () => ({ applyAutoCastToProject: (...a) => mockApplyAutoCast(...a) }));
vi.mock('../mediaCollections.js', () => ({ deleteCollection: (...a) => mockDeleteCollection(...a) }));
// Dynamically imported inside produceVideoFromIssue to break the module cycle.
vi.mock('./completionHook.js', () => ({ startCreativeDirectorProject: (...a) => mockStartProject(...a) }));

const { produceVideoFromIssue } = await import('./bridgeFromIssue.js');

const goodProposal = {
  logline: 'A weary detective returns.',
  synopsis: 'Across one rain-soaked night the detective confronts an old ghost.',
  styleSpec: 'noir, high-contrast',
  scenes: [
    { intent: 'establish', prompt: 'wide neon-lit street', durationSeconds: 4 },
    { intent: 'confront', prompt: 'close-up in the rain', durationSeconds: 6 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetIssue.mockResolvedValue({ id: 'iss-1', seriesId: 'ser-1', title: 'Issue One', stages: { prose: { output: 'Once upon a rainy night...' } } });
  mockGetSeries.mockResolvedValue({ id: 'ser-1', name: 'Noir Nights', premise: 'A city of shadows' });
  mockRunStagedLLM.mockResolvedValue({ content: goodProposal });
  mockCreateProject.mockImplementation(async (input) => ({ id: 'cd-9', collectionId: 'col-9', ...input }));
  mockSetTreatment.mockImplementation(async (id) => ({ id, status: 'rendering' }));
  mockApplyAutoCast.mockResolvedValue({ added: [{ ingredientId: 'ing-1' }] });
  mockStartProject.mockResolvedValue(undefined);
  mockDeleteProject.mockResolvedValue(undefined);
  mockDeleteCollection.mockResolvedValue(undefined);
});

describe('produceVideoFromIssue (#2185)', () => {
  it('mints a fresh project seeded from the issue, applies the treatment, casts, and starts it', async () => {
    const { project, proposal } = await produceVideoFromIssue('iss-1');

    // A NEW project is created (never a pre-existing one) with the source link.
    expect(mockCreateProject).toHaveBeenCalledTimes(1);
    expect(mockCreateProject.mock.calls[0][0]).toMatchObject({
      sourceIssueId: 'iss-1',
      modelId: 'ltx-model',
      styleSpec: 'noir, high-contrast',
      name: 'Issue One — Teaser',
    });

    // Treatment applied to the minted project with scenes mapped to the CD shape.
    expect(mockSetTreatment).toHaveBeenCalledWith('cd-9', expect.objectContaining({
      logline: goodProposal.logline,
      synopsis: goodProposal.synopsis,
    }));
    const scenes = mockSetTreatment.mock.calls[0][1].scenes;
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({ sceneId: 'sc-1', order: 0, useContinuationFromPrior: false });
    expect(scenes[1]).toMatchObject({ sceneId: 'sc-2', order: 1, useContinuationFromPrior: true });

    // Shared cast/canon + explicit start.
    expect(mockApplyAutoCast).toHaveBeenCalledWith('cd-9', expect.objectContaining({ brief: expect.stringContaining('Noir Nights') }));
    expect(mockStartProject).toHaveBeenCalledWith('cd-9');
    expect(project.id).toBe('cd-9');
    expect(proposal.logline).toBe(goodProposal.logline);
  });

  it('falls back to the comic script when there is no prose', async () => {
    mockGetIssue.mockResolvedValue({ id: 'iss-1', seriesId: 'ser-1', title: 'T', stages: { comicScript: { output: 'PAGE 1 PANEL 1 ...' } } });
    await produceVideoFromIssue('iss-1');
    expect(mockRunStagedLLM.mock.calls[0][1].before).toContain('PAGE 1');
  });

  it('rejects when the issue has no prose/script to build from (no project minted)', async () => {
    mockGetIssue.mockResolvedValue({ id: 'iss-1', seriesId: 'ser-1', title: 'T', stages: {} });
    await expect(produceVideoFromIssue('iss-1')).rejects.toThrow(/no prose/i);
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('rejects when the model cannot produce a usable treatment (no project minted)', async () => {
    mockRunStagedLLM.mockResolvedValue({ content: { logline: '', synopsis: '', scenes: [] } });
    await expect(produceVideoFromIssue('iss-1')).rejects.toThrow(/usable teaser treatment/i);
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it('rolls back the orphaned project + collection when start fails after create', async () => {
    mockStartProject.mockRejectedValue(new Error('boom'));
    await expect(produceVideoFromIssue('iss-1')).rejects.toThrow('boom');
    expect(mockDeleteProject).toHaveBeenCalledWith('cd-9');
    expect(mockDeleteCollection).toHaveBeenCalledWith('col-9');
  });

  it('threads the run provider/model into the treatment stage call', async () => {
    await produceVideoFromIssue('iss-1', { providerDefault: 'anthropic', modelDefault: 'opus' });
    const stageOpts = mockRunStagedLLM.mock.calls[0][2];
    expect(stageOpts).toMatchObject({ providerDefault: 'anthropic', modelDefault: 'opus' });
  });
});
