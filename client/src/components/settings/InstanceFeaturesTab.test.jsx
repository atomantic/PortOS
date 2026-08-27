import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  getInstanceFeatures: vi.fn(),
  updateInstanceFeature: vi.fn(),
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

describe('InstanceFeaturesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The feature list is cached at module scope and shared with the sidebar,
    // so it has to be dropped between tests.
    __resetInstanceFeatureCache();
    mock.getInstanceFeatures.mockResolvedValue({ features: [POST_FEATURE] });
    mock.updateInstanceFeature.mockResolvedValue({ features: [{ ...POST_FEATURE, enabled: false, source: 'explicit' }] });
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
