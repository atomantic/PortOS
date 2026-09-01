import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OnThisDayWidget from './OnThisDayWidget';

const renderWidget = (brainOnThisDay) =>
  render(
    <MemoryRouter>
      <OnThisDayWidget dashboardState={{ brainOnThisDay }} />
    </MemoryRouter>
  );

describe('OnThisDayWidget', () => {
  it('renders nothing when the data is absent (fetch failed / no data)', () => {
    const { container } = renderWidget(null);
    expect(container.firstChild).toBeNull();
  });

  it('deep-links each row by type — journals to their exact past date', () => {
    renderWidget({
      date: '2026-09-01',
      timezone: 'UTC',
      total: 3,
      items: [
        { type: 'journal', id: '2025-09-01', date: '2025-09-01', yearsAgo: 1, title: null, snippet: 'shipped the thing' },
        { type: 'memory', id: 'm1', date: '2024-09-01', yearsAgo: 2, title: 'Trip planning', snippet: 'packed bags' },
        { type: 'idea', id: 'i1', date: '2023-09-01', yearsAgo: 3, title: 'Spark', snippet: 'the pitch' },
      ],
    });

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/brain/daily-log?date=2025-09-01', '/brain/memory', '/brain/ideas']);
    expect(screen.getByText('1 year ago · Daily Log')).toBeTruthy();
    expect(screen.getByText('2 years ago · Memory')).toBeTruthy();
    expect(screen.getByText('shipped the thing')).toBeTruthy();
    expect(screen.getByText('Trip planning')).toBeTruthy();
  });

  it('surfaces the overflow count when the server truncated the list', () => {
    renderWidget({
      date: '2026-09-01',
      timezone: 'UTC',
      total: 12,
      items: [
        { type: 'journal', id: '2025-09-01', date: '2025-09-01', yearsAgo: 1, title: null, snippet: 'one' },
      ],
    });
    expect(screen.getByText('+11 more')).toBeTruthy();
  });
});
