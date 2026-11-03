import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import HarnessUpdateControl from './HarnessUpdateControl';
import { getHarnessUpdateReference } from '../../services/api';

vi.mock('../../services/api', () => ({ getHarnessUpdateReference: vi.fn() }));

const harness = { id: 'example', label: 'Example CLI', installedVersion: '1.2.3', candidateVersion: '1.2.4' };
const ticket = '00000000-0000-4000-8000-000000000001';
const reference = () => ({ state: 'available', package: '@example/agent', installedVersion: '1.2.3', candidateVersion: '1.2.4',
  ticket,
  checkedAt: new Date(Date.now() - 60000).toISOString(),
  release: { state: 'verified', publishedAt: new Date(Date.now() - 60_000).toISOString() },
  installed: { state: 'checked', items: [{ id: 'GHSA-2345-6789-cfgh', cve: 'CVE-2026-12345', severity: 'high', url: 'https://github.com/advisories/GHSA-2345-6789-cfgh' }] },
  candidate: { state: 'checked', items: [] }, fixed: ['GHSA-2345-6789-cfgh'] });

beforeEach(() => { vi.clearAllMocks(); getHarnessUpdateReference.mockResolvedValue(reference()); });

describe('inline harness update review', () => {
  it('shows sourced, separate current and target evidence and asks before overriding a recent-release warning', async () => {
    const update = vi.fn();
    const changeWarning = vi.fn();
    render(<HarnessUpdateControl harness={harness} warningDays={3} onWarningDays={changeWarning} onUpdate={update} />);
    expect(await screen.findByText(/npm reference: @example\/agent 1.2.4/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CVE-2026-12345' })).toHaveAttribute('href', 'https://github.com/advisories/GHSA-2345-6789-cfgh');
    expect(screen.getByText(/GitHub identifies the npm candidate as the first patched version/)).toBeInTheDocument();
    expect(screen.getByText(/npm candidate 1.2.4: no matching/)).toBeInTheDocument();
    expect(screen.getByText(/Reference last checked/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Recent release warning for Example CLI'), { target: { value: '7' } });
    expect(changeWarning).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByRole('button', { name: 'Update Example CLI' }));
    expect(screen.getByText(/published less than 3 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/Agents already running keep the version they started with/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Update now for urgent security' }));
    expect(update).toHaveBeenCalledWith({ ...harness, ticket });
  });

  it('distinguishes unavailable evidence from a clean advisory query', async () => {
    getHarnessUpdateReference.mockResolvedValue({ state: 'unknown', ticket });
    render(<HarnessUpdateControl harness={harness} warningDays={3} onWarningDays={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText(/could not be verified/)).toBeInTheDocument();
    expect(screen.queryByText(/no matching GitHub-reviewed/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update Example CLI' }));
    expect(screen.getByText(/release age is unknown/)).toBeInTheDocument();
  });

  it('does not allow an update from a superseded reference', async () => {
    getHarnessUpdateReference.mockResolvedValue({ state: 'changed' });
    render(<HarnessUpdateControl harness={harness} warningDays={0} onWarningDays={vi.fn()} onUpdate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update Example CLI' })).toBeDisabled());
    expect(screen.getByText(/refresh the update card/)).toBeInTheDocument();
  });

  it('explains when the current session lacks host control', async () => {
    getHarnessUpdateReference.mockRejectedValue(Object.assign(new Error('Forbidden'), { code: 'HOST_CONTROL_FORBIDDEN' }));
    render(<HarnessUpdateControl harness={harness} warningDays={0} onWarningDays={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText(/Host control is required/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Example CLI' })).toBeDisabled();
  });

  it('explains when protected inline updates are unsupported', async () => {
    getHarnessUpdateReference.mockResolvedValue({ state: 'unknown', ticket: null, unsupported: true });
    render(<HarnessUpdateControl harness={harness} warningDays={0} onWarningDays={vi.fn()} onUpdate={vi.fn()} />);
    expect(await screen.findByText(/Protected inline updates are not available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update Example CLI' })).toBeDisabled();
  });

  it('rechecks a consumed ticket after an attempt and permits explicit refresh of an expired ticket', async () => {
    const update = vi.fn();
    const { rerender } = render(<HarnessUpdateControl harness={harness} warningDays={0} onWarningDays={vi.fn()} onUpdate={update} />);
    await screen.findByRole('button', { name: 'Recheck update' });
    fireEvent.click(screen.getByRole('button', { name: 'Recheck update' }));
    await waitFor(() => expect(getHarnessUpdateReference).toHaveBeenCalledTimes(2));
    rerender(<HarnessUpdateControl harness={harness} warningDays={0} onWarningDays={vi.fn()} onUpdate={update} disabled />);
    rerender(<HarnessUpdateControl harness={harness} warningDays={0} onWarningDays={vi.fn()} onUpdate={update} disabled={false} />);
    await waitFor(() => expect(getHarnessUpdateReference).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('button', { name: 'Update Example CLI' })).toBeEnabled();
  });
});
