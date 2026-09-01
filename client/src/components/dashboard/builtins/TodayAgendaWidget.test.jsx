import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TodayAgendaWidget from './TodayAgendaWidget';

const renderWidget = (calendarAgenda) =>
  render(
    <MemoryRouter>
      <TodayAgendaWidget dashboardState={{ calendarAgenda }} />
    </MemoryRouter>
  );

const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();

describe('TodayAgendaWidget', () => {
  it('renders nothing when the agenda is absent (fetch failed / no data)', () => {
    const { container } = renderWidget(null);
    expect(container.firstChild).toBeNull();
  });

  it('shows the clear-day state and deep-links to Calendar → Agenda', () => {
    renderWidget({ date: '2026-09-01', accountCount: 1, events: [], total: 0 });
    expect(screen.getByText(/Nothing on the calendar today/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/calendar/agenda');
  });

  it('lists events with times, dims finished ones, and counts what remains', () => {
    renderWidget({
      date: '2026-09-01',
      accountCount: 1,
      total: 3,
      events: [
        { id: 'a', accountId: 'acc', title: 'Done meeting', startTime: iso(-7200000), endTime: iso(-3600000), isAllDay: false, location: null },
        { id: 'b', accountId: 'acc', title: 'Focus block', startTime: iso(3600000), endTime: iso(7200000), isAllDay: false, location: 'Office' },
        { id: 'c', accountId: 'acc', title: 'Launch day', startTime: iso(0), endTime: null, isAllDay: true, location: null },
      ],
    });

    expect(screen.getByText('2 of 3 events remaining')).toBeTruthy();
    expect(screen.getByText('All day')).toBeTruthy();
    expect(screen.getByText('Done meeting').className).toContain('line-through');
    expect(screen.getByText('Focus block').className).not.toContain('line-through');
  });

  it('surfaces the overflow count when the server truncated the list', () => {
    renderWidget({
      date: '2026-09-01',
      accountCount: 1,
      total: 10,
      events: [
        { id: 'a', accountId: 'acc', title: 'One', startTime: iso(3600000), endTime: iso(7200000), isAllDay: false, location: null },
      ],
    });
    expect(screen.getByText('+9 more')).toBeTruthy();
  });
});
