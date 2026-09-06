import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import EventDetail from './EventDetail';

const baseEvent = {
  title: 'Standup',
  startTime: '2026-06-30T15:00:00.000Z',
  endTime: '2026-06-30T15:30:00.000Z',
  isAllDay: false,
};

describe('EventDetail', () => {
  it('renders a close button that meets the 44px minimum touch target', () => {
    render(<EventDetail event={baseEvent} onClose={() => {}} />);
    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn.className).toContain('min-w-[44px]');
    expect(closeBtn.className).toContain('min-h-[44px]');
    // icon stays visually centered
    expect(closeBtn.className).toContain('items-center');
    expect(closeBtn.className).toContain('justify-center');
  });

  it('invokes onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<EventDetail event={baseEvent} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// #6289: the drawer's only meeting action. Its two failure modes are opposite —
// hiding a link the user has (the feature silently doesn't exist) and rendering
// one it must not (an unsafe scheme, or a meeting that isn't happening).
describe('EventDetail — Join meeting action (#6289)', () => {
  const withMeeting = (overrides = {}) => ({
    ...baseEvent,
    meetingUrl: 'https://meet.example.com/room-abc',
    ...overrides,
  });

  const joinLink = () => screen.queryByRole('link', { name: /join meeting/i });

  // Querying by the `link` role is also the keyboard-accessibility assertion:
  // it matches only a real <a href>, which is natively focusable and
  // Enter-activatable, where a div-with-onClick would not match at all.
  it('renders a safe, separately-opening link for an event with a meeting URL', () => {
    render(<EventDetail event={withMeeting()} onClose={() => {}} />);

    const link = joinLink();
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe('https://meet.example.com/room-abc');
    expect(link.getAttribute('target')).toBe('_blank');
    // noopener keeps the opened tab from reaching back into PortOS via window.opener.
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.className).toContain('min-h-[44px]');
  });

  it('opening the meeting neither closes the drawer nor changes the selected event', () => {
    const onClose = vi.fn();
    render(<EventDetail event={withMeeting()} onClose={onClose} />);

    // Swallow the navigation the anchor would otherwise perform: happy-dom
    // would try to actually fetch the URL, turning a unit test into a DNS
    // lookup. React still sees the bubbled click, which is what's under test.
    const swallow = (e) => e.preventDefault();
    document.addEventListener('click', swallow);
    fireEvent.click(joinLink());
    document.removeEventListener('click', swallow);

    expect(onClose).not.toHaveBeenCalled();
    // The drawer is still mounted with the same event.
    expect(screen.getByText('Standup')).toBeTruthy();
    expect(joinLink()).toBeTruthy();
  });

  // `canJoin` deliberately carries no time term — people rejoin overruns and
  // recordings — so this guards against a later change narrowing it to upcoming.
  it('shows the action for a meeting that has already started', () => {
    render(<EventDetail
      event={withMeeting({ startTime: '2020-01-01T15:00:00.000Z', endTime: '2020-01-01T15:30:00.000Z' })}
      onClose={() => {}}
    />);

    expect(joinLink()).toBeTruthy();
  });

  it.each([
    ['no meeting URL', { meetingUrl: null }],
    ['an unsafe scheme', { meetingUrl: 'javascript:alert(1)' }],
    ['a cancelled meeting', { meetingUrl: 'https://meet.example.com/room-abc', isCancelled: true }],
    ['a declined meeting', { meetingUrl: 'https://meet.example.com/room-abc', myStatus: 'declined' }],
  ])('renders no join action for %s', (_label, overrides) => {
    render(<EventDetail event={{ ...baseEvent, ...overrides }} onClose={() => {}} />);
    expect(joinLink()).toBeNull();
  });

  it('never renders a link built from the location or description', () => {
    render(<EventDetail
      event={{
        ...baseEvent,
        location: 'https://meet.example.com/from-location',
        description: 'Dial in at https://meet.example.com/from-description',
      }}
      onClose={() => {}}
    />);

    expect(joinLink()).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
