import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getPersistentMindTools: vi.fn(),
  updateCosConfig: vi.fn(),
}));

vi.mock('../services/api', () => api);
vi.mock('../components/ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import PersistentMindTools from './PersistentMindTools';

const response = (overrides = {}) => ({
  schemaVersion: 1,
  capabilities: { schemaVersion: 1, createTasks: false },
  tools: [{
    id: 'cos.create-task',
    capability: 'createTasks',
    name: 'Queue CoS agent tasks',
    description: 'Request a bounded, typed CoS task for an app using a configured coding provider.',
    kind: 'typed-action',
    defaultEnabled: false,
    granted: false,
    guardrails: ['Up to five requests per turn'],
  }],
  boundaries: ['No arbitrary shell or file-system access'],
  taskCatalog: null,
  ...overrides,
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cos/mind/tools']}>
    <PersistentMindTools />
  </MemoryRouter>,
);

describe('PersistentMindTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPersistentMindTools.mockResolvedValue(response());
    api.updateCosConfig.mockResolvedValue({ success: true });
  });

  it('renders the server-described authority inventory and hard boundaries', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Access inventory' })).toBeInTheDocument();
    expect(screen.getByText(/persistent-mind capabilities granted/)).toHaveTextContent('0 of 1');
    expect(screen.getByText('No arbitrary shell or file-system access')).toBeInTheDocument();
    expect(screen.getByText('Off by default')).toBeInTheDocument();
  });

  it('edits the typed task grant and refreshes the newly available catalog', async () => {
    const user = userEvent.setup();
    api.getPersistentMindTools
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        capabilities: { schemaVersion: 1, createTasks: true },
        tools: [{ ...response().tools[0], granted: true }],
        taskCatalog: {
          apps: [{ id: 'example-app', name: 'Example App', planOnly: true }],
          providers: [{ id: 'codex', name: 'Codex', type: 'cli', models: [{ id: 'gpt-5', efforts: ['low', 'high'] }] }],
        },
      }));
    renderPage();

    const toggle = await screen.findByRole('checkbox', { name: 'Allow mind to queue CoS agent tasks' });
    await user.click(toggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: { schemaVersion: 2, createTasks: true, readPortos: false, writePortos: false } },
      { silent: true },
    ));
    expect(await screen.findByText(/persistent-mind capabilities granted/)).toHaveTextContent('1 of 1');
    expect(screen.getByText('Granted')).toBeInTheDocument();
    expect(await screen.findByText('Available task filing choices')).toBeInTheDocument();
    expect(screen.getByText(/Implementation or Plan & File Issue/)).toBeInTheDocument();
    expect(screen.getByText('gpt-5 · low, high')).toBeInTheDocument();
    expect(api.getPersistentMindTools).toHaveBeenCalledTimes(2);
  });

  it('does not let a stale catalog refresh restore a revoked grant', async () => {
    const user = userEvent.setup();
    let resolveCatalog;
    api.getPersistentMindTools
      .mockResolvedValueOnce(response())
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveCatalog = resolve;
      }));
    renderPage();

    const toggle = await screen.findByRole('checkbox', { name: 'Allow mind to queue CoS agent tasks' });
    await user.click(toggle);
    await waitFor(() => expect(api.getPersistentMindTools).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle).toBeChecked());

    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    resolveCatalog(response({
      capabilities: { schemaVersion: 1, createTasks: true },
      tools: [{ ...response().tools[0], granted: true }],
      taskCatalog: { apps: [{ id: 'stale-app', name: 'Stale App', planOnly: false }], providers: [] },
    }));

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByText('Available task filing choices')).not.toBeInTheDocument();
  });

  it('keeps the failure visible instead of presenting an empty inventory', async () => {
    api.getPersistentMindTools.mockRejectedValue(new Error('Server unreachable'));
    renderPage();

    expect(await screen.findByText('Tools unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/persistent-mind capabilities granted/)).not.toBeInTheDocument();
  });
});
