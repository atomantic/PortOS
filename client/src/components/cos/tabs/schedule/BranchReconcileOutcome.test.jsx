import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const retire = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/api', () => ({ retireBranchReconcileCheckout: retire }));

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
  beforeEach(() => { retire.mockReset(); });

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
});
