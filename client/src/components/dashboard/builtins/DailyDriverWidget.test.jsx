import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { INSTANCE_FEATURES_CHANGED } from '../../../constants/events.js';
import { __resetInstanceFeatureCache } from '../../../hooks/useInstanceFeatures.js';
import DailyDriverWidget from './DailyDriverWidget';

const mocks = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  getPostStats: vi.fn(),
  getPostRecommendations: vi.fn(),
  getGoals: vi.fn(),
  markDailyDriverHandled: vi.fn(),
}));

vi.mock('../../../services/api', () => mocks);

const renderWidget = (dashboardState = {}) =>
  render(
    <MemoryRouter>
      <DailyDriverWidget dashboardState={dashboardState} />
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  __resetInstanceFeatureCache();
  mocks.getInstanceFeatures.mockResolvedValue({ features: [{ id: 'post', enabled: true }] });
  mocks.getPostStats.mockResolvedValue({ completedToday: false, currentStreak: 3 });
  mocks.getPostRecommendations.mockResolvedValue({ recommendations: [{ title: 'Morse copy drill' }] });
  mocks.getGoals.mockResolvedValue({ goals: [] });
  mocks.markDailyDriverHandled.mockResolvedValue({ handledToday: true });
});

describe('DailyDriverWidget', () => {
  it('renders the POST row with the top recommendation when not completed', async () => {
    renderWidget();
    expect(await screen.findByText('Daily POST')).toBeTruthy();
    expect(screen.getByText(/Up next: Morse copy drill/)).toBeTruthy();
  });

  it('shows a done state for POST once completed today', async () => {
    mocks.getPostStats.mockResolvedValue({ completedToday: true, currentStreak: 5 });
    renderWidget();
    expect(await screen.findByText(/Done today · 5 day streak/)).toBeTruthy();
  });

  it('does not collect or prompt for POST when it is disabled on this instance', async () => {
    mocks.getInstanceFeatures.mockResolvedValue({ features: [{ id: 'post', enabled: false }] });
    mocks.getGoals.mockResolvedValue({
      goals: [{ id: 'g1', title: 'Finish the novel', category: 'mastery', status: 'active', checkIns: [] }],
    });

    renderWidget();

    expect(await screen.findByText('Finish the novel')).toBeTruthy();
    expect(screen.queryByText('Daily POST')).toBeNull();
    expect(screen.queryByText('Memory')).toBeTruthy();
    expect(mocks.getPostStats).not.toHaveBeenCalled();
    expect(mocks.getPostRecommendations).not.toHaveBeenCalled();
  });

  it('does not collect or prompt for POST when feature participation cannot be read', async () => {
    mocks.getInstanceFeatures.mockRejectedValue(new Error('offline'));

    renderWidget();

    expect(await screen.findByText('Define your goals')).toBeTruthy();
    expect(screen.queryByText('Daily POST')).toBeNull();
    expect(mocks.getPostStats).not.toHaveBeenCalled();
    expect(mocks.getPostRecommendations).not.toHaveBeenCalled();
  });

  it('removes the mounted POST prompt after participation changes', async () => {
    mocks.getInstanceFeatures
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: true }] })
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: false }] });

    renderWidget();
    expect(await screen.findByText('Daily POST')).toBeTruthy();

    act(() => window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { featureId: 'post', enabled: false },
    })));

    await waitFor(() => expect(screen.queryByText('Daily POST')).toBeNull());
    expect(mocks.getInstanceFeatures).toHaveBeenCalledTimes(2);
  });

  it('ignores an in-flight POST read that started before opt-out', async () => {
    let resolveStats;
    const stats = new Promise((resolve) => { resolveStats = resolve; });
    mocks.getInstanceFeatures
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: true }] })
      .mockResolvedValueOnce({ features: [{ id: 'post', enabled: false }] });
    mocks.getPostStats.mockReturnValue(stats);

    renderWidget();
    await waitFor(() => expect(mocks.getPostStats).toHaveBeenCalled());

    act(() => window.dispatchEvent(new CustomEvent(INSTANCE_FEATURES_CHANGED, {
      detail: { featureId: 'post', enabled: false },
    })));
    await waitFor(() => expect(mocks.getInstanceFeatures).toHaveBeenCalledTimes(2));

    await act(async () => { resolveStats({ completedToday: false, currentStreak: 9 }); });
    expect(screen.queryByText('Daily POST')).toBeNull();
  });

  it('shows the "Define your goals" empty-state when there are no active goals', async () => {
    renderWidget();
    expect(await screen.findByText('Define your goals')).toBeTruthy();
    const link = screen.getByText('Define your goals').closest('a');
    expect(link.getAttribute('href')).toBe('/goals/list');
  });

  it('shows an unavailable row (not the empty-state) when the goals fetch fails', async () => {
    mocks.getGoals.mockRejectedValue(new Error('network'));
    renderWidget();
    expect(await screen.findByText(/Goals unavailable right now/)).toBeTruthy();
    // Must NOT wrongly prompt a user (who may have goals) to define them.
    expect(screen.queryByText('Define your goals')).toBeNull();
  });

  it('renders a "New day" badge only on the first visit of the day', async () => {
    const { unmount } = renderWidget({ dailyDriver: { firstVisitToday: true } });
    expect(await screen.findByText('New day')).toBeTruthy();
    unmount();
    renderWidget({ dailyDriver: { firstVisitToday: false } });
    await screen.findByText('Daily POST');
    expect(screen.queryByText('New day')).toBeNull();
  });

  it('renders goal next-action rows with registry-derived deep-links', async () => {
    mocks.getGoals.mockResolvedValue({
      goals: [
        { id: 'g1', title: 'Run a marathon', category: 'health', status: 'active', checkIns: [] },
        { id: 'g2', title: 'Finish the novel', category: 'creative', status: 'active', checkIns: [] },
        { id: 'g3', title: 'Archived', category: 'health', status: 'completed', checkIns: [] },
      ],
    });
    renderWidget();
    expect(await screen.findByText('Run a marathon')).toBeTruthy();
    expect(screen.getByText('Finish the novel')).toBeTruthy();
    // Completed goals are excluded from the driver.
    expect(screen.queryByText('Archived')).toBeNull();

    // health → Daily POST (/post/launcher); creative → Writers Room (/writers-room)
    const postLink = screen.getAllByText('Daily POST').find((el) => el.closest('a')?.getAttribute('href') === '/post/launcher');
    expect(postLink).toBeTruthy();
    const writersLink = screen.getByText('Writers Room').closest('a');
    expect(writersLink.getAttribute('href')).toBe('/writers-room');

    expect(screen.getByText(/Review & check in on goals/).closest('a').getAttribute('href')).toBe('/goals/list');
  });

  it('surfaces the latest check-in recommendation on a goal row', async () => {
    mocks.getGoals.mockResolvedValue({
      goals: [{
        id: 'g1', title: 'Learn CW', category: 'mastery', status: 'active',
        checkIns: [{ recommendations: ['Practice at 15 WPM daily'] }],
      }],
    });
    renderWidget();
    expect(await screen.findByText('Practice at 15 WPM daily')).toBeTruthy();
  });

  it('marks the day handled and refetches dashboard state on dismiss', async () => {
    const refetch = vi.fn().mockResolvedValue();
    renderWidget({ refetch });
    fireEvent.click(await screen.findByLabelText('Dismiss for today'));
    await waitFor(() => expect(mocks.markDailyDriverHandled).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it('re-enables the dismiss button and does not refetch when the handled request fails', async () => {
    mocks.markDailyDriverHandled.mockRejectedValue(new Error('network'));
    const refetch = vi.fn().mockResolvedValue();
    renderWidget({ refetch });
    const btn = await screen.findByLabelText('Dismiss for today');
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.markDailyDriverHandled).toHaveBeenCalledTimes(1));
    // Failed dismissal must not mark the dashboard clean, and the button
    // returns to enabled so the user can retry.
    await waitFor(() => expect(btn.disabled).toBe(false));
    expect(refetch).not.toHaveBeenCalled();
  });
});
