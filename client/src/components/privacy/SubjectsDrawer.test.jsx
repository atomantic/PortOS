import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Household subjects drawer (#3658). Consent is captured at creation because the
// engine refuses to scan/opt-out for a subject with no consent row.
vi.mock('../../services/api', () => ({
  createPrivacySubject: vi.fn(),
  deletePrivacySubject: vi.fn(),
  getPrivacySubjectConsents: vi.fn(),
  grantPrivacySubjectConsent: vi.fn(),
  revokePrivacySubjectConsent: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import SubjectsDrawer from './SubjectsDrawer';
import {
  createPrivacySubject, deletePrivacySubject, getPrivacySubjectConsents,
  grantPrivacySubjectConsent, revokePrivacySubjectConsent,
} from '../../services/api';
import { SELF_SUBJECT_ID } from './constants';

const SUBJECTS = [
  { id: SELF_SUBJECT_ID, displayName: 'Me', relationship: 'self', isSelf: true, consentCount: 2, recordCount: 3, activeScopes: ['broker_scan', 'pii_vault'] },
  { id: 'sub-2', displayName: 'Alex', relationship: 'partner', isSelf: false, consentCount: 1, recordCount: 1, activeScopes: ['pii_vault'] },
];

function renderDrawer(props = {}) {
  return render(
    <SubjectsDrawer
      open
      subjects={SUBJECTS}
      onClose={vi.fn()}
      onCreated={vi.fn()}
      onDeleted={vi.fn()}
      {...props}
    />,
  );
}

describe('SubjectsDrawer', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists household members with their relationship', () => {
    renderDrawer();
    expect(screen.getByText('Me')).toBeInTheDocument();
    expect(screen.getByText('Alex')).toBeInTheDocument();
    expect(screen.getByText('Partner')).toBeInTheDocument();
  });

  it('never offers to delete the self subject', () => {
    renderDrawer();
    expect(screen.queryByLabelText('Remove Me')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Remove Alex')).toBeInTheDocument();
  });

  it('creates a member with the captured consent method', async () => {
    createPrivacySubject.mockResolvedValue({ id: 'sub-3', displayName: 'Sam', relationship: 'child' });
    const onCreated = vi.fn();
    renderDrawer({ onCreated });

    fireEvent.click(screen.getByRole('button', { name: /Add household member/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sam' } });
    fireEvent.change(screen.getByLabelText(/Relationship/i), { target: { value: 'child' } });
    fireEvent.change(screen.getByLabelText(/Consent captured via/i), { target: { value: 'guardian' } });
    fireEvent.click(screen.getByRole('button', { name: /^Add member$/i }));

    await waitFor(() => expect(createPrivacySubject).toHaveBeenCalledWith(
      { displayName: 'Sam', relationship: 'child', consentMethod: 'guardian' },
      { silent: true },
    ));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-3' }));
  });

  it('warns when a member has no consent on record', async () => {
    getPrivacySubjectConsents.mockResolvedValue([]);
    renderDrawer();
    fireEvent.click(screen.getAllByRole('button', { name: /Consent record/i })[1]);
    await waitFor(() => expect(screen.getByText(/scans and opt-outs are refused/i)).toBeInTheDocument());
  });

  it('retries a failed consent read when the row is collapsed and reopened', async () => {
    getPrivacySubjectConsents.mockRejectedValueOnce(new Error('network'));
    renderDrawer();
    const trigger = screen.getAllByRole('button', { name: /Consent record/i })[1];

    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText(/Couldn’t load the consent record/i)).toBeInTheDocument());

    // Collapse + reopen must re-fetch, not stay stuck on the failure forever.
    getPrivacySubjectConsents.mockResolvedValueOnce([
      { id: 'c-1', subjectId: 'sub-2', scope: 'pii_vault', method: 'verbal', note: '', grantedAt: null },
    ]);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText(/Verbal/)).toBeInTheDocument());
    expect(getPrivacySubjectConsents).toHaveBeenCalledTimes(2);
  });

  it('warns that deleting a member cascades their records', async () => {
    deletePrivacySubject.mockResolvedValue({ ok: true });
    const onDeleted = vi.fn();
    renderDrawer({ onDeleted });

    fireEvent.click(screen.getByLabelText('Remove Alex'));
    expect(screen.getByText(/vault records, organizations, changes, and broker cases are deleted too/i))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deletePrivacySubject).toHaveBeenCalledWith('sub-2', { silent: true }));
    expect(onDeleted).toHaveBeenCalledWith('sub-2');
  });

  // ── Purpose-scoped broker consent (#8332) ──
  it('grants a broker purpose only after a confirm that names the external disclosure', async () => {
    grantPrivacySubjectConsent.mockResolvedValue({ id: 'c-9', scope: 'broker_optout' });
    const onConsentChanged = vi.fn();
    renderDrawer({ onConsentChanged });

    fireEvent.click(screen.getByLabelText('Grant broker opt-out requests for Alex'));
    expect(grantPrivacySubjectConsent).not.toHaveBeenCalled();
    expect(screen.getByText(/sends their data to external data brokers/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Consent captured via/i), { target: { value: 'written' } });
    fireEvent.click(screen.getByRole('button', { name: 'Grant' }));

    await waitFor(() => expect(grantPrivacySubjectConsent).toHaveBeenCalledWith(
      'sub-2', { scope: 'broker_optout', method: 'written' }, { silent: true },
    ));
    expect(onConsentChanged).toHaveBeenCalledWith('sub-2', 'broker_optout', true);
  });

  it('revokes a broker purpose without removing the person', async () => {
    revokePrivacySubjectConsent.mockResolvedValue({ subjectId: SELF_SUBJECT_ID, scope: 'broker_scan', revoked: 1 });
    const onConsentChanged = vi.fn();
    renderDrawer({ onConsentChanged });

    fireEvent.click(screen.getByLabelText('Revoke broker exposure scan for Me'));
    await waitFor(() => expect(revokePrivacySubjectConsent).toHaveBeenCalledWith(SELF_SUBJECT_ID, 'broker_scan', { silent: true }));
    expect(onConsentChanged).toHaveBeenCalledWith(SELF_SUBJECT_ID, 'broker_scan', false);
    expect(deletePrivacySubject).not.toHaveBeenCalled();
  });

  it('shows revocation timestamps in the consent record', async () => {
    getPrivacySubjectConsents.mockResolvedValue([
      { id: 'c-2', subjectId: 'sub-2', scope: 'broker_scan', method: 'written', note: '', grantedAt: '2026-01-01T00:00:00Z', revokedAt: '2026-02-01T00:00:00Z' },
    ]);
    renderDrawer();
    fireEvent.click(screen.getAllByRole('button', { name: /Consent record/i })[1]);
    await waitFor(() => expect(screen.getByText(/revoked/)).toBeInTheDocument());
  });
});
