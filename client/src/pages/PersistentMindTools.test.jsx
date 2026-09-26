import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { typeSettled } from '../test/settledInput.js';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getPersistentMindTools: vi.fn(),
  getMindRecipes: vi.fn().mockResolvedValue({ recipes: [] }),
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
  capabilities: { schemaVersion: 1, createTasks: false, toolExposureRetentionTurns: 3, toolExposureAllSchemas: false },
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
  managedApps: null,
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

  it('allows user recipe management with its separate Mind grant off and preserves the grant on later saves', async () => {
    const user = userEvent.setup();
    renderPage();
    const grant = await screen.findByRole('checkbox', { name: 'Allow mind to manage saved tool recipes' });
    expect(grant).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'New recipe' })).toBeEnabled();
    await user.click(grant);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith({
      persistentMindCapabilities: expect.objectContaining({ schemaVersion: 12, manageToolRecipes: true, readPortos: false }),
    }, { silent: true }));
    await user.click(screen.getByRole('checkbox', { name: 'Allow bounded PortOS reads' }));
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenLastCalledWith({
      persistentMindCapabilities: expect.objectContaining({ manageToolRecipes: true, readPortos: true }),
    }, { silent: true }));
  });

  it('updates executable tool access after changing a grant', async () => {
    api.getPersistentMindTools.mockResolvedValue(response({ semanticTools: [{
      name: 'eidoverse.augment', description: 'Build a private world', granted: false,
      input_schema: { type: 'object' }, policy: { requiredCapabilities: ['manageEidoverse'] },
    }] }));
    renderPage();
    expect(await screen.findByText('eidoverse.augment · Disabled')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Allow private Eidoverse world management' }));
    expect(await screen.findByText('eidoverse.augment · Granted')).toBeInTheDocument();
  });

  it('saves peer travel as a separate default-off grant', async () => {
    renderPage();
    const toggle = await screen.findByRole('checkbox', { name: 'Allow guest travel and chat with federated worlds' });
    expect(toggle).not.toBeChecked();
    await userEvent.setup().click(toggle);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith({
      persistentMindCapabilities: expect.objectContaining({ schemaVersion: 12, visitEidoversePeers: true, manageEidoverse: false }),
    }, { silent: true }));
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
        taskCatalog: { providers: [{ id: 'codex', name: 'Codex', type: 'cli', models: [{ id: 'gpt-5', efforts: ['low', 'high'] }] }] },
        managedApps: [{ id: 'example-app', name: 'Example App', planOnly: true, forge: 'github', granted: true }],
      }));
    renderPage();

    const toggle = await screen.findByRole('checkbox', { name: 'Allow mind to queue CoS agent tasks' });
    await user.click(toggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: { schemaVersion: 12, createTasks: true, fileIssues: false, auditReports: false, manageMind: false, manageToolRecipes: false, manageEidoverse: false, visitEidoversePeers: false, promoteEidoverseFoundations: false, installEidoverseControllers: false, callUser: false, adjustLocalContext: false, readPortos: false, writePortos: false, taskModelAllowlist: [] } },
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
        schemaVersion: 12,
        createTasks: false,
        fileIssues: false, auditReports: false,
        manageMind: true,
        manageToolRecipes: false,
        manageEidoverse: false,
        visitEidoversePeers: false,
        promoteEidoverseFoundations: false,
        installEidoverseControllers: false,
        callUser: false,
        adjustLocalContext: false,
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
      taskCatalog: { providers: [] },
      managedApps: [
        { id: 'example-app', name: 'Example App', planOnly: false, forge: null, granted: true },
        { id: 'second-app', name: 'Second App', planOnly: true, forge: 'github', granted: true },
      ],
    }));
    renderPage();

    const secondApp = await screen.findByRole('checkbox', { name: 'Second App' });
    expect(secondApp).toBeChecked();
    await user.click(secondApp);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: {
        schemaVersion: 12,
        createTasks: true,
        fileIssues: false, auditReports: false,
        manageMind: false,
        manageToolRecipes: false,
        manageEidoverse: false,
        visitEidoversePeers: false,
        promoteEidoverseFoundations: false,
        installEidoverseControllers: false,
        callUser: false,
        adjustLocalContext: false,
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
      taskCatalog: { providers: [] },
      managedApps: [{ id: 'stale-app', name: 'Stale App', planOnly: false, forge: null, granted: true }],
    }));

    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(screen.queryByText('Available task filing choices')).not.toBeInTheDocument();
  });

  it('grants issue filing independently and scopes it with the shared managed-app roster', async () => {
    const user = userEvent.setup();
    api.getPersistentMindTools
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response({
        capabilities: { schemaVersion: 12, createTasks: false, fileIssues: true },
        // The roster carries the PLAN.md app too, so narrowing the allowlist
        // here cannot silently revoke an app the task grant would need.
        managedApps: [
          { id: 'example-app', name: 'Example App', planOnly: true, forge: 'github', granted: true },
          { id: 'plan-app', name: 'Plan App', planOnly: false, forge: null, granted: true },
        ],
      }));
    renderPage();

    const toggle = await screen.findByRole('checkbox', { name: /Allow mind to read and file GitHub\/GitLab issues/ });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: expect.objectContaining({ schemaVersion: 12, fileIssues: true, createTasks: false }) },
      { silent: true },
    ));

    const planApp = await screen.findByRole('checkbox', { name: 'Plan App' });
    expect(screen.getByText(/No forge tracker/)).toBeInTheDocument();
    await user.click(planApp);
    await waitFor(() => expect(api.updateCosConfig).toHaveBeenLastCalledWith(
      { persistentMindCapabilities: expect.objectContaining({ fileIssues: true, allowedAppIds: ['example-app'] }) },
      { silent: true },
    ));
  });

  it('saves the progressive tool-exposure retention window on blur and shows its current value', async () => {
    const user = userEvent.setup();
    renderPage();

    const retentionInput = await screen.findByLabelText('Retention window (extra turns)');
    expect(retentionInput).toHaveValue(3);
    await user.clear(retentionInput);
    // Clearing this controlled number field renders 0. Settle that transition
    // before typing: otherwise user.type can append 5 to the old 3 and the
    // component clamps 35 to 20. The generic empty-field helper expects null.
    await waitFor(() => expect(retentionInput).toHaveValue(0));
    await typeSettled(user, retentionInput, '5');
    await user.tab();

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith({
      persistentMindCapabilities: { toolExposureRetentionTurns: 5 },
    }, { silent: true }));
  });

  it('saves the all-schemas escape hatch as its own toggle without disturbing other grants', async () => {
    const user = userEvent.setup();
    renderPage();

    const allSchemasToggle = await screen.findByRole('checkbox', { name: /Send every schema on every turn/ });
    expect(allSchemasToggle).not.toBeChecked();
    await user.click(allSchemasToggle);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith({
      persistentMindCapabilities: { toolExposureAllSchemas: true },
    }, { silent: true }));
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
        schemaVersion: 12,
        createTasks: false,
        fileIssues: false, auditReports: false,
        manageMind: false,
        manageToolRecipes: false,
        manageEidoverse: false,
        visitEidoversePeers: false,
        promoteEidoverseFoundations: false,
        installEidoverseControllers: false,
        callUser: true,
        adjustLocalContext: false,
        readPortos: false,
        writePortos: false,
        taskModelAllowlist: [],
      } },
      { silent: true },
    ));
  });
});
