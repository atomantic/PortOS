import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useNavigate: () => navigateMock };
});

const api = vi.hoisted(() => ({
  getPrivacyStatus: vi.fn(),
  getPrivacyOrgs: vi.fn(),
  getPrivacyScanStatus: vi.fn(),
}));
vi.mock('../../services/apiPrivacy.js', () => ({
  getPrivacyStatus: api.getPrivacyStatus,
  getPrivacyOrgs: api.getPrivacyOrgs,
  getPrivacyScanStatus: api.getPrivacyScanStatus,
}));

import PrivacyOverviewTab from './PrivacyOverviewTab';

describe('PrivacyOverviewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPrivacyStatus.mockResolvedValue({
      keyConfigured: true,
      recordCounts: { email: 2, address: 1 },
    });
    api.getPrivacyOrgs.mockResolvedValue([
      { id: 'org-1', name: 'Acme Bank', trust: 'trusted' },
    ]);
    api.getPrivacyScanStatus.mockResolvedValue({
      enabledBrokers: 3,
      caseCounts: { found: 1, confirmed_removed: 1 },
    });
  });

  it('shows per-read errors and retries to genuine empty summaries', async () => {
    const failure = new Error('Unavailable');
    api.getPrivacyStatus.mockRejectedValueOnce(failure).mockResolvedValue({ keyConfigured: false, recordCounts: {} });
    api.getPrivacyOrgs.mockRejectedValueOnce(failure).mockResolvedValue([]);
    api.getPrivacyScanStatus.mockRejectedValueOnce(failure).mockResolvedValue({ enabledBrokers: 0, caseCounts: {} });
    render(<PrivacyOverviewTab />);

    expect(await screen.findAllByRole('alert')).toHaveLength(3);
    expect(screen.queryByText(/No records yet|None tracked yet|no scan run yet|Engaged/)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]);

    expect(await screen.findByText('No records yet')).toBeInTheDocument();
    expect(screen.getByText('None tracked yet')).toBeInTheDocument();
    expect(screen.getByText(/no scan run yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders a single-sentence intro paragraph', async () => {
    render(<PrivacyOverviewTab />);
    await waitFor(() => expect(screen.getByText('Vault values stay hidden until you reveal them.')).toBeInTheDocument());

    const intro = screen.getByText('Vault values stay hidden until you reveal them.');
    expect(screen.queryByText(/system of record/i)).toBeNull();
    const sentences = intro.textContent.trim().split(/(?<=[.?!])\s+/);
    expect(sentences.length).toBeLessThanOrEqual(1);
  });

  it('does not render "Manage vault" or "Manage organizations" buttons', async () => {
    render(<PrivacyOverviewTab />);
    await waitFor(() => expect(screen.getByText('Vault records')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /manage vault/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /manage organizations/i })).toBeNull();
  });

  it('navigates to the vault tab when clicking the Vault records card', async () => {
    render(<PrivacyOverviewTab />);
    await waitFor(() => expect(screen.getByText('Vault records')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Vault records/i }));
    expect(navigateMock).toHaveBeenCalledWith('/privacy/vault');
  });

  it('navigates to the organizations tab when clicking the Organizations card', async () => {
    render(<PrivacyOverviewTab />);
    await waitFor(() => expect(screen.getByText('Organizations')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Organizations/i }));
    expect(navigateMock).toHaveBeenCalledWith('/privacy/organizations');
  });

  it('navigates to the data brokers tab when clicking the Data brokers card', async () => {
    render(<PrivacyOverviewTab />);
    await waitFor(() => expect(screen.getByText('Data brokers')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Data brokers/i }));
    expect(navigateMock).toHaveBeenCalledWith('/privacy/brokers');
  });

  it('preserves subjectId in navigation query param when scoped to household member', async () => {
    render(<PrivacyOverviewTab subjectId="sub-42" />);
    await waitFor(() => expect(screen.getByText('Vault records')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Vault records/i }));
    expect(navigateMock).toHaveBeenCalledWith('/privacy/vault?subject=sub-42');

    fireEvent.click(screen.getByRole('button', { name: /Organizations/i }));
    expect(navigateMock).toHaveBeenCalledWith('/privacy/organizations?subject=sub-42');

    fireEvent.click(screen.getByRole('button', { name: /Data brokers/i }));
    expect(navigateMock).toHaveBeenCalledWith('/privacy/brokers?subject=sub-42');
  });
});
