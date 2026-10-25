import { describe, it, expect } from 'vitest';
import { hasRetirementReceipt, sameRetirementCheckout } from './reconcileRetirementEvidence.js';

const HEAD = 'a'.repeat(40);
const retiredAt = '2026-01-02T00:00:00.000Z';
const row = { path: '/example/tree', head: HEAD, checkoutIdentity: 'identity-1', createdAt: '2026-01-01T00:00:00.000Z' };

describe('checkout-only retirement receipts', () => {
  const outcome = receipt => ({ retired: [{ path: row.path, head: HEAD, archiveDir: null, retiredAt, checkoutIdentity: 'identity-1', ...receipt }] });

  it('settles only a branchless checkout, and only its exact incarnation', () => {
    const receipt = { branchDeleted: false, checkoutOnly: true };
    expect(hasRetirementReceipt(outcome(receipt), row)).toBe(true);
    expect(hasRetirementReceipt(outcome(receipt), { ...row, checkoutIdentity: 'identity-2' })).toBe(false);
  });

  it('never settles a branch-bearing row or counts as a branch deletion', () => {
    expect(hasRetirementReceipt(outcome({ branchDeleted: false, checkoutOnly: true }), { ...row, branch: 'feature/x' })).toBe(false);
    expect(hasRetirementReceipt(outcome({ branchDeleted: false, checkoutOnly: true, branch: 'feature/x' }), { ...row, branch: 'feature/x' })).toBe(false);
    expect(hasRetirementReceipt(outcome({ branchDeleted: false }), row)).toBe(false);
  });

  it('treats an absent and a null branch as the same detached observation', () => {
    expect(sameRetirementCheckout({ path: row.path, head: HEAD }, { path: row.path, head: HEAD, branch: null })).toBe(true);
  });
});
