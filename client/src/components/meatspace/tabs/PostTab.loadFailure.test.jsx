import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { getPostSessions } = vi.hoisted(() => ({ getPostSessions: vi.fn() }));
vi.mock('../../../services/api', () => ({
  getPostConfig: () => Promise.resolve(null),
  getPostRecommendations: () => Promise.resolve({ recommendations: [] }),
  getPostSessions,
  getPostStats: () => Promise.resolve(null),
}));
vi.mock('../post/PostSessionLauncher', () => ({
  default: ({ recentSessions }) => <div data-testid="launcher">{recentSessions.length} sessions</div>,
}));

import PostTab from './PostTab';

afterEach(cleanup);

describe('PostTab recent sessions load', () => {
  it('raises a retryable notice when the sessions read fails instead of passing an empty list silently', async () => {
    getPostSessions.mockRejectedValueOnce(new Error('boom'));
    render(<MemoryRouter><PostTab tab="launcher" /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recent sessions');

    getPostSessions.mockResolvedValue([{ id: 's1', date: '2026-03-01' }]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('launcher')).toHaveTextContent('1 sessions');
  });
});
