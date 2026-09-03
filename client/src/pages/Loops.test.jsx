import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../services/api', () => ({
  getLoops: vi.fn(() => Promise.resolve([])),
  getLoopProviders: vi.fn(() => Promise.resolve({ providers: [] })),
  createLoop: vi.fn(() => Promise.resolve({})),
  stopLoop: vi.fn(() => Promise.resolve({})),
  resumeLoop: vi.fn(() => Promise.resolve({})),
  deleteLoop: vi.fn(() => Promise.resolve({})),
  triggerLoop: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

// Mirror the real hook's on-mount fetch (the page clears `loading` only from
// that callback) while dropping the interval, which jsdom has no use for.
vi.mock('../hooks/useAutoRefetch', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    useAutoRefetch: (fetchFn) => {
      const fetchRef = useRef(fetchFn);
      fetchRef.current = fetchFn;
      useEffect(() => { fetchRef.current(); }, []);
      return { refetch: () => fetchRef.current() };
    },
  };
});

import Loops from './Loops';

describe('Loops new-loop form label associations', () => {
  it('pairs the Interval label with the custom-interval input via explicit htmlFor/id', async () => {
    render(<Loops />);
    const input = await screen.findByLabelText('Interval');
    const label = screen.getByText('Interval');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('placeholder')).toBe('custom');
    // Prove the explicit htmlFor/id pairing (not merely an aria-label match).
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
  });
});

describe('Loops index empty state', () => {
  it('offers a call to action that focuses the new-loop prompt', async () => {
    render(<Loops />);
    expect(await screen.findByText('No loops yet')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Describe your first loop' });
    await userEvent.click(cta);
    expect(screen.getByLabelText('Loop prompt')).toHaveFocus();
  });
});
