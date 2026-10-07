import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({ providers: [], selectedProviderId: '', selectedModel: '', availableModels: [], setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }),
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoPromotionPlan: vi.fn(),
  planMusicVideoPromotion: vi.fn(),
}));

import { getMusicVideoPromotionPlan, planMusicVideoPromotion } from '../../services/apiMusicVideo.js';
import PromotionPlanPanel from './PromotionPlanPanel.jsx';

const renderPanel = () => render(<MemoryRouter><PromotionPlanPanel project={{ id: 'mv-1' }} /></MemoryRouter>);

describe('PromotionPlanPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('plans with the artist\'s words and lists the scheduled steps as links to their Actions tasks', async () => {
    getMusicVideoPromotionPlan.mockResolvedValue({ steps: [] });
    planMusicVideoPromotion.mockResolvedValue({ created: [{ id: 't1', title: 'Post the opening clip', dueAt: '2026-10-07T16:30:00.000Z' }] });
    renderPanel();
    expect(await screen.findByRole('button', { name: /Plan promotion/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Who to reach (optional)'), { target: { value: 'People into AI consciousness' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Plan promotion/ })); });

    expect(planMusicVideoPromotion).toHaveBeenCalledWith('mv-1', { audience: 'People into AI consciousness', days: 7 });
    const link = await screen.findByRole('link', { name: 'Post the opening clip' });
    expect(link).toHaveAttribute('href', '/brain/threads?thread=t1');
    expect(screen.getByRole('button', { name: /Plan again/ })).toBeTruthy();
  });

  it('shows the steps already scheduled for the release', async () => {
    getMusicVideoPromotionPlan.mockResolvedValue({ steps: [{ id: 't9', title: 'Answer replies', dueAt: '2026-10-07T16:30:00.000Z' }] });
    renderPanel();
    expect(await screen.findByRole('link', { name: 'Answer replies' })).toBeTruthy();
    expect(getMusicVideoPromotionPlan).toHaveBeenCalledWith('mv-1', { silent: true });
  });
});
