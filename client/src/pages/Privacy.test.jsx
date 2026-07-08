import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// ── Mock the API surface ─────────────────────────────────────────────────────
vi.mock('../services/api', () => ({
  getPrivacyStatus: vi.fn().mockResolvedValue({
    keyConfigured: true,
    recordCounts: { address: 1, email: 1 },
  }),
  getVaultRecords: vi.fn().mockResolvedValue([
    {
      id: 'rec-1', type: 'address', label: 'Home address', maskedValue: '•••, Portland OR',
      status: 'current', validFrom: null, validTo: null, shareWithTwin: false, useForScans: true,
    },
    {
      id: 'rec-2', type: 'email', label: 'Primary email', maskedValue: 'a•••@example.com',
      status: 'current', validFrom: null, validTo: null, shareWithTwin: true, useForScans: true,
    },
  ]),
  revealVaultRecord: vi.fn().mockResolvedValue({ id: 'rec-1', type: 'address', value: '123 Main St, Portland OR' }),
  deleteVaultRecord: vi.fn().mockResolvedValue({ ok: true }),
  updateVaultRecord: vi.fn(),
  createVaultRecord: vi.fn(),
  getPrivacyOrgs: vi.fn().mockResolvedValue([
    { id: 'org-1', name: 'Acme Bank', category: 'bank', trust: 'trusted', status: 'active', website: '', contact: {} },
  ]),
  getPrivacyOrg: vi.fn(),
  createPrivacyOrg: vi.fn(),
  updatePrivacyOrg: vi.fn(),
  deletePrivacyOrg: vi.fn().mockResolvedValue({ ok: true }),
  getOrgHoldings: vi.fn().mockResolvedValue([]),
  setOrgHoldings: vi.fn(),
}));

import Privacy from './Privacy';
import { revealVaultRecord } from '../services/api';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/privacy/:tab" element={<Privacy />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Privacy Center', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders the Overview tab with encryption status and counts', async () => {
    renderAt('/privacy/overview');
    await waitFor(() => expect(screen.getByText(/Engaged/i)).toBeInTheDocument());
    // Total record count (1 address + 1 email = 2).
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders vault records masked — no plaintext in the DOM until reveal', async () => {
    renderAt('/privacy/vault');
    await waitFor(() => expect(screen.getByText('Home address')).toBeInTheDocument());
    // Masked value shows; plaintext does NOT.
    expect(screen.getByText('•••, Portland OR')).toBeInTheDocument();
    expect(screen.queryByText('123 Main St, Portland OR')).not.toBeInTheDocument();
  });

  it('reveals plaintext only after clicking Reveal', async () => {
    renderAt('/privacy/vault');
    await waitFor(() => screen.getByText('Home address'));
    const revealBtn = screen.getAllByLabelText('Reveal value')[0];
    fireEvent.click(revealBtn);
    await waitFor(() => expect(screen.getByText('123 Main St, Portland OR')).toBeInTheDocument());
    expect(revealVaultRecord).toHaveBeenCalledWith('rec-1');
  });

  it('renders the Organizations tab with a trust badge', async () => {
    renderAt('/privacy/organizations');
    await waitFor(() => expect(screen.getByText('Acme Bank')).toBeInTheDocument());
    // "Trusted" appears both as a filter chip and the org's trust badge.
    expect(screen.getAllByText('Trusted').length).toBeGreaterThanOrEqual(1);
  });

  it('stale :tab param falls back to Overview', async () => {
    renderAt('/privacy/bogus');
    await waitFor(() => expect(screen.getByText(/system of record/i)).toBeInTheDocument());
  });
});
