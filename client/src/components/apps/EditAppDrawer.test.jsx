import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Mock the API surface EditAppDrawer touches on mount, plus the work-tracker
// resolver and the update path used on save.
const { getInstanceFeatures } = vi.hoisted(() => ({ getInstanceFeatures: vi.fn() }));
vi.mock('../../services/apiApps.js', () => ({
  getAppWorkTracker: vi.fn(),
  getAppLayeredIntelligence: vi.fn(),
  getAppLayeredIntelligenceOutcomes: vi.fn(),
  getAppTaskTypes: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
  updateApp: vi.fn(),
  upgradeAppTls: vi.fn(),
}));
vi.mock('../../services/apiProviders.js', () => ({
  getProviders: vi.fn(),
}));

vi.mock('../../services/apiSystem.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getInstanceFeatures,
  getDatadogInstances: vi.fn(),
}));

import { getDatadogInstances } from '../../services/apiSystem.js';
import {
  getAppWorkTracker,
  getAppLayeredIntelligence,
  getAppLayeredIntelligenceOutcomes,
  getAppTaskTypes,
  updateAppTaskTypeOverride,
  updateApp,
} from '../../services/apiApps.js';
import { getProviders } from '../../services/apiProviders.js';
import { __resetInstanceFeatureCache } from '../../hooks/useInstanceFeatures.js';
import { PORTOS_APP_ID } from '../../services/apiCore';
import EditAppDrawer from './EditAppDrawer';

const APP = {
  id: 'app-1',
  name: 'My App',
  repoPath: '/repo',
  workTracker: 'auto',
};

// The drawer is now tabbed and deep-links its active tab via a URL search param
// (useDrawerTab), so every render needs a real router around it.
function renderDrawer(props = {}) {
  return render(
    <MemoryRouter>
      <EditAppDrawer app={APP} onClose={() => {}} onSave={() => {}} {...props} />
    </MemoryRouter>
  );
}

// Switch to a named tab pill (both a desktop tab button and a mobile <select>
// option render; target the tab button).
async function openTab(name) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

beforeEach(() => {
  __resetInstanceFeatureCache();
  getDatadogInstances.mockResolvedValue({ instances: {} });
  getInstanceFeatures.mockResolvedValue({
    features: [
      { id: 'datadog', label: 'DataDog', enabled: true },
      { id: 'jira', label: 'JIRA', enabled: true },
      { id: 'gsd', label: 'GSD', enabled: true },
    ],
  });
  getAppWorkTracker.mockResolvedValue({
    configured: 'auto',
    resolved: 'github',
    host: 'github.com',
    forge: 'gh',
    source: 'origin',
  });
  getAppLayeredIntelligence.mockResolvedValue({
    appId: 'app-1',
    isPortos: false,
    config: {
      enabled: false,
      intervalMs: 86400000,
      providerId: null,
      model: null,
      rules: '',
      sources: { goals: true, appMetrics: true, cosMetrics: true, healthReport: true, planMd: true, openIssues: true, custom: [] },
      allowedScopes: ['app-improvement', 'app-data-gap'],
    },
  });
  getAppLayeredIntelligenceOutcomes.mockResolvedValue({ stats: {}, recent: [] });
  getProviders.mockResolvedValue({ providers: [] });
  // Scheduling (enabled/interval/provider/model) is read from the per-app task
  // override now (#2322); default to an empty override.
  getAppTaskTypes.mockResolvedValue({ taskTypeOverrides: {} });
  updateAppTaskTypeOverride.mockResolvedValue({ success: true });
  updateApp.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditAppDrawer tabbed layout', () => {
  it('opens on the General tab with the name field visible', async () => {
    renderDrawer();
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    // Work Tracker lives on a different tab, so it should not be mounted yet.
    expect(screen.queryByLabelText('Work Tracker')).not.toBeInTheDocument();
  });

  it('renders all six section tabs', async () => {
    renderDrawer();
    for (const label of ['General', 'Ports & TLS', 'Commands', 'Workflow', 'Intelligence', 'Features']) {
      expect(await screen.findByRole('tab', { name: label })).toBeInTheDocument();
    }
  });

  it('has no JIRA tab — that config moved to the app detail page JIRA tab', async () => {
    renderDrawer();
    await screen.findByRole('tab', { name: 'General' });
    expect(screen.queryByRole('tab', { name: 'JIRA' })).not.toBeInTheDocument();
  });

  it('lets each managed-app feature inherit or override the global setting', async () => {
    renderDrawer();
    await openTab('Features');

    expect(screen.getByLabelText('DataDog availability')).toHaveValue('inherit');
    expect(screen.getByLabelText('JIRA availability')).toHaveValue('inherit');
    expect(screen.getByLabelText('GSD availability')).toHaveValue('inherit');

    fireEvent.change(screen.getByLabelText('JIRA availability'), { target: { value: 'enabled' } });
    fireEvent.change(screen.getByLabelText('GSD availability'), { target: { value: 'disabled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].featureOverrides).toEqual({
      datadog: null,
      jira: true,
      gsd: false,
    });
  });
});

describe('EditAppDrawer work tracker selector', () => {
  it('renders a labeled select with the five tracker options on the Workflow tab', async () => {
    renderDrawer();
    await openTab('Workflow');

    const select = await screen.findByLabelText('Work Tracker');
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue('auto');

    const optionValues = Array.from(select.querySelectorAll('option')).map(o => o.value);
    expect(optionValues).toEqual(['auto', 'plan', 'github', 'gitlab', 'jira']);
  });

  it('shows the resolved auto target from the work-tracker endpoint', async () => {
    renderDrawer();
    await openTab('Workflow');

    await screen.findByLabelText('Work Tracker');
    expect(getAppWorkTracker).toHaveBeenCalledWith('app-1');
    await waitFor(() =>
      expect(screen.getByText(/Auto → GitHub Issues \(origin: github\.com\)/)).toBeInTheDocument()
    );
  });

  it('updates the selection locally and includes workTracker in the save payload', async () => {
    renderDrawer();
    await openTab('Workflow');

    const select = await screen.findByLabelText('Work Tracker');
    fireEvent.change(select, { target: { value: 'gitlab' } });
    expect(select).toHaveValue('gitlab');

    // The Save button lives in the footer and is present on every tab.
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    const [id, payload] = updateApp.mock.calls[0];
    expect(id).toBe('app-1');
    expect(payload.workTracker).toBe('gitlab');
  });

  it('saves a trimmed GitHub account pin and defaults it to blank', async () => {
    renderDrawer();
    await openTab('Workflow');

    const input = await screen.findByLabelText('GitHub Account');
    // Blank is the documented "infer from the repo owner" default, so an app
    // that never set one must not send a value that looks deliberate.
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '  acme-bot  ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].forgeAccount).toBe('acme-bot');
  });

  it('omits `jira` from the save payload so a drawer save cannot clobber the JIRA tab config', async () => {
    // The server shallow-merges the PUT, so an ABSENT `jira` key preserves the
    // stored config. Sending `{ enabled: false }` (what the removed drawer tab
    // did when its checkbox was unmounted) would silently disable an app's JIRA
    // integration on an unrelated save.
    renderDrawer({ app: { ...APP, jira: { enabled: true, instanceId: 'inst-1', projectKey: 'PROJ' } } });
    await screen.findByLabelText('Name');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1]).not.toHaveProperty('jira');
    expect(updateApp.mock.calls[0][1]).not.toHaveProperty('datadog');
  });

  it('saves the selected default PR completion policy', async () => {
    renderDrawer({ app: { ...APP, defaultUseWorktree: true, defaultOpenPR: true } });
    await openTab('Workflow');

    const select = await screen.findByLabelText('Default PR completion');
    expect(select).toHaveValue('review-then-merge');
    fireEvent.change(select, { target: { value: 'leave-open' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].defaultPrCompletion).toBe('leave-open');
  });
  it('preserves an app draft default when saving another field', async () => {
    renderDrawer({ app: { ...APP, defaultUseWorktree: true, defaultOpenPR: true, defaultPrCompletion: 'draft' } });
    await openTab('Workflow');
    expect(await screen.findByLabelText('Default PR completion')).toHaveValue('draft');
    expect(screen.getByText(/Per-run choices override this default/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].defaultPrCompletion).toBe('draft');
  });

  it('defaults Use auto-merge off for a managed app and on for PortOS, and saves the choice', async () => {
    renderDrawer({ app: { ...APP } });
    await openTab('Workflow');
    const toggle = await screen.findByLabelText('Use auto-merge');
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].useAutoMerge).toBe(true);
  });

  it('defaults Use auto-merge on for PortOS itself', async () => {
    renderDrawer({ app: { ...APP, id: 'portos-default' } });
    await openTab('Workflow');
    expect(await screen.findByLabelText('Use auto-merge')).toBeChecked();
  });

  it('defaults the repo-state audit ON for an app that has never set it, and saves an opt-out', async () => {
    // Unset means ON server-side (repoStateVerificationEnabled), so an app record
    // with no such key must render checked — otherwise the first save of an
    // unrelated field would silently turn the audit off.
    renderDrawer({ app: { ...APP, defaultUseWorktree: true } });
    await openTab('Workflow');

    const toggle = await screen.findByLabelText(/Verify repo state after each agent/);
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].verifyRepoStateOnCompletion).toBe(false);
  });

  // Publishing writes to the app's own repo, so the stored value must round-trip
  // exactly: an app that opted in stays checked, and turning it back off has to
  // reach the server as `false` rather than being dropped from the payload.
  it('round-trips the opt-in repo quality snapshot toggle', async () => {
    renderDrawer({ app: { ...APP, publishQualitySnapshot: true } });
    await openTab('Workflow');

    const toggle = await screen.findByLabelText(/Publish quality snapshot to repo/);
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].publishQualitySnapshot).toBe(false);
  });

  describe('audit priorities editor', () => {
    const saved = () => updateApp.mock.calls[0][1];
    const save = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      await waitFor(() => expect(updateApp).toHaveBeenCalled());
    };

    it('adds, edits and saves a priority row with its paths split per line', async () => {
      renderDrawer();
      await openTab('Workflow');
      fireEvent.click(await screen.findByRole('button', { name: 'Add audit priority' }));
      const row = screen.getByRole('group', { name: 'Audit priority 1' });
      fireEvent.change(within(row).getByLabelText('Name'), { target: { value: ' Legacy importer ' } });
      fireEvent.change(within(row).getByLabelText('Priority'), { target: { value: 'P3' } });
      fireEvent.change(within(row).getByLabelText('Paths (one glob per line)'), { target: { value: 'legacy/**\n\n scripts/import-*.js ' } });
      await save();
      expect(saved().featurePriorities).toEqual([
        { id: expect.any(String), label: 'Legacy importer', paths: ['legacy/**', 'scripts/import-*.js'], priority: 'P3' },
      ]);
    });

    it('edits and removes stored rows, keeping the stored id and note', async () => {
      const featurePriorities = [
        { id: 'checkout', label: 'Checkout', paths: ['src/checkout/**'], priority: 'P0', note: 'revenue' },
        { id: 'legacy', label: 'Legacy', paths: ['legacy/**'], priority: 'P3' },
      ];
      renderDrawer({ app: { ...APP, featurePriorities } });
      await openTab('Workflow');
      const first = await screen.findByRole('group', { name: 'Audit priority 1' });
      expect(within(first).getByLabelText('Name')).toHaveValue('Checkout');
      fireEvent.change(within(first).getByLabelText('Priority'), { target: { value: 'P2' } });
      fireEvent.click(within(screen.getByRole('group', { name: 'Audit priority 2' })).getByRole('button', { name: 'Remove' }));
      await save();
      expect(saved().featurePriorities).toEqual([{ id: 'checkout', label: 'Checkout', paths: ['src/checkout/**'], priority: 'P2', note: 'revenue' }]);
    });

    it('sends an empty array when the last row is removed so the server clears it', async () => {
      renderDrawer({ app: { ...APP, featurePriorities: [{ id: 'a', label: 'A', paths: ['a/**'], priority: 'P3' }] } });
      await openTab('Workflow');
      fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
      await save();
      expect(saved().featurePriorities).toEqual([]);
    });

    it('leaves the field out of an unrelated save', async () => {
      renderDrawer({ app: { ...APP, featurePriorities: [{ id: 'a', label: 'A', paths: ['a/**'], priority: 'P3' }] } });
      await save();
      expect(saved()).not.toHaveProperty('featurePriorities');
    });

    it('blocks the save on an incomplete or prompt-unsafe row and says why', async () => {
      renderDrawer();
      await openTab('Workflow');
      fireEvent.click(await screen.findByRole('button', { name: 'Add audit priority' }));
      const row = screen.getByRole('group', { name: 'Audit priority 1' });
      fireEvent.change(within(row).getByLabelText('Name'), { target: { value: 'Quoted' } });
      fireEvent.change(within(row).getByLabelText('Paths (one glob per line)'), { target: { value: "src/it's/**" } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('no quotes or backticks');
      expect(updateApp).not.toHaveBeenCalled();
    });

    it('blocks the save when a P3 path contains a P0 path, since that would drop prioritized code from audits', async () => {
      renderDrawer({ app: { ...APP, featurePriorities: [
        { id: 'a', label: 'Checkout', paths: ['src/checkout/**'], priority: 'P0' },
        { id: 'b', label: 'Everything else', paths: ['src/**'], priority: 'P3' },
      ] } });
      await openTab('Workflow');
      fireEvent.change(await screen.findByLabelText('Note (optional, not sent to audits)', { selector: '#a-note' }), { target: { value: 'edited' } });
      expect(screen.getByText(/overlaps/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('"Everything else" (P3) path src/** overlaps "Checkout" (P0)');
      expect(updateApp).not.toHaveBeenCalled();
    });

    it('is not offered for PortOS itself, which scopes audits from its feature catalog', async () => {
      renderDrawer({ app: { ...APP, id: PORTOS_APP_ID } });
      await openTab('Workflow');
      await screen.findByLabelText(/Discover repo skills for agents/);
      expect(screen.queryByRole('button', { name: 'Add audit priority' })).not.toBeInTheDocument();
    });
  });

  // Repo skills are third-party prompt text (#17387): unchecked until opted in,
  // and the opt-in reaches the server as an explicit boolean.
  it('opts an app into repo skill discovery', async () => {
    renderDrawer();
    await openTab('Workflow');

    const toggle = await screen.findByLabelText(/Discover repo skills for agents/);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].skillDiscovery).toBe(true);
  });

  it('leaves repo snapshot publishing off for an app that never opted in', async () => {
    renderDrawer();
    await openTab('Workflow');

    expect(await screen.findByLabelText(/Publish quality snapshot to repo/)).not.toBeChecked();
  });
});

describe('EditAppDrawer native launch target', () => {
  it('edits the separate native action without changing standard web fields', async () => {
    renderDrawer({
      app: {
        ...APP,
        uiPort: 3000,
        nativeLaunch: {
          label: 'Godot',
          command: './scripts/game run',
          processName: 'my-app-game'
        }
      }
    });
    await openTab('Commands');

    expect(screen.getByLabelText('Separate native launch action')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Button Label'), { target: { value: 'Play Game' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1]).toMatchObject({
      uiPort: 3000,
      nativeLaunch: {
        label: 'Play Game',
        command: './scripts/game run',
        processName: 'my-app-game'
      }
    });
  });
});

describe('EditAppDrawer update command', () => {
  it('saves the explicitly configured app update routine', async () => {
    renderDrawer();
    await openTab('Commands');

    fireEvent.change(screen.getByLabelText('Update Command'), { target: { value: 'npm run update' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(updateApp).toHaveBeenCalled());
    expect(updateApp.mock.calls[0][1].updateCommand).toBe('npm run update');
  });
});

describe('EditAppDrawer required-field validation across tabs', () => {
  // The required Name/Repository Path inputs live on the General tab and are
  // unmounted while another tab is active, so browser `required` validation
  // can't block a Save from another tab. handleSubmit must validate explicitly.
  it('blocks Save from a non-General tab when Name is empty and surfaces General', async () => {
    renderDrawer({ app: { ...APP, name: '' } });
    await openTab('Workflow');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getByText('Name and Repository Path are required.')).toBeInTheDocument()
    );
    expect(updateApp).not.toHaveBeenCalled();
    // The General tab is surfaced so the offending field is visible again.
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
  });

  it('blocks Save when Repository Path is empty', async () => {
    renderDrawer({ app: { ...APP, repoPath: '   ' } });
    await openTab('Workflow');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getByText('Name and Repository Path are required.')).toBeInTheDocument()
    );
    expect(updateApp).not.toHaveBeenCalled();
  });

  it('blocks Save when a hidden port field holds a non-integer value', async () => {
    renderDrawer({ app: { ...APP, uiPort: '1.5' } });
    // Leave the Ports tab and try to save; the unmounted number input can't
    // self-validate, so handleSubmit must catch it and surface the Ports tab.
    await openTab('Workflow');

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(screen.getByText('UI Port must be a whole number between 1 and 65535.')).toBeInTheDocument()
    );
    expect(updateApp).not.toHaveBeenCalled();
    expect(await screen.findByLabelText('UI Port')).toBeInTheDocument();
  });
});

describe('EditAppDrawer failed reads', () => {
  it('fails the Intelligence tab, not the loop state, when the schedule override read fails', async () => {
    // A defaulted override would render an enabled loop as off, and unticking it
    // would then diff as no change — the loop could not be stopped from here.
    getAppTaskTypes.mockRejectedValueOnce(new Error('boom'));
    getAppTaskTypes.mockResolvedValue({ taskTypeOverrides: { 'layered-intelligence': { enabled: true } } });
    renderDrawer();
    await openTab('Intelligence');

    expect(await screen.findByText(/Couldn.t load the Layered Intelligence config/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Enable the self-improvement loop for this app')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Enable the self-improvement loop for this app')).toBeChecked();
  });

  it('shows a retryable error instead of "no instances configured" when the DataDog read fails', async () => {
    getDatadogInstances.mockRejectedValueOnce(new Error('boom'));
    getDatadogInstances.mockResolvedValue({ instances: { dd1: { id: 'dd1', name: 'Prod', site: 'datadoghq.com' } } });
    renderDrawer({ app: { ...APP, datadog: { enabled: true, instanceId: 'dd1' } } });
    await openTab('Features');

    expect(await screen.findByText(/Could not load DataDog instances/)).toBeInTheDocument();
    expect(screen.queryByText(/No DataDog instances configured/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('DataDog Instance')).toHaveValue('dd1');
  });
});
