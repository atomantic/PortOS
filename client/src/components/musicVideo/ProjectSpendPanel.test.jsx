import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ProjectSpendPanel from './ProjectSpendPanel.jsx';
import { addMusicVideoSpendAdjustment, deleteMusicVideoSpendAdjustment } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({ addMusicVideoSpendAdjustment: vi.fn(), deleteMusicVideoSpendAdjustment: vi.fn() }));

const renderSpend = (adjustments = []) => ({
  lanes: [
    { lane: 'fal', usd: 3.95, count: 3, unpriced: 0, adjustmentUsd: adjustments.reduce((sum, a) => sum + a.usd, 0) },
    { lane: 'higgsfield', usd: 0, count: 2, unpriced: 2, adjustmentUsd: 0 },
  ],
  bySource: { manual: 3.95, autoReview: 0 }, byRun: {}, legacy: { manual: 0, autoReview: 0 }, adjustments, unpriced: 2,
});
const project = { id: 'mv-example', scenes: [], productionRuns: [], renderSpend: renderSpend() };

beforeEach(() => { vi.clearAllMocks(); });

describe('ProjectSpendPanel', () => {
  it('lists each lane with its renders and names unpriced renders instead of counting them as $0', () => {
    render(<ProjectSpendPanel project={project} />);
    expect(screen.getByRole('heading', { name: /Spend \$3\.95/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/2 renders with no listed price are not in the total/);
    const rows = screen.getAllByRole('listitem');
    expect(within(rows.find((row) => row.textContent.includes('Higgsfield'))).getByText('unpriced renders: 2')).toBeTruthy();
    expect(rows.find((row) => row.textContent.includes('fal.ai')).textContent).toMatch(/3 renders.*\$3\.95/);
  });

  it("saves a lane's actual spend as a true-up and applies the server's summary at once", async () => {
    const onProjectUpdated = vi.fn();
    const adjusted = renderSpend([{ id: 'adjustment:a', lane: 'fal', usd: 35.05, statedUsd: 39, note: 'fal dashboard', at: '2026-11-16T00:00:00.000Z' }]);
    addMusicVideoSpendAdjustment.mockResolvedValue({ renderSpend: adjusted });
    render(<ProjectSpendPanel project={project} onProjectUpdated={onProjectUpdated} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('is (USD)'), { target: { value: '39' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'fal dashboard' } });
    fireEvent.click(save);
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith({ ...project, renderSpend: adjusted }));
    expect(addMusicVideoSpendAdjustment).toHaveBeenCalledWith('mv-example', { lane: 'fal', actualUsd: 39, note: 'fal dashboard' }, { silent: true });
  });

  it('removes an adjustment', async () => {
    const onProjectUpdated = vi.fn();
    const withAdjustment = { ...project, renderSpend: renderSpend([{ id: 'adjustment:a', lane: 'fal', usd: 1, note: null, at: '2026-11-16T00:00:00.000Z' }]) };
    deleteMusicVideoSpendAdjustment.mockResolvedValue({ renderSpend: renderSpend() });
    render(<ProjectSpendPanel project={withAdjustment} onProjectUpdated={onProjectUpdated} />);
    expect(screen.getByRole('heading', { name: /Spend \$4\.95/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the fal.ai adjustment' }));
    await waitFor(() => expect(onProjectUpdated).toHaveBeenCalledWith({ ...withAdjustment, renderSpend: renderSpend() }));
    expect(deleteMusicVideoSpendAdjustment).toHaveBeenCalledWith('mv-example', 'adjustment:a', { silent: true });
  });
});
