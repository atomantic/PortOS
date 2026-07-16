import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DailyDriverWidget from './DailyDriverWidget';

const mocks = vi.hoisted(() => ({
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

  it('shows the "Define your goals" empty-state when there are no active goals', async () => {
    renderWidget();
    expect(await screen.findByText('Define your goals')).toBeTruthy();
    const link = screen.getByText('Define your goals').closest('a');
    expect(link.getAttribute('href')).toBe('/goals/list');
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

    expect(screen.getByText('Check in on all goals').closest('a').getAttribute('href')).toBe('/goals/list');
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
});
