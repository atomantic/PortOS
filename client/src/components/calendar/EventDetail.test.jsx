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
