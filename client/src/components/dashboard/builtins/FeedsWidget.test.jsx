import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FeedsWidget from './FeedsWidget';

const renderWidget = (feeds) =>
  render(
    <MemoryRouter>
      <FeedsWidget dashboardState={{ feeds }} />
    </MemoryRouter>
  );

describe('FeedsWidget', () => {
  it('renders nothing when stats are absent (fetch failed / no data)', () => {
    const { container } = renderWidget(null);
    expect(container.firstChild).toBeNull();
  });

  it('shows the unread count and deep-links to Brain → Feeds', () => {
    renderWidget({ totalFeeds: 3, totalItems: 20, unreadItems: 7, topUnread: [] });
    expect(screen.getByText('7 unread')).toBeTruthy();
    expect(screen.getByText('3 feeds subscribed')).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/brain/feeds');
  });

  it('lists top unread feed names with per-feed counts', () => {
    renderWidget({
      totalFeeds: 2,
      totalItems: 10,
      unreadItems: 8,
      topUnread: [
        { id: 'a', title: 'Hacker News', unread: 5 },
        { id: 'b', title: 'Lobsters', unread: 3 },
      ],
    });
    expect(screen.getByText('Hacker News')).toBeTruthy();
    expect(screen.getByText('Lobsters')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('shows a caught-up state when nothing is unread', () => {
    renderWidget({ totalFeeds: 2, totalItems: 4, unreadItems: 0, topUnread: [] });
    expect(screen.getByText('0 unread')).toBeTruthy();
    expect(screen.getByText('All caught up 🎉')).toBeTruthy();
  });

  it('singularizes the feed label for a single subscription', () => {
    renderWidget({ totalFeeds: 1, totalItems: 2, unreadItems: 2, topUnread: [{ id: 'a', title: 'Solo', unread: 2 }] });
    expect(screen.getByText('1 feed subscribed')).toBeTruthy();
  });
});
