import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  queueOvernightRenders: vi.fn(async () => ({ batchId: 'b1', queued: [{ sceneId: 's1', modelId: 'ltx', jobId: 'j1' }], skipped: [] })),
  listOvernightRenders: vi.fn(async () => ({ batches: [] })),
  cancelOvernightRenders: vi.fn(async () => ({ canceled: 1 })),
}));
vi.mock('../../services/apiImageVideo.js', () => api);
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const { default: OvernightRendersPanel, nextClockTime } = await import('./OvernightRendersPanel.jsx');

const project = { id: 'mv-1', scenes: [
  { sceneId: 's1', referenceImageId: 'a.png', startSec: 0, endSec: 4 },
  { sceneId: 's2', startSec: 4, endSec: 8 },
] };
const models = [{ id: 'ltx', name: 'LTX 2.5', runtime: 'ltx25' }, { id: 'wan', name: 'Wan', runtime: 'wan22' }];

beforeEach(() => vi.clearAllMocks());

describe('overnight renders panel', () => {
  it('offers only shots with a start frame and reference models, and queues the picked pairs with a run window', async () => {
    render(<OvernightRendersPanel project={project} models={models} />);
    expect(screen.queryByText('Wan')).toBeNull();
    fireEvent.click(screen.getByLabelText('Shot 1'));
    fireEvent.click(screen.getByLabelText('LTX 2.5'));
    fireEvent.click(screen.getByRole('button', { name: 'Queue 1 render' }));
    await waitFor(() => expect(api.queueOvernightRenders).toHaveBeenCalled());
    const body = api.queueOvernightRenders.mock.calls[0][0];
    expect(body).toMatchObject({ projectId: 'mv-1', sceneIds: ['s1'], modelIds: ['ltx'] });
    expect(Date.parse(body.stopBy)).toBeGreaterThan(Date.parse(body.startAt));
  });

  it('takes the next time a clock time comes round', () => {
    const evening = new Date(2026, 10, 8, 20, 0);
    expect(nextClockTime('23:00', evening)).toEqual(new Date(2026, 10, 8, 23, 0));
    expect(nextClockTime('07:00', new Date(2026, 10, 8, 23, 0))).toEqual(new Date(2026, 10, 9, 7, 0));
  });
});
