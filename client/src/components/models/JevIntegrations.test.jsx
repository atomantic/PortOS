import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import JevIntegrations from './JevIntegrations';
import { getJevPolicy, updateJevPolicy, updateInstanceFeature } from '../../services/api';
import { publishInstanceFeatures } from '../../hooks/useInstanceFeatures';

vi.mock('../../services/api', () => ({ getJevPolicy: vi.fn(), updateJevPolicy: vi.fn(), updateInstanceFeature: vi.fn() }));
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({ features: [{ id: 'jev', enabled: false }], error: null }),
  publishInstanceFeatures: vi.fn(),
}));
const policy = { scopeAdherenceEnabled: true, sources: {
  'github-issue': { jevMode: 'off', jevMinMargin: null },
  email: { jevMode: 'prefer', jevMinMargin: 0.3 },
  'stacker-news': { jevMode: 'only', jevMinMargin: null },
} };
beforeEach(() => {
  vi.clearAllMocks();
  getJevPolicy.mockResolvedValue(policy);
});

describe('Jev integration management', () => {
  it('distinguishes enablement from residency, displays definitions, and saves explicit disabling', async () => {
    let finishSave;
    updateJevPolicy.mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
    render(<JevIntegrations status={{ ready: true, resident: false }} registry={{ example: {
      label: 'Example question', minMargin: 0.2, options: [{ value: 'yes', hypothesis: 'Example hypothesis.' }],
    } }} />);
    const control = await screen.findByLabelText('Issue replies and forge maintenance');
    await waitFor(() => expect(control).toBeEnabled());
    expect(screen.getByRole('status')).toHaveTextContent('Integrations: disabled. Runtime: installed, idle.');
    expect(control).toHaveValue('off');
    expect(screen.getByText(/Example hypothesis/)).toBeInTheDocument();
    fireEvent.change(control, { target: { value: 'disabled' } });
    expect(updateJevPolicy).toHaveBeenCalledWith({ sources: { 'github-issue': { jevMode: 'disabled' } } }, { silent: true });
    expect(control).toBeDisabled();
    getJevPolicy.mockResolvedValue({ ...policy, sources: { ...policy.sources, 'github-issue': { jevMode: 'disabled' } } });
    finishSave(await getJevPolicy());
    await waitFor(() => expect(control).toHaveValue('disabled'));
    updateInstanceFeature.mockResolvedValue({ features: [{ id: 'jev', enabled: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Enable Jev integrations' }));
    await waitFor(() => expect(publishInstanceFeatures).toHaveBeenCalledWith([{ id: 'jev', enabled: true }], { groups: undefined }));
  });

  it('keeps the saved setting and reports failed writes', async () => {
    updateJevPolicy.mockRejectedValue(new Error('offline'));
    render(<JevIntegrations />);
    const control = await screen.findByLabelText('Issue / PR scope adherence');
    await waitFor(() => expect(control).toBeEnabled());
    fireEvent.change(control, { target: { value: 'disabled' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(control).toHaveValue('enabled');
  });
});
