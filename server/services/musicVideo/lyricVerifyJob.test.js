import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startLyricVerify } from './lyricVerifyJob.js';
import { verifyLyricSheet } from './lyricVerify.js';
import { mutateProjectRecord } from './projects.js';
import { broadcastSse } from '../../lib/sseUtils.js';

const state = vi.hoisted(() => ({ project: null }));
vi.mock('./requireProject.js', () => ({ requireProject: async () => structuredClone(state.project) }));
vi.mock('./projects.js', () => ({ mutateProjectRecord: vi.fn(async (_id, transform) => {
  const outcome = await transform(state.project);
  state.project = outcome.project;
  return outcome;
}) }));
vi.mock('./lyricVerify.js', () => ({ verifyPrerequisites: async () => 'stem.wav', verifyLyricSheet: vi.fn() }));
vi.mock('../../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  state.project = { id: 'p', lyricCues: [{ id: 'c', text: 'bright morning' }], productionReview: { draft: { timingStatus: 'verified', timingNotes: 'Listened' }, alignmentBasis: 'prior' } };
});

describe('placement verification persistence', () => {
  it('leaves existing verification alone until an explicit check finds a suspect line', async () => {
    expect(state.project.productionReview.draft.timingStatus).toBe('verified');
    expect(mutateProjectRecord).not.toHaveBeenCalled();
    verifyLyricSheet.mockResolvedValue({ passed: false, misplacedCues: [{ cueId: 'c', offsetSec: 0.6 }], uncheckedCues: [] });
    await startLyricVerify('p');
    await vi.waitFor(() => expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'complete' })));
    expect(state.project.lyricCues[0].suspect).toBe(true);
    expect(state.project.productionReview).toMatchObject({ draft: { timingStatus: 'provisional', timingNotes: 'Listened' }, alignmentBasis: null });
  });
  it('leaves verified timing, alignmentBasis, and cues unchanged when check returns unchecked lines only', async () => {
    expect(state.project.productionReview.draft.timingStatus).toBe('verified');
    expect(state.project.productionReview.alignmentBasis).toBe('prior');
    verifyLyricSheet.mockResolvedValue({ passed: false, misplacedCues: [], uncheckedCues: [{ cueId: 'c', text: 'bright morning' }] });
    await startLyricVerify('p');
    await vi.waitFor(() => expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'complete' })));
    expect(mutateProjectRecord).not.toHaveBeenCalled();
    expect(state.project.lyricCues[0].suspect).toBeUndefined();
    expect(state.project.productionReview.draft.timingStatus).toBe('verified');
    expect(state.project.productionReview.alignmentBasis).toBe('prior');
  });
  it('does not overwrite an edit made between the final read and the write lock', async () => {
    verifyLyricSheet.mockResolvedValue({ misplacedCues: [{ cueId: 'c' }] });
    mutateProjectRecord.mockImplementationOnce(async (_id, transform) => {
      state.project.lyricCues[0].text = 'new lyric';
      return transform(state.project);
    });
    await startLyricVerify('p');
    await vi.waitFor(() => expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'error', code: 'LYRIC_VERIFY_CHANGED' })));
    expect(state.project.lyricCues[0]).toEqual({ id: 'c', text: 'new lyric' });
    expect(state.project.productionReview.draft.timingStatus).toBe('verified');
  });
});
