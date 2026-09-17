/**
 * Manual "Run Now" outcome copy (#7529).
 *
 * The regression these pin: a fire whose run-history write failed still returns
 * `status: 'started'`, and both commission pages used to toast an unconditional
 * "its render appears below" for it. The gallery is derived from PERSISTED run
 * ids, so that promise was false — nothing ever appeared, and the only surviving
 * route to the work was the Creative Director project the user was never shown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// vi.mock is hoisted above every const in this file, so the callable-toast
// double is built inside the factory and read back through the import.
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

import toastMock from '../ui/Toast';
import { toastRunOutcome } from './runOutcomeToast.jsx';

// The warning toast is a render prop — render what it handed the toast stack.
const renderWarningToast = () => {
  expect(toastMock).toHaveBeenCalledTimes(1);
  const [content, opts] = toastMock.mock.calls[0];
  render(<MemoryRouter>{content({ id: 'toast-1' })}</MemoryRouter>);
  return opts;
};

describe('toastRunOutcome', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('replaces the gallery-success promise with a warning and a project link when history was lost', () => {
    toastRunOutcome({
      status: 'started',
      projectId: 'cd-9',
      historyWarning: { code: 'run-history-unavailable', outcome: 'started', projectId: 'cd-9' },
    }, 'Run started — its render appears below once generation finishes');

    // The false promise is gone, not merely accompanied by a warning.
    expect(toastMock.success).not.toHaveBeenCalled();
    const opts = renderWarningToast();
    // A collapsible toast must name itself for the corner pill (a11y contract).
    expect(opts.label).toBeTruthy();
    expect(screen.getByText(/could not be written to the commission/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open the project/i })).toHaveAttribute('href', '/creative-director/cd-9');
  });

  it('falls back to the outcome-level project id when the warning carries none', () => {
    toastRunOutcome({
      status: 'started',
      projectId: 'cd-fallback',
      historyWarning: { code: 'run-history-unavailable', outcome: 'started', projectId: null },
    }, 'ignored');
    renderWarningToast();
    expect(screen.getByRole('link', { name: /open the project/i })).toHaveAttribute('href', '/creative-director/cd-fallback');
  });

  it('warns without a link when no project was ever minted (a lost skip row)', () => {
    toastRunOutcome({
      status: 'skipped',
      reason: 'autonomy-off',
      historyWarning: { code: 'run-history-unavailable', outcome: 'skipped', projectId: null },
    }, 'ignored');
    renderWarningToast();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText(/this run was skipped, but the outcome could not be written/i)).toBeInTheDocument();
    // The skip REASON is independent of the lost ledger — it must survive.
    expect(toastMock.error).toHaveBeenCalledWith('Run skipped: autonomy-off');
  });

  it('keeps the normal success copy when history persisted', () => {
    toastRunOutcome({ status: 'started', projectId: 'cd-1', run: { id: 'run-1' } }, 'Run started — all good');
    expect(toastMock.success).toHaveBeenCalledWith('Run started — all good');
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('reports a skip reason and a failure error unchanged', () => {
    toastRunOutcome({ status: 'skipped', reason: 'budget' }, 'unused');
    expect(toastMock.error).toHaveBeenCalledWith('Run skipped: budget');
    toastRunOutcome({ status: 'failed', error: 'planner exploded' }, 'unused');
    expect(toastMock.error).toHaveBeenCalledWith('Run failed: planner exploded');
  });
});
