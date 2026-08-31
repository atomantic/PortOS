import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getPersistentMindTools: vi.fn(),
  getProviders: vi.fn(),
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
    api.getProviders.mockResolvedValue({ providers: [] });
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
        capabilities: { schemaVersion: 3, createTasks: true, manageMind: false, readPortos: false, writePortos: false },
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
      { persistentMindCapabilities: { schemaVersion: 5, createTasks: true, manageMind: false, manageEidoverse: false, callUser: false, readPortos: false, writePortos: false, taskModelAllowlist: [] } },
      { silent: true },
    ));
    expect(await screen.findByText(/persistent-mind capabilities granted/)).toHaveTextContent('1 of 1');
    expect(screen.getByText('Granted')).toBeInTheDocument();
    expect(await screen.findByText('Available task filing choices')).toBeInTheDocument();
    expect(screen.getAllByText(/Implementation or Plan & File Issue/)).not.toHaveLength(0);
    expect(screen.getByText('gpt-5 · low, high')).toBeInTheDocument();
    expect(api.getPersistentMindTools).toHaveBeenCalledTimes(2);
  });

  it('grants self-maintenance separately from broader PortOS write access', async () => {
    const user = userEvent.setup();
    renderPage();

    const toggle = await screen.findByRole('checkbox', { name: 'Allow mind to clean up its mindspace' });
    await user.click(toggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: {
        schemaVersion: 5,
        createTasks: false,
        manageMind: true,
        manageEidoverse: false,
        callUser: false,
        readPortos: false,
        writePortos: false,
        taskModelAllowlist: [],
      } },
      { silent: true },
    ));
    expect(screen.getByRole('checkbox', { name: 'Allow bounded PortOS updates' })).not.toBeChecked();
  });

  it('lets the user narrow task access to individual managed apps', async () => {
    const user = userEvent.setup();
    api.getPersistentMindTools.mockResolvedValueOnce(response({
      capabilities: { schemaVersion: 3, createTasks: true, manageMind: false, readPortos: false, writePortos: false },
      tools: [{ ...response().tools[0], granted: true }],
      taskCatalog: {
        apps: [
          { id: 'example-app', name: 'Example App', planOnly: false, granted: true },
          { id: 'second-app', name: 'Second App', planOnly: true, granted: true },
        ],
        providers: [],
      },
    }));
    renderPage();

    const secondApp = await screen.findByRole('checkbox', { name: 'Second App' });
    expect(secondApp).toBeChecked();
    await user.click(secondApp);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: {
        schemaVersion: 5,
        createTasks: true,
        manageMind: false,
        manageEidoverse: false,
        callUser: false,
        readPortos: false,
        writePortos: false,
        taskModelAllowlist: [],
        allowedAppIds: ['example-app'],
      } },
      { silent: true },
    ));
    expect(secondApp).not.toBeChecked();
    expect(screen.getByRole('link', { name: 'Example App' })).toHaveAttribute('href', '/apps/example-app/automation');
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
      capabilities: { schemaVersion: 3, createTasks: true, manageMind: false, readPortos: false, writePortos: false },
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

  it('offers the call grant off by default and sends it as an explicit false alongside other edits', async () => {
    // A phone call is the one grant whose absence the user cannot notice by
    // looking at a screen, so the control must be visible even when off, and
    // an unrelated toggle must never quietly drop the field from the payload.
    const user = userEvent.setup();
    renderPage();

    const callToggle = await screen.findByRole('checkbox', { name: /Allow mind to call you on FaceTime Audio/ });
    expect(callToggle).not.toBeChecked();

    await user.click(callToggle);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: {
        schemaVersion: 5,
        createTasks: false,
        manageMind: false,
        manageEidoverse: false,
        callUser: true,
        readPortos: false,
        writePortos: false,
        taskModelAllowlist: [],
      } },
      { silent: true },
    ));
  });
});
