import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import AppLaneHealth from './AppLaneHealth';
import { getAppLaneHealth } from '../../services/apiApps';
vi.mock('../../services/apiApps', () => ({ getAppLaneHealth: vi.fn() }));

const lane = (overrides) => ({ id: 'x', label: 'X', metricLabel: 'x', filed: 0, completed: 0, notPlanned: 0, open: 0, reverted: 0, refiled: 0, flagged: [], flaggedTotal: 0, ...overrides });

it('lists lanes with filed issues noisiest first, names the flagged findings, and warns about a shortened or partial read', async () => {
  getAppLaneHealth.mockResolvedValueOnce({
    available: true, windowDays: 60, refileDays: 30, from: '2026-09-20T00:00:00.000Z', to: '2026-10-17T00:00:00.000Z', truncated: true, partial: ['commits'],
    lanes: [
      lane({ id: 'security', label: 'Security', filed: 3, completed: 3 }),
      lane({ id: 'better-complexity', label: 'Cyclomatic complexity', filed: 12, completed: 9, notPlanned: 2, reverted: 1, refiled: 1, flaggedTotal: 11, flagged: [
        { number: 31, title: 'Dispatcher branches on every provider', url: 'https://example.com/31', reasons: [{ kind: 're-filed', of: 20, path: 'server/x.js' }] },
        { number: 28, title: 'Hotspot', url: null, reasons: [{ kind: 'reverted', pullRequest: 90 }, { kind: 'not-planned', stateReason: 'duplicate' }] },
      ] }),
      lane({ id: 'ux', label: 'UX' }),
    ],
  });
  render(<AppLaneHealth appId="portos-default" />);
  const table = await screen.findByRole('table', { name: 'Audit lane outcomes' });
  expect(getAppLaneHealth).toHaveBeenCalledWith('portos-default');
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual(['Cyclomatic complexity', 'Security']);
  expect(within(rows[0]).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['12', '9', '2', '1', '1']);
  expect(screen.getByText(/counts cover issues filed since/)).toHaveTextContent(/commits could not be read/);
  fireEvent.click(screen.getByRole('button', { name: 'Cyclomatic complexity findings that were rejected, reverted or repeated' }));
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip).toHaveTextContent('#31 Dispatcher branches on every provider · re-filed after #20');
  expect(tooltip).toHaveTextContent('#28 Hotspot · reverted (PR #90); duplicate');
  expect(tooltip).toHaveTextContent('9 more not shown');
  expect(within(tooltip).getByRole('link', { name: '#31' })).toHaveAttribute('href', 'https://example.com/31');
});

it('explains an app without a tracker, reports a failed load, and retries on refresh', async () => {
  getAppLaneHealth.mockResolvedValueOnce({ available: false, reason: 'forge-unavailable' });
  render(<AppLaneHealth appId="app-2" />);
  expect(await screen.findByText(/no GitHub or GitLab tracker/)).toBeInTheDocument();
  getAppLaneHealth.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh lane health' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  getAppLaneHealth.mockResolvedValueOnce({ available: true, windowDays: 60, refileDays: 30, truncated: false, partial: [], lanes: [lane({ id: 'ux', label: 'UX' })] });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh lane health' }));
  await waitFor(() => expect(screen.getByText(/No audit lane filed an issue in the last 60 days/)).toBeInTheDocument());
  expect(getAppLaneHealth).toHaveBeenCalledTimes(3);
});
