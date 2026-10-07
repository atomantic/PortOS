import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import AuditSourceEvidence from './AuditSourceEvidence';
afterEach(cleanup);
it('distinguishes committed source context from claimed coverage and shows dirty state', () => {
  render(<AuditSourceEvidence evidence={{ status: 'captured', revision: 'a'.repeat(40), inventorySha256: 'b'.repeat(64), trackedEntryCount: 42, workingTreeState: 'modified', capturedAt: '2026-01-01T00:00:00Z' }} />);
  expect(screen.getByText(/Committed inventory: 42 entries/)).toBeTruthy();
  expect(screen.getByText(/Workspace observed at capture: modified/)).toBeTruthy();
  expect(screen.getByText(/not reviewed-file coverage/)).toBeTruthy();
  expect(screen.getByText(/assessment scan counts remain model-reported/)).toBeTruthy();
});
it('does not invent historical provenance or interpret unavailable evidence as zero coverage', () => {
  const { container, rerender } = render(<AuditSourceEvidence />);
  expect(container.textContent).toBe('');
  rerender(<AuditSourceEvidence evidence={{ status: 'unavailable' }} />);
  expect(screen.getByText('Audit source provenance unavailable.')).toBeTruthy();
  expect(container.textContent).not.toContain('0 entries');
});
