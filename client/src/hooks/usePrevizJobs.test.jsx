import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const handlers = new Map();
vi.mock('../services/socket.js', () => ({
  default: { on: (event, fn) => handlers.set(event, fn), off: (event) => handlers.delete(event) },
}));
const getJobs = vi.hoisted(() => vi.fn());
vi.mock('../services/apiCatalog.js', () => ({ getCatalogPrevizJobs: getJobs }));

const { default: usePrevizJobs } = await import('./usePrevizJobs.js');

const project = { id: 'mv-1', concept: { subjects: [
  { id: 'p1', kind: 'place', ingredientId: 'cat-a' }, { id: 'p2', kind: 'place', ingredientId: 'cat-b' }, { id: 'p3', kind: 'place', ingredientId: 'cat-c' },
] } };
const draft = (ingredientId, label, state = 'running', endedAt = null) => ({ id: label, kind: 'greybox-draft', ingredientId, label, state, endedAt, summary: state === 'done' ? '2 part(s)' : null });

// Catches an agent-started draft never showing as step N of M on an already-open Previz page.
describe('usePrevizJobs', () => {
  it('reads work already running on load, then follows socket snapshots through to idle', async () => {
    getJobs.mockResolvedValue({ jobs: [draft('cat-a', 'Lawns', 'done', 5), draft('cat-b', 'Alley'), draft('cat-other', 'Elsewhere')] });
    const { result } = renderHook(() => usePrevizJobs(project));
    await act(async () => {});
    expect(result.current.step).toEqual({ label: 'Drafting greybox 2 of 3: Alley', value: 1, max: 3 });

    await act(async () => handlers.get('catalog:previz-jobs')({ jobs: [draft('cat-a', 'Lawns', 'done', 5), draft('cat-b', 'Alley', 'done', 9)] }));
    expect(result.current.running).toEqual([]);
    expect(result.current.step).toBeNull();
    expect(result.current.finished).toMatchObject({ label: 'Alley', summary: '2 part(s)' });
  });

  it('ignores jobs for other videos and shows a proposal as an unmeasured step', async () => {
    getJobs.mockResolvedValue({ jobs: [{ id: 'x', kind: 'proposal', projectId: 'mv-other', label: 'AI previz proposal', state: 'running' }, { id: 'y', kind: 'proposal', projectId: 'mv-1', label: 'AI previz proposal', state: 'running' }] });
    const { result } = renderHook(() => usePrevizJobs(project));
    await act(async () => {});
    expect(result.current.running).toHaveLength(1);
    expect(result.current.step).toEqual({ label: 'AI previz proposal in progress', value: null, max: null });
  });
});
