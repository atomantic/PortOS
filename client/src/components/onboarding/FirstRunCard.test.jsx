import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

const mock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getInstanceFeatures: vi.fn(),
  updateInstanceFeature: vi.fn(),
}));

vi.mock('../../services/api', () => mock);
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import { __resetInstanceFeatureCache } from '../../hooks/useInstanceFeatures.js';
import {
  FIRST_RUN_HIDE_SETTING,
  FIRST_RUN_MISSIONS,
  FIRST_RUN_SESSION_KEY,
} from '../../lib/firstRunMissions.js';
import FirstRunCard from './FirstRunCard.jsx';

const FEATURES = [
  { id: 'health', enabled: false },
  { id: 'gsd', enabled: false },
  { id: 'openclaw', enabled: false },
  { id: 'post', enabled: true },
];

const heading = 'Where do you want to start?';

const renderCard = async (path = '/') => {
  const router = createMemoryRouter([
    { path: '/', element: <FirstRunCard /> },
    { path: '/apps', element: <FirstRunCard /> },
    { path: '/start-story', element: <div>Start a story</div> },
    { path: '/brain/inbox', element: <div>Brain inbox</div> },
    { path: '/cos/tasks', element: <div>CoS tasks</div> },
  ], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  await act(async () => {});
  return router;
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetInstanceFeatureCache();
  mock.getSettings.mockResolvedValue({});
  mock.updateSettings.mockResolvedValue({ [FIRST_RUN_HIDE_SETTING]: true });
  mock.getInstanceFeatures.mockResolvedValue({ features: FEATURES });
  mock.updateInstanceFeature.mockImplementation(async (id) => ({
    features: FEATURES.map((feature) => (
      feature.id === id ? { ...feature, enabled: true } : feature
    )),
  }));
});

describe('FirstRunCard show/hide', () => {
  it('shows on / after settings load', async () => {
    await renderCard('/');
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    for (const mission of FIRST_RUN_MISSIONS) {
      expect(screen.getByRole('button', { name: new RegExp(mission.label) })).toBeInTheDocument();
    }
  });

  it('never shows on a deep link, even when forced on', async () => {
    await renderCard('/apps?firstRun=1');
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
  });

  it('hides for the rest of the session after explore / escape / the X', async () => {
    await renderCard('/');
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Explore on my own' }));
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
    expect(sessionStorage.getItem(FIRST_RUN_SESSION_KEY)).toBe('1');
    expect(mock.updateSettings).not.toHaveBeenCalled();
  });

  it('lets ?firstRun=1 force the card on even when durably suppressed', async () => {
    mock.getSettings.mockResolvedValue({ [FIRST_RUN_HIDE_SETTING]: true });
    await renderCard('/?firstRun=1');
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
  });

  it('lets ?firstRun=0 force the card off', async () => {
    await renderCard('/?firstRun=0');
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
  });
});

describe('FirstRunCard durable suppress', () => {
  it('stays hidden when general settings already suppress it', async () => {
    mock.getSettings.mockResolvedValue({ [FIRST_RUN_HIDE_SETTING]: true });
    await renderCard('/');
    await act(async () => {});
    expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
  });

  it('writes hideFirstRunCard on general settings, not localStorage', async () => {
    await renderCard('/');
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Don't show this again" }));
    await waitFor(() => {
      expect(mock.updateSettings).toHaveBeenCalledWith(
        { [FIRST_RUN_HIDE_SETTING]: true },
        { silent: true },
      );
    });
    expect(localStorage.getItem(FIRST_RUN_HIDE_SETTING)).toBe(null);
    expect(localStorage.getItem(FIRST_RUN_SESSION_KEY)).toBe(null);
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: heading })).not.toBeInTheDocument();
    });
  });
});

describe('FirstRunCard mission feature writes', () => {
  it('writes only the matching Features toggles, then lands on the mission path', async () => {
    const router = await renderCard('/');
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Personal knowledge/ }));
    await waitFor(() => {
      expect(mock.updateInstanceFeature).toHaveBeenCalledWith('health', true, { silent: true });
    });
    expect(mock.updateInstanceFeature).toHaveBeenCalledTimes(1);
    expect(mock.updateInstanceFeature.mock.calls.every(([id]) => id === 'health')).toBe(true);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/brain/inbox');
    });
  });

  it('does not PATCH features for a mission that has none', async () => {
    const router = await renderCard('/');
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Creative studio/ }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/start-story');
    });
    expect(mock.updateInstanceFeature).not.toHaveBeenCalled();
  });
});
