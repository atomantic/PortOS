import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const { getPostSessions, getPostConfig } = vi.hoisted(() => ({ getPostSessions: vi.fn(), getPostConfig: vi.fn() }));
vi.mock('../../../services/apiMeatspace.js', () => ({
  getPostConfig,
  getPostRecommendations: () => Promise.resolve({ recommendations: [] }),
  getPostSessions,
  getPostStats: () => Promise.resolve(null),
}));
vi.mock('../post/PostSessionLauncher', () => ({
  default: ({ recentSessions, config }) => <div data-testid="launcher">{recentSessions.length} sessions {config?.marker}</div>,
}));
vi.mock('../post/PostDrillConfig', () => ({
  default: ({ config }) => <div data-testid="drill-config">{config.marker}</div>,
}));
vi.mock('../post/PracticePlan', () => ({
  default: ({ config }) => <div data-testid="practice-plan">{config.marker}</div>,
}));

import PostTab from './PostTab';

beforeEach(() => {
  getPostConfig.mockResolvedValue({ marker: 'saved' });
  getPostSessions.mockResolvedValue([]);
});
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

describe('PostTab config load', () => {
  it.each([
    ['launcher', 'launcher', /Loading configuration/],
    ['config', 'drill-config', /Loading configuration/],
    ['plan', 'practice-plan', /Loading practice plan/],
  ])('shows a retryable error on /post/%s instead of the loading sentence, then renders after retry', async (tab, testId, loadingText) => {
    getPostConfig.mockRejectedValueOnce(new Error('config down'));
    render(<MemoryRouter><PostTab tab={tab} /></MemoryRouter>);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load POST configuration');
    expect(screen.queryByText(loadingText)).toBeNull();
    expect(screen.queryByTestId(testId)).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId(testId)).toHaveTextContent(/saved/);
  });

  it('keeps the sessions alert separate when only sessions fail', async () => {
    getPostSessions.mockRejectedValueOnce(new Error('boom'));
    render(<MemoryRouter><PostTab tab="plan" /></MemoryRouter>);
    expect(await screen.findByTestId('practice-plan')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
