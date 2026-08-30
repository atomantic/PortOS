import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mock = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  updateInstanceFeature: vi.fn(),
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
});
