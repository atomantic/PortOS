import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useMusicVideoProductionReview from './useMusicVideoProductionReview.js';

const api = vi.hoisted(() => ({
  getMusicVideoProductionReview: vi.fn(), getMusicVideoProductionReadiness: vi.fn(),
  reverifyMusicVideoAlignment: vi.fn(), importMusicVideoDocumentShots: vi.fn(), saveMusicVideoProductionDraft: vi.fn(),
  prepareMusicVideoProductionReview: vi.fn(), approveMusicVideoProductionReview: vi.fn(), renderMusicVideoProductionProof: vi.fn(),
  musicVideoExcerptRenderEventsUrl: vi.fn(), cancelMusicVideoExcerptRender: vi.fn(), importMusicVideoProductionPlanning: vi.fn(),
  bindMusicVideoProductionShot: vi.fn(), addMusicVideoProductionFeedback: vi.fn(), resolveMusicVideoProductionFeedback: vi.fn(),
  reviseMusicVideoProductionFromFeedback: vi.fn(),
}));
vi.mock('../../services/apiMusicVideo.js', () => api);
vi.mock('../../services/socketWriteOrigin.js', () => ({ ownWrite: () => ({ silent: true, headers: { 'X-PortOS-Origin': 'socket-example' } }) }));

const readiness = { art: { approved: true }, basis: {} };
const run = (project) => renderHook(({ p }) => useMusicVideoProductionReview({ project: p, replaceProject: vi.fn() }), { initialProps: { p: project } });

beforeEach(() => { vi.clearAllMocks(); api.getMusicVideoProductionReadiness.mockResolvedValue({ readiness }); });

describe('useMusicVideoProductionReview readiness source (#10136)', () => {
  it('uses the readiness on the read response without another request, and keeps it across a mutation response', async () => {
    const { result, rerender } = run({ id: 'a', productionReadiness: readiness });
    expect(result.current.readiness).toBe(readiness);
    expect(result.current.current).toBe(true);
    rerender({ p: { id: 'a' } }); // mutation response: no readiness field
    expect(result.current.readiness).toBe(readiness);
    expect(result.current.current).toBe(false); // stale for stage marks, never for approvals
    await waitFor(() => expect(api.getMusicVideoProductionReadiness).toHaveBeenCalledTimes(1));
  });

  it('never shows another project\'s readiness', async () => {
    api.getMusicVideoProductionReadiness.mockReturnValue(new Promise(() => {}));
    const { result, rerender } = run({ id: 'a', productionReadiness: readiness });
    rerender({ p: { id: 'b' } });
    expect(result.current.readiness).toBeNull();
  });

  it('renders with no project loaded yet', () => {
    const { result } = run(null);
    expect(result.current.readiness).toBeNull();
  });

  it('surfaces a failed readiness fetch instead of silently reading not done', async () => {
    api.getMusicVideoProductionReadiness.mockRejectedValue(new Error('boom'));
    const { result } = run({ id: 'a' });
    await waitFor(() => expect(result.current.readinessError).toBe('boom'));
    expect(result.current.readiness).toBeNull();
  });
});

// #16210: a review action's reply is the board edit result, never the project to swap in.
describe('useMusicVideoProductionReview action replies', () => {
  const edit = { updatedAt: 't2', baseUpdatedAt: 't1', sceneIds: [], scenes: [], project: { productionReadiness: readiness }, removed: [] };
  const project = { id: 'a', updatedAt: 't1', productionReadiness: readiness, scenes: [] };
  const wired = (takes = null) => {
    const props = { replaceProject: vi.fn(), applyEdit: vi.fn(), reloadOpenProject: vi.fn(async () => {}), takesRef: { current: takes } };
    const hook = renderHook(() => useMusicVideoProductionReview({ project, ...props }));
    return { ...props, hook };
  };

  it('patches an edit result in as this tab\'s own write, with no project swap or readiness read', async () => {
    api.addMusicVideoProductionFeedback.mockResolvedValue({ readiness, edit, feedbackId: 'f1' });
    const { hook, applyEdit, replaceProject } = wired();
    await act(() => hook.result.current.feedback({ stage: 'storyboard', text: 'Example' }));
    expect(api.addMusicVideoProductionFeedback.mock.calls[0][2].headers).toEqual({ 'X-PortOS-Origin': 'socket-example' });
    expect(applyEdit).toHaveBeenCalledWith('a', edit);
    expect(replaceProject).not.toHaveBeenCalled();
    expect(api.getMusicVideoProductionReadiness).not.toHaveBeenCalled();
  });

  it('reloads instead when a take decision started while the action was in flight', async () => {
    let started = 0;
    const takes = { writeMark: () => started, settledSince: (mark) => mark === started };
    let finish;
    api.approveMusicVideoProductionReview.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const { hook, applyEdit, reloadOpenProject } = wired(takes);
    let pending;
    act(() => { pending = hook.result.current.approve('art'); });
    started += 1;
    await act(async () => { finish({ readiness, edit }); await pending; });
    expect(applyEdit).not.toHaveBeenCalled();
    expect(reloadOpenProject).toHaveBeenCalledWith('a');
  });

  it('keeps the readiness a whole-project reply carries, so no readiness read follows it', async () => {
    const saved = { id: 'a', updatedAt: 't2' };
    api.prepareMusicVideoProductionReview.mockResolvedValue({ project: saved, readiness });
    const { hook, replaceProject } = wired();
    await act(() => hook.result.current.prepare());
    expect(api.prepareMusicVideoProductionReview.mock.calls[0][2]).toEqual({ silent: true });
    expect(replaceProject).toHaveBeenCalledWith({ ...saved, productionReadiness: readiness });
  });
});
