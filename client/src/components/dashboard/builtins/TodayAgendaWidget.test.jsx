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
    expect(screen.getByText('1 of 1 shown event remaining')).toBeTruthy();
    expect(screen.getByText('10 events today')).toBeTruthy();
  });

  it('scopes a zero remaining count to the displayed page when every shown event has ended', () => {
    renderWidget({
      date: '2026-09-01',
      accountCount: 1,
      total: 10,
      events: Array.from({ length: 8 }, (_, i) => ({
        id: String(i), accountId: 'acc', title: `Finished ${i}`,
        startTime: iso(-7200000), endTime: iso(-3600000), isAllDay: false, location: null,
      })),
    });

    expect(screen.getByText('0 of 8 shown events remaining')).toBeTruthy();
    expect(screen.getByText('10 events today')).toBeTruthy();
    expect(screen.getByText('+2 more')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/calendar/agenda');
  });

  it('shows the remaining count only for displayed events in a partial response', () => {
    renderWidget({
      date: '2026-09-01',
      accountCount: 1,
      total: 4,
      events: [
        { id: 'a', accountId: 'acc', title: 'Finished', startTime: iso(-7200000), endTime: iso(-3600000), isAllDay: false, location: null },
        { id: 'b', accountId: 'acc', title: 'Upcoming', startTime: iso(3600000), endTime: iso(7200000), isAllDay: false, location: null },
      ],
    });

    expect(screen.getByText('1 of 2 shown events remaining')).toBeTruthy();
    expect(screen.getByText('4 events today')).toBeTruthy();
    expect(screen.getByText('+2 more')).toBeTruthy();
  });

  it('formats large counts in both the day total and omitted-event cue', () => {
    renderWidget({
      date: '2026-09-01',
      accountCount: 1,
      total: 12345,
      events: [
        { id: 'a', accountId: 'acc', title: 'Upcoming', startTime: iso(3600000), endTime: iso(7200000), isAllDay: false, location: null },
      ],
    });

    expect(screen.getByText('12,345 events today')).toBeTruthy();
    expect(screen.getByText('+12,344 more')).toBeTruthy();
  });
});
