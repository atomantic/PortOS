import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

vi.mock('../hooks/useAutoRefetch', () => ({
  useAutoRefetch: vi.fn(),
}));

import Loops from './Loops';

describe('Loops new-loop form label associations', () => {
  it('pairs the Interval label with the custom-interval input (htmlFor/id)', async () => {
    render(<Loops />);
    // getByLabelText only resolves when the <label> is wired to the control.
    const input = await screen.findByLabelText('Interval');
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('placeholder')).toBe('custom');
  });
});
