import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import useMusicVideoProductionReview from './useMusicVideoProductionReview.js';

const api = vi.hoisted(() => ({
  getMusicVideoProductionReview: vi.fn(),
  reverifyMusicVideoAlignment: vi.fn(), importMusicVideoDocumentShots: vi.fn(), saveMusicVideoProductionDraft: vi.fn(),
  prepareMusicVideoProductionReview: vi.fn(), approveMusicVideoProductionReview: vi.fn(), renderMusicVideoProductionProof: vi.fn(),
  musicVideoExcerptRenderEventsUrl: vi.fn(), cancelMusicVideoExcerptRender: vi.fn(), importMusicVideoProductionPlanning: vi.fn(),
  bindMusicVideoProductionShot: vi.fn(), addMusicVideoProductionFeedback: vi.fn(), resolveMusicVideoProductionFeedback: vi.fn(),
  reviseMusicVideoProductionFromFeedback: vi.fn(),
}));
vi.mock('../services/apiMusicVideo.js', () => api);

const readiness = { art: { approved: true }, basis: {} };
const run = (project) => renderHook(({ p }) => useMusicVideoProductionReview({ project: p, replaceProject: vi.fn() }), { initialProps: { p: project } });

beforeEach(() => { vi.clearAllMocks(); api.getMusicVideoProductionReview.mockResolvedValue({ readiness }); });

describe('useMusicVideoProductionReview readiness source (#10136)', () => {
  it('uses the readiness on the read response without another request, and keeps it across a mutation response', async () => {
    const { result, rerender } = run({ id: 'a', productionReadiness: readiness });
    expect(result.current.readiness).toBe(readiness);
    rerender({ p: { id: 'a' } }); // mutation response: no readiness field
    expect(result.current.readiness).toBe(readiness);
    await waitFor(() => expect(api.getMusicVideoProductionReview).toHaveBeenCalledTimes(1));
  });

  it('never shows another project\'s readiness', async () => {
    api.getMusicVideoProductionReview.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = run({ id: 'a', productionReadiness: readiness });
    rerender({ p: { id: 'b' } });
    expect(result.current.readiness).toBeNull();
  });

  it('renders with no project loaded yet', () => {
    const { result } = run(null);
    expect(result.current.readiness).toBeNull();
  });

  it('surfaces a failed readiness fetch instead of silently reading not done', async () => {
    api.getMusicVideoProductionReview.mockRejectedValue(new Error('boom'));
    const { result } = run({ id: 'a' });
    await waitFor(() => expect(result.current.readinessError).toBe('boom'));
    expect(result.current.readiness).toBeNull();
  });
});
