import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const socketMock = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));
vi.mock('../../services/socket', () => ({ default: socketMock }));
vi.mock('../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: 'night' } }),
}));
vi.mock('../../services/apiCalendar.js', () => ({
  getCalendarEvents: vi.fn(),
}));
vi.mock('../../services/apiGoals.js', () => ({
  getChronotypeEnergySchedule: vi.fn(),
}));

import { getCalendarEvents } from '../../services/apiCalendar.js';
import MonthView from './MonthView';

describe('MonthView narrow-viewport layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCalendarEvents.mockResolvedValue({ events: [], total: 0 });
  });

  it('wraps the nav header and puts the 7-column grid in an overflow-x-auto container with min-w-[308px]', async () => {
    const { container } = render(
      <MemoryRouter>
        <MonthView accounts={[{ id: 'acct-1', subcalendars: [] }]} />
      </MemoryRouter>
    );
    await act(async () => {});

    const todayBtn = screen.getByRole('button', { name: 'Today' });
    const navHeader = todayBtn.parentElement;
    expect(navHeader.className).toContain('flex-wrap');
    expect(navHeader.className).toContain('gap-2');
    expect(navHeader.firstElementChild.className).toContain('min-w-0');

    const satHeader = screen.getByText('Sat');
    const minWidthInner = satHeader.closest('.min-w-\\[308px\\]');
    expect(minWidthInner).toBeTruthy();
    const scrollWrapper = minWidthInner.parentElement;
    expect(scrollWrapper.className).toContain('overflow-x-auto');
    expect(scrollWrapper.className).not.toContain('overflow-hidden');
    expect(container.querySelector('.overflow-x-auto .min-w-\\[308px\\]')).toBeTruthy();
  });
});
