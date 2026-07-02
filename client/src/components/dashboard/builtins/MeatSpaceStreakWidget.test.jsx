import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MeatSpaceStreakWidget from './MeatSpaceStreakWidget';

const renderWidget = (meatspaceLogging) =>
  render(
    <MemoryRouter>
      <MeatSpaceStreakWidget dashboardState={{ meatspaceLogging }} />
    </MemoryRouter>
  );

const baseStats = {
  currentStreak: 4,
  longestStreak: 9,
  weekTotal: 5,
  totalLogged: 30,
  domains: [
    { key: 'alcohol', label: 'Alcohol', total: 10, thisWeek: 2 },
    { key: 'nicotine', label: 'Nicotine', total: 5, thisWeek: 0 },
    { key: 'workouts', label: 'Workouts', total: 15, thisWeek: 3 },
  ],
  last7Days: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-06-2${i}`,
    label: 'Mon',
    domains: i % 2,
    logged: i % 2 === 1,
  })),
};

describe('MeatSpaceStreakWidget', () => {
  it('renders nothing when stats are absent', () => {
    const { container } = renderWidget(null);
    expect(container.firstChild).toBeNull();
  });

  it('shows the current streak and deep-links to MeatSpace', () => {
    renderWidget(baseStats);
    expect(screen.getByText('4 days')).toBeTruthy();
    expect(screen.getByText('Logging streak')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/meatspace/overview');
  });

  it('lists only domains with logs this week', () => {
    renderWidget(baseStats);
    expect(screen.getByText('Alcohol')).toBeTruthy();
    expect(screen.getByText('Workouts')).toBeTruthy();
    // Nicotine has 0 this week and should be omitted.
    expect(screen.queryByText('Nicotine')).toBeNull();
  });

  it('shows the best streak when the current run is not the record', () => {
    renderWidget(baseStats);
    expect(screen.getByText('9 days')).toBeTruthy();
    expect(screen.getByText('Best')).toBeTruthy();
  });

  it('prompts to start when there is no active streak', () => {
    renderWidget({ ...baseStats, currentStreak: 0, domains: [], last7Days: [] });
    expect(screen.getByText('No streak — log something today')).toBeTruthy();
    expect(screen.getByText('No logs this week yet')).toBeTruthy();
  });
});
