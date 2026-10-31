import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const retire = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/api', () => ({ retireBranchReconcileCheckout: retire, reviewBranchReconcileCheckout: prepare, refreshBranchReconcileInventory: refresh }));

import BranchReconcileOutcome from './BranchReconcileOutcome';

const held = {
  path: '/example/held', branch: 'fix/example', head: 'a'.repeat(40), locked: true, lockReason: 'owner handoff',
  managed: false, reason: 'worktree-locked',
};
const outcomes = { 'app-1': { status: 'incomplete', observedAt: '2026-10-01T00:00:00Z', remaining: [held, { branch: 'other', reason: 'actionable' }] } };

function open() {
  const view = render(<BranchReconcileOutcome outcomes={outcomes} apps={[{ id: 'app-1', name: 'Example App' }]} />);
  fireEvent.click(screen.getByText(/Example App · Incomplete · 2 remaining/));
  fireEvent.click(screen.getByRole('button', { name: 'Retire checkout…' }));
  return view;
}

describe('BranchReconcileOutcome checkout retirement', () => {
  beforeEach(() => { retire.mockReset(); prepare.mockReset(); refresh.mockReset(); });

  it('presents checkout retirement as a visible action before asking for confirmation', () => {
    render(<BranchReconcileOutcome outcomes={outcomes} apps={[{ id: 'app-1', name: 'Example App' }]} />);
    fireEvent.click(screen.getByText(/Example App · Incomplete · 2 remaining/));
    const button = screen.getByRole('button', { name: 'Retire checkout…' });
    expect(button).toHaveClass('rounded', 'border', 'border-port-border');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Yes, retire checkout' })).toBeVisible();
    expect(retire).not.toHaveBeenCalled();
  });

  it('shows peer remote inventory separately from drained local work without offering retirement', () => {
    render(<BranchReconcileOutcome outcomes={{ 'app-1': { status: 'drained', remaining: [], remoteInventory: {
      reported: [{ branch: 'feature/peer-only', reason: 'unmerged-remote-only' }],
    } } }} apps={[{ id: 'app-1', name: 'Example App' }]} />);
    expect(screen.getByText(/Example App · No remaining work in last scan · 0 remaining/)).toBeInTheDocument();
    expect(screen.getByText('Remote-only inventory · 1 informational')).toBeInTheDocument();
    expect(screen.getByText('feature/peer-only: unmerged-remote-only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retire checkout/ })).toBeNull();
    expect(retire).not.toHaveBeenCalled();
  });

  it('sends the exact inventory row as the scoped release and hides the row until a fresh inventory arrives', async () => {
    let finishRetirement;
    retire.mockImplementation(() => new Promise(resolve => { finishRetirement = resolve; }));
    const { rerender } = open();
    expect(screen.getByText(/Retire this exact merged, clean checkout and its lock\?/)).toHaveTextContent('No checkout archive is created. Dirty checkouts and checkouts with unique unverified ignored files stay in place.');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, retire checkout' }));
    expect(screen.getByRole('button', { name: 'Retiring…' })).toBeDisabled();
    await act(async () => finishRetirement({ ok: true, branchDeleted: true }));

    await waitFor(() => expect(screen.queryByText('/example/held')).toBeNull());
    expect(retire).toHaveBeenCalledWith({
      appId: 'app-1', path: held.path, head: held.head, branch: held.branch, locked: true, lockReason: 'owner handoff',
    }, { silent: true });
    expect(screen.getByText(/Example App · Incomplete · 1 remaining/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retire checkout…' })).toBeNull();

    // A checkout recreated at the same path is new evidence, not the retired row.
    rerender(<BranchReconcileOutcome outcomes={{ ...outcomes }} apps={[{ id: 'app-1', name: 'Example App' }]} />);
    expect(screen.getByText('/example/held')).toBeVisible();
  });

  it('keeps the row and shows why the server kept the checkout', async () => {
    retire.mockRejectedValue(new Error('Checkout kept: checkout-lock-changed'));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, retire checkout' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Checkout kept: checkout-lock-changed');
    expect(screen.getByText('/example/held')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retire checkout…' })).toBeVisible();
  });

  it('keeps confirmation disabled when preparation returns no review', async () => {
    prepare.mockResolvedValue({ ok: true, review: null });
    render(<BranchReconcileOutcome outcomes={{ 'app-1': { status: 'incomplete', remaining: [{ ...held, reason: 'pr-completion-review-required' }] } }} apps={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retire checkout…' }));
    fireEvent.change(screen.getByLabelText('Merged pull request URL'), { target: { value: 'https://github.com/example/repo/pull/42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review merged work' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review merged work' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Yes, retire checkout' })).toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Retire checkout…' }));
    expect(screen.getByRole('button', { name: 'Yes, retire checkout' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Merged pull request URL'), { target: { value: review.forge.prUrl } });
    fireEvent.click(screen.getByRole('button', { name: 'Review merged work' }));
    expect(screen.getByRole('button', { name: 'Preparing comparison…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Yes, retire checkout' })).toBeDisabled();
    resolveReview({ ok: true, review });
    expect(await screen.findByText('strengthened replacement')).toBeInTheDocument();
    expect(retire).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes, retire checkout' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, retire checkout' }));
    await waitFor(() => expect(retire).toHaveBeenCalledWith(expect.objectContaining({
      review: { prUrl: review.forge.prUrl, digest: review.digest, acceptSuperseded: true },
    }), { silent: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('retirement-review-changed');
    rerender(<BranchReconcileOutcome {...props} outcomes={{ 'app-1': { status: 'incomplete', remaining: [{ ...legacy, head: 'c'.repeat(40) }] } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retire checkout…' }));
    expect(screen.queryByText('strengthened replacement')).toBeNull();
    expect(screen.getByRole('button', { name: 'Yes, retire checkout' })).toBeDisabled();
  });
});

it('separates missing historical checkouts from current work without offering retirement or claiming completion', () => {
  render(<BranchReconcileOutcome outcomes={{ 'app-1': { status: 'incomplete', remaining: [{ ...held, checkoutMissing: true, reason: 'retirement-receipt-unverified' }] } }} apps={[{ id: 'app-1', name: 'Example App' }]} />);
  expect(screen.getByText(/Example App · Incomplete · 0 remaining · 1 unresolved missing checkouts/)).toBeTruthy();
  expect(screen.getByText('Missing checkouts · 1 unresolved')).toBeTruthy();
  expect(screen.getByText(/until retirement evidence explains it/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retire checkout…' })).toBeNull();
});

it('refreshes one app immediately, excludes legacy remote holds, and restores authoritative props on the next event', async () => {
  let finish;
  refresh.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const stale = { 'app-1': { status: 'incomplete', remaining: [held, { branch: 'peer-only', reason: 'remote-branch-held' }] } };
  const { rerender } = render(<BranchReconcileOutcome outcomes={stale} apps={[]} />);
  fireEvent.click(screen.getByText(/app-1 · Incomplete · 1 remaining/));
  expect(screen.getByText('Remote-only inventory · 1 informational')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  expect(screen.getByRole('button', { name: 'Refreshing inventory…' })).toBeDisabled();
  finish({ appId: 'app-1', outcome: { status: 'drained', remaining: [], observedAt: '2026-10-02T00:00:00Z' } });
  expect(await screen.findByText(/app-1 · No remaining work in last scan · 0 remaining/)).toBeVisible();
  expect(screen.queryByText('/example/held')).toBeNull();
  expect(refresh).toHaveBeenCalledWith('app-1', { silent: true });
  rerender(<BranchReconcileOutcome outcomes={{ ...stale }} apps={[]} />);
  expect(screen.getByText('/example/held')).toBeVisible();
});

it('keeps the previous inventory and permits retry when a refresh fails', async () => {
  refresh.mockRejectedValue(new Error('Repository scan unavailable'));
  render(<BranchReconcileOutcome outcomes={outcomes} apps={[]} />);
  fireEvent.click(screen.getByText(/app-1 · Incomplete/));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inventory' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Repository scan unavailable');
  expect(screen.getByText('/example/held')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Refresh inventory' })).toBeEnabled();
});

it('ignores a late refresh from an older schedule generation without discarding another app’s new result', async () => {
  let finishOld;
  let finishNew;
  refresh.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
  const source = { ...outcomes, 'app-2': outcomes['app-1'] };
  const { rerender } = render(<BranchReconcileOutcome outcomes={source} apps={[]} />);
  fireEvent.click(within(screen.getByText(/app-1 · Incomplete/).closest('details')).getByRole('button', { name: 'Refresh inventory', hidden: true }));
  rerender(<BranchReconcileOutcome outcomes={{ ...source }} apps={[]} />);
  fireEvent.click(within(screen.getByText(/app-2 · Incomplete/).closest('details')).getByRole('button', { name: 'Refresh inventory', hidden: true }));
  await act(async () => finishNew({ appId: 'app-2', outcome: { status: 'drained', remaining: [] } }));
  expect(screen.getByText(/app-2 · No remaining work in last scan/)).toBeInTheDocument();
  await act(async () => finishOld({ appId: 'app-1', outcome: { status: 'drained', remaining: [] } }));
  expect(screen.getByText(/app-2 · No remaining work in last scan/)).toBeInTheDocument();
  expect(screen.getByText(/app-1 · Incomplete · 2 remaining/)).toBeInTheDocument();
});
