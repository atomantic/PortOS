import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LayeredIntelligence from './LayeredIntelligence';
import * as api from '../services/api';

vi.mock('../services/api', () => ({
  getLayeredIntelligenceOverview: vi.fn(),
  getLayeredIntelligenceProposals: vi.fn()
}));

const renderPage = () => render(
  <MemoryRouter>
    <LayeredIntelligence />
  </MemoryRouter>
);

const overview = (extra = {}) => ({
  taskEnabled: true,
  improvementEnabled: true,
  enabledCount: 1,
  apps: [
    {
      id: 'app-on', name: 'Alpha', isPortos: false, enabled: true, intervalMs: 86400000,
      providerId: null, model: null, hasRules: false,
      lastRunAt: null, nextDueAt: null, due: true,
      allowedScopes: ['app-improvement'],
      sources: { goals: true, cosMetrics: false, healthReport: false, planMd: false, openIssues: true, customCount: 0 }
    },
    {
      id: 'app-off', name: 'Zeta', isPortos: false, enabled: false, intervalMs: 86400000,
      providerId: null, model: null, hasRules: false,
      lastRunAt: null, nextDueAt: null, due: false,
      allowedScopes: ['app-improvement'],
      sources: { goals: true, cosMetrics: false, healthReport: false, planMd: false, openIssues: true, customCount: 0 }
    }
  ],
  ...extra
});

describe('LayeredIntelligence page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders enabled apps with their status and available apps separately', async () => {
    api.getLayeredIntelligenceOverview.mockResolvedValue(overview());
    renderPage();

    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Due now')).toBeInTheDocument();
    // The disabled app appears under "Available apps".
    expect(screen.getByText(/Available apps/)).toBeInTheDocument();
    expect(screen.getByText('Zeta')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 apps have the loop enabled.')).toBeInTheDocument();
  });

  it('warns when the scheduled task is disabled globally', async () => {
    api.getLayeredIntelligenceOverview.mockResolvedValue(overview({ taskEnabled: false }));
    renderPage();

    await waitFor(() => expect(screen.getByText(/scheduled task is off globally/i)).toBeInTheDocument());
    expect(screen.getByText(/Schedule/)).toBeInTheDocument();
  });

  it('warns when CoS improvement is disabled (task on)', async () => {
    api.getLayeredIntelligenceOverview.mockResolvedValue(overview({ taskEnabled: true, improvementEnabled: false }));
    renderPage();

    await waitFor(() => expect(screen.getByText(/improvement/i)).toBeInTheDocument());
  });

  it('shows an error banner + retry when the overview fails to load', async () => {
    api.getLayeredIntelligenceOverview.mockRejectedValue(new Error('boom'));
    renderPage();

    await waitFor(() => expect(screen.getByText(/Couldn't load/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('loads filed-proposal counts + links on demand and merges them into the enabled card', async () => {
    api.getLayeredIntelligenceOverview.mockResolvedValue(overview());
    api.getLayeredIntelligenceProposals.mockResolvedValue({
      apps: [{
        id: 'app-on', name: 'Alpha', ok: true, tracker: 'github', open: 2, closed: 1, total: 3,
        issues: [{ number: 5, title: 'Add widget', state: 'open', url: 'https://github.com/o/r/issues/5' }]
      }]
    });
    renderPage();

    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    const btn = screen.getByRole('button', { name: /Load filed-proposal counts/ });
    await userEvent.click(btn);

    await waitFor(() => expect(screen.getByText(/filed proposals/)).toBeInTheDocument());
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/2 open, 1 closed · GitHub Issues/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /#5/ });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/issues/5');
    // Button flips to "Refresh" once counts are loaded.
    expect(screen.getByRole('button', { name: /Refresh filed counts/ })).toBeInTheDocument();
  });
});
