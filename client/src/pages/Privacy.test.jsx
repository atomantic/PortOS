import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// ── Mock the API surface ─────────────────────────────────────────────────────
vi.mock('../services/api', () => ({
  // Household subjects (#3658) — `self` plus one consenting partner.
  getPrivacySubjects: vi.fn().mockResolvedValue([
    {
      id: '00000000-0000-4000-8000-000000000001', displayName: 'Me', relationship: 'self',
      isSelf: true, consentCount: 1, recordCount: 2,
    },
    {
      id: 'sub-2', displayName: 'Alex', relationship: 'partner',
      isSelf: false, consentCount: 1, recordCount: 1,
    },
  ]),
  createPrivacySubject: vi.fn(),
  deletePrivacySubject: vi.fn(),
  getPrivacySubjectConsents: vi.fn().mockResolvedValue([]),
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
  // Broker case summary chips on the Overview tab (#2146).
  getPrivacyScanStatus: vi.fn().mockResolvedValue({ enabledBrokers: 2, caseCounts: { found: 1 }, dueForRecheck: 0 }),
  getPrivacyOrg: vi.fn(),
  createPrivacyOrg: vi.fn(),
  updatePrivacyOrg: vi.fn(),
  deletePrivacyOrg: vi.fn().mockResolvedValue({ ok: true }),
  getOrgHoldings: vi.fn().mockResolvedValue([]),
  setOrgHoldings: vi.fn(),
  getSocialAccounts: vi.fn().mockResolvedValue({
    accounts: [
      { id: 'sa-1', platform: 'github', username: 'octocat', displayName: 'The Octocat', url: 'https://github.com/octocat' },
    ],
  }),
  getPrivacyChanges: vi.fn().mockResolvedValue([
    {
      id: 'ev-1', vaultRecordId: 'rec-1', replacementRecordId: 'rec-9', kind: 'address_change',
      declaredAt: '2026-07-04T00:00:00Z', note: '',
      oldRecord: { type: 'address', label: 'Home address', maskedValue: '•••, Portland OR' },
      replacementRecord: { type: 'address', label: 'New home', maskedValue: '•••, Seattle WA' },
      progress: { pending: 1, updated: 0, removed: 0, total: 1 },
    },
  ]),
  getPrivacyChange: vi.fn().mockResolvedValue({
    event: { id: 'ev-1', kind: 'address_change' },
    oldRecord: { type: 'address', maskedValue: '•••, Portland OR' },
    replacementRecord: { type: 'address', maskedValue: '•••, Seattle WA' },
    progress: { pending: [{ orgId: 'org-1', orgName: 'Acme Bank', website: null, contactEmail: 'ops@acme.example' }], updated: [], removed: [] },
  }),
  declarePrivacyChange: vi.fn(),
  markChangeOrgUpdated: vi.fn(),
  markChangeOrgRemoved: vi.fn(),
  draftChangeUpdateEmail: vi.fn(),
}));

import Privacy from './Privacy';
import {
  revealVaultRecord, getVaultRecords, getPrivacyStatus, getPrivacySubjects,
} from '../services/api';

const SELF_ID = '00000000-0000-4000-8000-000000000001';

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

  it('exposes the Digital Twin social-account cross-link picker in the org drawer (#2147)', async () => {
    renderAt('/privacy/organizations');
    await waitFor(() => expect(screen.getByText('Acme Bank')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /New organization/i }));
    // The picker labels itself and offers the twin's social account as an option.
    await waitFor(() => expect(screen.getByText(/Linked social account/i)).toBeInTheDocument());
    expect(screen.getByText(/github · @octocat \(The Octocat\)/)).toBeInTheDocument();
  });

  it('renders the Changes tab with a declared change and its progress', async () => {
    renderAt('/privacy/changes');
    // Masked old → new values render; the change kind badge shows.
    await waitFor(() => expect(screen.getByText('•••, Portland OR')).toBeInTheDocument());
    expect(screen.getByText('•••, Seattle WA')).toBeInTheDocument();
    expect(screen.getByText('Address change')).toBeInTheDocument();
    expect(screen.getByText(/handled/i)).toBeInTheDocument();
  });

  it('stale :tab param falls back to Overview', async () => {
    renderAt('/privacy/bogus');
    await waitFor(() => expect(screen.getByText(/system of record/i)).toBeInTheDocument());
  });

  // ── Household subjects (#3658) ────────────────────────────────────────────
  describe('household subjects', () => {
    it('defaults the scope to self and lists the household in the switcher', async () => {
      renderAt('/privacy/vault');
      await waitFor(() => expect(screen.getByText('Home address')).toBeInTheDocument());
      const select = await screen.findByLabelText('Subject');
      expect(select).toHaveValue(SELF_ID);
      expect(screen.getByRole('option', { name: /Alex · Partner/ })).toBeInTheDocument();
      expect(getVaultRecords).toHaveBeenCalledWith(undefined, { subjectId: SELF_ID });
    });

    it('scopes every read to the subject named in the URL', async () => {
      renderAt('/privacy/vault?subject=sub-2');
      await waitFor(() => expect(getVaultRecords).toHaveBeenCalledWith(undefined, { subjectId: 'sub-2' }));
      expect(getPrivacyStatus).toHaveBeenCalledWith({ subjectId: 'sub-2' });
    });

    it('flags when the view is scoped to someone other than self', async () => {
      renderAt('/privacy/vault?subject=sub-2');
      await waitFor(() => expect(screen.getByText(/not your own/i)).toBeInTheDocument());
      expect(screen.getByText(/Viewing Alex/)).toBeInTheDocument();
    });

    it('switching subjects refetches under the new scope and lands in the URL', async () => {
      renderAt('/privacy/vault');
      await waitFor(() => screen.getByLabelText('Subject'));
      fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'sub-2' } });
      await waitFor(() => expect(getVaultRecords).toHaveBeenCalledWith(undefined, { subjectId: 'sub-2' }));
      expect(screen.getByLabelText('Subject')).toHaveValue('sub-2');
    });

    it('flags a non-self scope immediately, before the subject list resolves', async () => {
      // The tabs fetch on subjectId right away, so a bar that waits for the
      // subject list to decide "is this me?" shows someone else's PII under
      // self styling for the whole load window.
      let resolveSubjects;
      getPrivacySubjects.mockReturnValueOnce(new Promise((r) => { resolveSubjects = r; }));
      renderAt('/privacy/vault?subject=sub-2');
      await waitFor(() => expect(screen.getByText(/not your own/i)).toBeInTheDocument());
      // Settle the deferred fetch inside act so the late state update lands here.
      await act(async () => { resolveSubjects([]); });
    });

    it('flags an unresolvable subject rather than treating it as self', async () => {
      renderAt('/privacy/vault?subject=deleted-subject');
      await waitFor(() => expect(screen.getByText(/not your own/i)).toBeInTheDocument());
    });

    it('keeps a stale ?subject deep link labeled rather than blank', async () => {
      renderAt('/privacy/vault?subject=deleted-subject');
      const select = await screen.findByLabelText('Subject');
      await waitFor(() => expect(select).toHaveValue('deleted-subject'));
      expect(screen.getByRole('option', { name: 'Unknown subject' })).toBeInTheDocument();
    });
  });
});
