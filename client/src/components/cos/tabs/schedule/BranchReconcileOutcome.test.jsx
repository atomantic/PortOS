import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const retire = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/api', () => ({ retireBranchReconcileCheckout: retire, reviewBranchReconcileCheckout: prepare }));

import BranchReconcileOutcome from './BranchReconcileOutcome';

const held = {
  path: '/example/held', branch: 'fix/example', head: 'a'.repeat(40), locked: true, lockReason: 'owner handoff',
  managed: false, reason: 'worktree-locked',
};
const outcomes = { 'app-1': { status: 'incomplete', observedAt: '2026-10-01T00:00:00Z', remaining: [held, { branch: 'other', reason: 'actionable' }] } };

function open() {
  const view = render(<BranchReconcileOutcome outcomes={outcomes} apps={[{ id: 'app-1', name: 'Example App' }]} />);
  fireEvent.click(screen.getByText(/Example App · Incomplete · 2 remaining/));
  fireEvent.click(screen.getByRole('button', { name: 'Archive and retire checkout…' }));
  return view;
}

describe('BranchReconcileOutcome checkout retirement', () => {
  beforeEach(() => { retire.mockReset(); prepare.mockReset(); });

  it('shows peer remote inventory separately from drained local work without offering retirement', () => {
    render(<BranchReconcileOutcome outcomes={{ 'app-1': { status: 'drained', remaining: [], remoteInventory: {
      reported: [{ branch: 'feature/peer-only', reason: 'unmerged-remote-only' }],
    } } }} apps={[{ id: 'app-1', name: 'Example App' }]} />);
    expect(screen.getByText(/Example App · No remaining work in last scan · 0 remaining/)).toBeInTheDocument();
    expect(screen.getByText('Remote-only inventory · 1 informational')).toBeInTheDocument();
    expect(screen.getByText('feature/peer-only: unmerged-remote-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Archive and retire/ })).toBeNull();
    expect(retire).not.toHaveBeenCalled();
  });

  it('sends the exact inventory row as the scoped release and hides the row until a fresh inventory arrives', async () => {
    retire.mockResolvedValue({ ok: true, archiveDir: '/example/archive', branchDeleted: true });
    const { rerender } = open();
    expect(screen.getByText(/Release this exact checkout and its lock\?/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, archive and retire' }));

    await waitFor(() => expect(screen.queryByText('/example/held')).toBeNull());
    expect(retire).toHaveBeenCalledWith({
      appId: 'app-1', path: held.path, head: held.head, branch: held.branch, locked: true, lockReason: 'owner handoff',
    }, { silent: true });
    expect(screen.getByText(/Example App · Incomplete · 1 remaining/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Archive and retire checkout…' })).toBeNull();

    // A checkout recreated at the same path is new evidence, not the retired row.
    rerender(<BranchReconcileOutcome outcomes={{ ...outcomes }} apps={[{ id: 'app-1', name: 'Example App' }]} />);
    expect(screen.getByText('/example/held')).toBeVisible();
  });

  it('keeps the row and shows why the server kept the checkout', async () => {
    retire.mockRejectedValue(new Error('Checkout kept: checkout-lock-changed'));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, archive and retire' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Checkout kept: checkout-lock-changed');
    expect(screen.getByText('/example/held')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Archive and retire checkout…' })).toBeVisible();
  });

  it('keeps confirmation disabled when preparation returns no review', async () => {
    prepare.mockResolvedValue({ ok: true, review: null });
    render(<BranchReconcileOutcome outcomes={{ 'app-1': { status: 'incomplete', remaining: [{ ...held, reason: 'pr-completion-review-required' }] } }} apps={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive and retire checkout…' }));
    fireEvent.change(screen.getByLabelText('Merged pull request URL'), { target: { value: 'https://github.com/example/repo/pull/42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review merged work' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review merged work' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Yes, archive and retire' })).toBeDisabled();
    expect(retire).not.toHaveBeenCalled();
  });

  it('requires review and explicit supersession acceptance, discarding review when the inventory changes', async () => {
    const legacy = { ...held, reason: 'pr-completion-review-required' };
    const review = { digest: 'd'.repeat(64), forge: { prUrl: 'https://github.com/example/repo/pull/42', defaultBranch: 'main', defaultHead: 'b'.repeat(40) },
      comparison: { localPatch: 'original change', difference: 'strengthened replacement', disposition: 'review-supersession' } };
    let resolveReview;
    prepare.mockImplementation(() => new Promise(resolve => { resolveReview = resolve; }));
    retire.mockRejectedValue(new Error('Checkout kept: retirement-review-changed'));
    const props = { outcomes: { 'app-1': { status: 'incomplete', remaining: [legacy] } }, apps: [] };
    const { rerender } = render(<BranchReconcileOutcome {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive and retire checkout…' }));
    expect(screen.getByRole('button', { name: 'Yes, archive and retire' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Merged pull request URL'), { target: { value: review.forge.prUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Review merged work' }));
    expect(screen.getByRole('button', { name: 'Preparing comparison…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Yes, archive and retire' })).toBeDisabled();
    resolveReview({ ok: true, review });
    expect(await screen.findByText('strengthened replacement')).toBeInTheDocument();
    expect(retire).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes, archive and retire' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, archive and retire' }));
    await waitFor(() => expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      review: { prUrl: review.forge.prUrl, digest: review.digest, acceptSuperseded: true },
    }), { silent: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('retirement-review-changed');
    rerender(<BranchReconcileOutcome {...props} outcomes={{ 'app-1': { status: 'incomplete', remaining: [{ ...legacy, head: 'c'.repeat(40) }] } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Archive and retire checkout…' }));
    expect(screen.queryByText('strengthened replacement')).toBeNull();
    expect(screen.getByRole('button', { name: 'Yes, archive and retire' })).toBeDisabled();
  });
});

 it('explains missing historical checkouts without offering retirement or claiming completion', () => {
  render(<BranchReconcileOutcome outcomes={{ 'app-1': { status: 'incomplete', remaining: [{ ...held, checkoutMissing: true, reason: 'retirement-receipt-unverified' }] } }} apps={[{ id: 'app-1', name: 'Example App' }]} />);
  expect(screen.getByText(/Example App · Incomplete · 1 remaining · missing checkout evidence/)).toBeTruthy();
  expect(screen.getByText(/historical preservation obligation, not an extra worktree/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Archive and retire checkout…' })).toBeNull();
});
