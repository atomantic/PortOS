import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import api from '../services/api';
import Jira from './Jira';

const DAY_MS = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

const renderPage = async () => {
  const result = render(
    <MemoryRouter>
      <Jira />
    </MemoryRouter>
  );
  await act(async () => {});
  return result;
};

const instance = (overrides = {}) => ({
  instances: {
    'inst-1': {
      id: 'inst-1',
      name: 'Acme JIRA',
      baseUrl: 'https://acme.example.com',
      email: 'me@example.com',
      hasApiToken: true,
      ...overrides,
    },
  },
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// This heuristic replaced a hardcoded 30-day "likely expired" guess that produced a
// false positive on a real token still authenticating fine after 35+ days — these
// tests pin the honest, non-committal replacement so that regression can't recur.
describe('Jira page — token age display', () => {
  it('shows "age unknown" when tokenUpdatedAt was never recorded', async () => {
    api.get.mockResolvedValue(instance({ tokenUpdatedAt: undefined }));
    await renderPage();

    expect(await screen.findByText(/Token age unknown — re-save to start tracking age/)).toBeInTheDocument();
  });

  it('shows no age warning for a recently-saved token', async () => {
    api.get.mockResolvedValue(instance({ tokenUpdatedAt: daysAgo(1) }));
    await renderPage();

    await screen.findByText('Acme JIRA');
    expect(screen.queryByText(/Token saved/)).not.toBeInTheDocument();
    expect(screen.queryByText(/age unknown/)).not.toBeInTheDocument();
  });

  it('nudges toward Test for a token saved 60+ days ago, without asserting it is expired', async () => {
    api.get.mockResolvedValue(instance({ tokenUpdatedAt: daysAgo(65) }));
    await renderPage();

    expect(await screen.findByText(/Token saved 65 days ago — click Test to confirm it's still valid/)).toBeInTheDocument();
    expect(screen.queryByText(/likely expired/)).not.toBeInTheDocument();
    expect(screen.queryByText(/regenerate your PAT/)).not.toBeInTheDocument();
  });

  it('never claims a working token is expired, no matter how old it is', async () => {
    // Regression guard: the previous 30-day fixed-lifetime heuristic asserted expiry
    // from age alone. A real Cloud/Server PAT can validly outlive any such guess, so
    // the UI must only ever suggest verifying with Test, never assert expiry.
    api.get.mockResolvedValue(instance({ tokenUpdatedAt: daysAgo(400) }));
    await renderPage();

    expect(await screen.findByText(/Token saved 400 days ago/)).toBeInTheDocument();
    expect(screen.queryByText(/expired/)).not.toBeInTheDocument();
  });
});
