import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mock = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  updateInstanceFeature: vi.fn(),
  updateInstanceFeatureGroup: vi.fn(),
  installEidoverseFeature: vi.fn(),
  updateEidoverseWorldsSource: vi.fn(),
}));

vi.mock('../../services/api', () => mock);

import { INSTANCE_FEATURES_CHANGED } from '../../constants/events.js';
import { __resetInstanceFeatureCache } from '../../hooks/useInstanceFeatures.js';
import InstanceFeaturesTab from './InstanceFeaturesTab';

const POST_FEATURE = {
  id: 'post',
  label: 'POST',
  description: 'Daily cognitive practice, progress metrics, and reminder prompts.',
  enabled: true,
  source: 'default',
};

const JIRA_FEATURE = {
  id: 'jira',
  label: 'JIRA',
  description: 'Sprint boards, ticket triage, and JIRA reports.',
  enabled: true,
  source: 'auto',
  configured: true,
};

const EIDOVERSE_FEATURE = {
  id: 'eidoverse',
  label: 'Eidoverse Worlds',
  description: 'An optional shared 3D world for you and your agents.',
  enabled: false,
  source: 'default',
  setup: {
    installed: false,
    partial: false,
    bunAvailable: true,
    registryAvailable: true,
    appId: null,
    uiPort: 8940,
    runtimeStatus: 'not_registered',
    worldsRepoUrl: 'https://github.com/anima-research/eidoverse-worlds',
    sourceOwners: { self: 'example-owner', upstream: 'anima-research' },
  },
};

// #40 — Comms feature group fixtures: FaceTime Audio, iMessage and Signal
// bucketed under one `comms` group toggle with per-feature tri-state overrides.
const COMMS_GROUP = { id: 'comms', label: 'Comms', description: 'Chat and calling integrations.', enabled: true };

const IMESSAGE_FEATURE = {
  id: 'imessage',
  label: 'iMessage',
  description: 'Machine-local iMessage and SMS reading.',
  enabled: true,
  source: 'default',
  group: 'comms',
};

const SIGNAL_FEATURE = {
  id: 'signal',
  label: 'Signal',
  description: 'Machine-local Signal Desktop message reading.',
  enabled: true,
  source: 'default',
  group: 'comms',
};

const FACETIME_FEATURE = {
  id: 'facetime',
  label: 'FaceTime Audio',
  description: 'Machine-local FaceTime Audio call controls.',
  enabled: false,
  source: 'default',
  group: 'comms',
};

describe('InstanceFeaturesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The feature list is cached at module scope and shared with the sidebar,
    // so it has to be dropped between tests.
    __resetInstanceFeatureCache();
    mock.getInstanceFeatures.mockResolvedValue({ features: [POST_FEATURE] });
    mock.updateInstanceFeature.mockResolvedValue({ features: [{ ...POST_FEATURE, enabled: false, source: 'explicit' }] });
    mock.installEidoverseFeature.mockResolvedValue({
      features: [{
        ...EIDOVERSE_FEATURE,
        enabled: true,
        source: 'explicit',
        setup: { ...EIDOVERSE_FEATURE.setup, installed: true, appId: 'app-eidoverse', runtimeStatus: 'not_started' },
      }],
    });
    mock.updateEidoverseWorldsSource.mockResolvedValue({
      features: [{
        ...EIDOVERSE_FEATURE,
        enabled: true,
        source: 'explicit',
        setup: {
          ...EIDOVERSE_FEATURE.setup,
          installed: true,
          appId: 'app-eidoverse',
          worldsRepoUrl: 'https://github.com/example-owner/eidoverse-worlds',
          runtimeStatus: 'not_started',
        },
      }],
    });
  });

  it('shows the instance-local feature switch', async () => {
    render(<InstanceFeaturesTab />);

    const toggle = await screen.findByRole('switch', { name: 'Disable POST on this instance' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Active on this instance')).toBeInTheDocument();
  });

  it('persists a toggle and reflects the saved state', async () => {
    render(<InstanceFeaturesTab />);
    const toggle = await screen.findByRole('switch', { name: 'Disable POST on this instance' });

    fireEvent.click(toggle);

    await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('post', false, { silent: true }));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Not used on this instance')).toBeInTheDocument();
  });

  it('explains an auto-detected value so a missing nav section is not a mystery', async () => {
    mock.getInstanceFeatures.mockResolvedValue({ features: [JIRA_FEATURE] });
    render(<InstanceFeaturesTab />);

    expect(await screen.findByText(/this install has JIRA configured/i)).toBeInTheDocument();
  });

  it('says an unconfigured integration is why the feature is off', async () => {
    mock.getInstanceFeatures.mockResolvedValue({
      features: [{ ...JIRA_FEATURE, enabled: false, configured: false }],
    });
    render(<InstanceFeaturesTab />);

    expect(await screen.findByText(/no JIRA instance is configured yet/i)).toBeInTheDocument();
  });

  it('makes Eidoverse installation an explicit opt-in action', async () => {
    mock.getInstanceFeatures.mockResolvedValue({ features: [EIDOVERSE_FEATURE] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Install & enable' }));

    await waitFor(() => expect(mock.installEidoverseFeature).toHaveBeenCalledWith(
      'https://github.com/anima-research/eidoverse-worlds',
      { silent: true },
    ));
    expect(await screen.findByRole('link', { name: 'Manage app' })).toHaveAttribute('href', '/apps/app-eidoverse');
    expect(screen.getByText(/start it from the managed app/i)).toBeInTheDocument();
  });

  it('installs a user-selected Worlds fork', async () => {
    mock.getInstanceFeatures.mockResolvedValue({ features: [EIDOVERSE_FEATURE] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    const repoInput = await screen.findByRole('textbox', { name: 'Worlds GitHub repository' });
    fireEvent.change(repoInput, { target: { value: 'https://github.com/example-owner/eidoverse-worlds' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install & enable' }));

    await waitFor(() => expect(mock.installEidoverseFeature).toHaveBeenCalledWith(
      'https://github.com/example-owner/eidoverse-worlds',
      { silent: true },
    ));
  });

  it('builds Self and Upstream sources with the selected Git transport', async () => {
    mock.getInstanceFeatures.mockResolvedValue({ features: [EIDOVERSE_FEATURE] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    const ownerGroup = await screen.findByRole('group', { name: 'Worlds repository owner' });
    const protocolGroup = screen.getByRole('group', { name: 'Worlds repository protocol' });
    expect(ownerGroup.querySelector('[aria-pressed="true"]')).toHaveTextContent('Upstream');
    expect(protocolGroup.querySelector('[aria-pressed="true"]')).toHaveTextContent('HTTP');

    fireEvent.click(screen.getByRole('button', { name: 'Self' }));
    fireEvent.click(screen.getByRole('button', { name: 'SSH' }));

    expect(screen.getByRole('textbox', { name: 'Worlds GitHub repository' }))
      .toHaveValue('git@github.com:example-owner/eidoverse-worlds.git');
    fireEvent.click(screen.getByRole('button', { name: 'Install & enable' }));
    await waitFor(() => expect(mock.installEidoverseFeature).toHaveBeenCalledWith(
      'git@github.com:example-owner/eidoverse-worlds.git',
      { silent: true },
    ));
  });

  it('disables Self when the PortOS origin is not a GitHub repository', async () => {
    mock.getInstanceFeatures.mockResolvedValue({
      features: [{
        ...EIDOVERSE_FEATURE,
        setup: { ...EIDOVERSE_FEATURE.setup, sourceOwners: { self: null, upstream: 'anima-research' } },
      }],
    });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: 'Self' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upstream' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('updates the origin of an installed Worlds checkout in place', async () => {
    const installed = {
      ...EIDOVERSE_FEATURE,
      enabled: true,
      source: 'explicit',
      setup: {
        ...EIDOVERSE_FEATURE.setup,
        installed: true,
        appId: 'app-eidoverse',
        runtimeStatus: 'not_started',
      },
    };
    mock.getInstanceFeatures.mockResolvedValue({ features: [installed] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    const repoInput = await screen.findByRole('textbox', { name: 'Worlds GitHub repository' });
    fireEvent.change(repoInput, { target: { value: 'https://github.com/example-owner/eidoverse-worlds' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update source' }));

    await waitFor(() => expect(mock.updateEidoverseWorldsSource).toHaveBeenCalledWith(
      'https://github.com/example-owner/eidoverse-worlds',
      { silent: true },
    ));
    expect(await screen.findByDisplayValue('https://github.com/example-owner/eidoverse-worlds')).toBeInTheDocument();
  });

  it('does not offer a source update for an equivalent repository URL', async () => {
    const installed = {
      ...EIDOVERSE_FEATURE,
      enabled: true,
      setup: {
        ...EIDOVERSE_FEATURE.setup,
        installed: true,
        appId: 'app-eidoverse',
      },
    };
    mock.getInstanceFeatures.mockResolvedValue({ features: [installed] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    fireEvent.change(
      await screen.findByRole('textbox', { name: 'Worlds GitHub repository' }),
      { target: { value: 'https://github.com/anima-research/eidoverse-worlds.git' } },
    );

    expect(screen.getByRole('button', { name: 'Update source' })).toBeDisabled();
    expect(mock.updateEidoverseWorldsSource).not.toHaveBeenCalled();
  });

  it('keeps installation disabled for an invalid repository URL', async () => {
    mock.getInstanceFeatures.mockResolvedValue({ features: [EIDOVERSE_FEATURE] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Worlds GitHub repository' }), {
      target: { value: 'https://example.com/not-github' },
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid GitHub repository URL');
    expect(screen.getByRole('button', { name: 'Install & enable' })).toBeDisabled();
    expect(mock.installEidoverseFeature).not.toHaveBeenCalled();
  });

  it('explains that the Worlds repository is required when the field is cleared', async () => {
    mock.getInstanceFeatures.mockResolvedValue({ features: [EIDOVERSE_FEATURE] });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    const repoInput = await screen.findByRole('textbox', { name: 'Worlds GitHub repository' });
    fireEvent.change(repoInput, { target: { value: '' } });

    expect(repoInput).toHaveAttribute('aria-invalid', 'true');
    expect(repoInput).toHaveAttribute('aria-describedby', 'eidoverse-worlds-repo-error');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a GitHub repository URL');
    expect(screen.getByRole('button', { name: 'Install & enable' })).toBeDisabled();
  });

  it('offers to install Bun automatically as part of Eidoverse setup', async () => {
    mock.getInstanceFeatures.mockResolvedValue({
      features: [{ ...EIDOVERSE_FEATURE, setup: { ...EIDOVERSE_FEATURE.setup, bunAvailable: false } }],
    });
    render(<MemoryRouter><InstanceFeaturesTab /></MemoryRouter>);

    const install = await screen.findByRole('button', { name: 'Install & enable' });
    expect(install).toBeEnabled();
    expect(screen.getByText(/PortOS will install it automatically/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Install Bun' })).toBeNull();

    fireEvent.click(install);
    await waitFor(() => expect(mock.installEidoverseFeature).toHaveBeenCalledOnce());
  });

  // The sidebar and ⌘K read the same module cache; a retry that updated only
  // this tab would leave them in the fail-open state until a full reload.
  it('broadcasts a successful retry to the other consumers', async () => {
    mock.getInstanceFeatures.mockRejectedValueOnce(new Error('offline'));
    const heard = [];
    const listen = (event) => heard.push(event.detail);
    window.addEventListener(INSTANCE_FEATURES_CHANGED, listen);

    try {
      render(<InstanceFeaturesTab />);
      const retry = await screen.findByRole('button', { name: 'Retry' });
      mock.getInstanceFeatures.mockResolvedValue({ features: [POST_FEATURE] });
      fireEvent.click(retry);

      await screen.findByRole('switch', { name: 'Disable POST on this instance' });
      expect(heard.some((detail) => Array.isArray(detail?.features))).toBe(true);
    } finally {
      window.removeEventListener(INSTANCE_FEATURES_CHANGED, listen);
    }
  });

  it('offers a retry when the feature list cannot be read', async () => {
    mock.getInstanceFeatures.mockRejectedValueOnce(new Error('offline'));
    render(<InstanceFeaturesTab />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    mock.getInstanceFeatures.mockResolvedValue({ features: [POST_FEATURE] });
    fireEvent.click(retry);

    expect(await screen.findByRole('switch', { name: 'Disable POST on this instance' })).toBeInTheDocument();
  });

  // #40 — Comms feature group: a group row with its own toggle, member rows
  // beneath it with a three-way override control; ungrouped rows unchanged.
  describe('feature groups', () => {
    beforeEach(() => {
      mock.getInstanceFeatures.mockResolvedValue({
        features: [POST_FEATURE, IMESSAGE_FEATURE, SIGNAL_FEATURE, FACETIME_FEATURE],
        groups: [COMMS_GROUP],
      });
    });

    it('renders a group toggle and a per-feature override control for each member, leaving ungrouped rows unchanged', async () => {
      render(<InstanceFeaturesTab />);

      // Ungrouped POST keeps its plain on/off switch, untouched by grouping.
      expect(await screen.findByRole('switch', { name: 'Disable POST on this instance' })).toBeInTheDocument();

      // The group itself gets one toggle, labeled by the group (not a member).
      const groupToggle = screen.getByRole('switch', { name: 'Disable the Comms feature group' });
      expect(groupToggle).toHaveAttribute('aria-checked', 'true');

      // Every member gets a three-way override control instead of a switch.
      for (const label of ['iMessage', 'Signal', 'FaceTime Audio']) {
        const control = screen.getByRole('group', { name: `${label} override` });
        expect(within(control).getByRole('button', { name: 'Inherit' })).toBeInTheDocument();
        expect(within(control).getByRole('button', { name: 'On' })).toBeInTheDocument();
        expect(within(control).getByRole('button', { name: 'Off' })).toBeInTheDocument();
        expect(screen.queryByRole('switch', { name: new RegExp(label, 'i') })).toBeNull();
      }

      // Effective state and the inherited default both show through.
      expect(screen.getByText('FaceTime Audio')).toBeInTheDocument();
      const facetimeRow = screen.getByRole('group', { name: 'FaceTime Audio override' }).closest('div.flex');
      expect(within(facetimeRow).getByRole('button', { name: 'Inherit' })).toHaveAttribute('aria-pressed', 'true');
      const imessageRow = screen.getByRole('group', { name: 'iMessage override' }).closest('div.flex');
      expect(within(imessageRow).getByText('Active on this instance')).toBeInTheDocument();
    });

    it('toggles the feature group off and persists it', async () => {
      mock.updateInstanceFeatureGroup.mockResolvedValue({
        features: [
          POST_FEATURE,
          { ...IMESSAGE_FEATURE, enabled: false, source: 'group-off' },
          { ...SIGNAL_FEATURE, enabled: false, source: 'group-off' },
          { ...FACETIME_FEATURE, enabled: false, source: 'group-off' },
        ],
        groups: [{ ...COMMS_GROUP, enabled: false }],
      });
      render(<InstanceFeaturesTab />);

      const groupToggle = await screen.findByRole('switch', { name: 'Disable the Comms feature group' });
      fireEvent.click(groupToggle);

      await waitFor(() => expect(mock.updateInstanceFeatureGroup).toHaveBeenCalledWith('comms', false, { silent: true }));
      expect(await screen.findByRole('switch', { name: 'Enable the Comms feature group' })).toHaveAttribute('aria-checked', 'false');
      // All three members are hidden by the off group with no override of their own.
      expect(screen.getAllByText('hidden by the group toggle above', { exact: false })).toHaveLength(3);
    });

    it('sets a grouped feature override to On', async () => {
      mock.updateInstanceFeature.mockResolvedValue({
        features: [POST_FEATURE, IMESSAGE_FEATURE, SIGNAL_FEATURE, { ...FACETIME_FEATURE, enabled: true, source: 'explicit' }],
        groups: [COMMS_GROUP],
      });
      render(<InstanceFeaturesTab />);

      const control = await screen.findByRole('group', { name: 'FaceTime Audio override' });
      fireEvent.click(within(control).getByRole('button', { name: 'On' }));

      await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('facetime', true, { silent: true }));
      expect(within(control).getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('sets a grouped feature override to Off', async () => {
      mock.updateInstanceFeature.mockResolvedValue({
        features: [POST_FEATURE, { ...IMESSAGE_FEATURE, enabled: false, source: 'explicit' }, SIGNAL_FEATURE, FACETIME_FEATURE],
        groups: [COMMS_GROUP],
      });
      render(<InstanceFeaturesTab />);

      const control = await screen.findByRole('group', { name: 'iMessage override' });
      fireEvent.click(within(control).getByRole('button', { name: 'Off' }));

      await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('imessage', false, { silent: true }));
      expect(within(control).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('clears an explicit override back to Inherit with enabled: null', async () => {
      mock.getInstanceFeatures.mockResolvedValue({
        features: [POST_FEATURE, { ...IMESSAGE_FEATURE, enabled: false, source: 'explicit' }, SIGNAL_FEATURE, FACETIME_FEATURE],
        groups: [COMMS_GROUP],
      });
      mock.updateInstanceFeature.mockResolvedValue({
        features: [POST_FEATURE, IMESSAGE_FEATURE, SIGNAL_FEATURE, FACETIME_FEATURE],
        groups: [COMMS_GROUP],
      });
      render(<InstanceFeaturesTab />);

      const control = await screen.findByRole('group', { name: 'iMessage override' });
      expect(within(control).getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(within(control).getByRole('button', { name: 'Inherit' }));

      await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('imessage', null, { silent: true }));
      expect(within(control).getByRole('button', { name: 'Inherit' })).toHaveAttribute('aria-pressed', 'true');
    });

    // Regression: a response that carries grouped features but an
    // empty/missing `groups` list must not silently drop those features from
    // the tab. `renderGroupCard` returns null for an unresolved group, so
    // without the row-building fallback every comms member vanished here.
    it('falls back to rendering a grouped feature as its own ungrouped card when the groups list is empty', async () => {
      mock.getInstanceFeatures.mockResolvedValue({
        features: [POST_FEATURE, IMESSAGE_FEATURE, SIGNAL_FEATURE, FACETIME_FEATURE],
        groups: [],
      });
      render(<InstanceFeaturesTab />);

      // Every grouped member still renders — as a plain on/off switch, since
      // there's no resolved group to attach a three-way override control to.
      expect(await screen.findByRole('switch', { name: 'Disable POST on this instance' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Disable iMessage on this instance' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Disable Signal on this instance' })).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Enable FaceTime Audio on this instance' })).toBeInTheDocument();
      // No group toggle or group heading rendered — there's no group record to render one from.
      expect(screen.queryByRole('switch', { name: /the Comms feature group/ })).not.toBeInTheDocument();
    });
  });
});
