import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Toaster, toast } from '../../ui/Toast';
import { deleteRun, deleteFailedRuns, getRunPrompt, getRunOutput } from '../../../services/apiRuns.js';
import RunsTab, { runLogProcessName } from './RunsTab';

vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../ui/ProcessLogModal', () => ({ default: () => null }));
vi.mock('../../../services/apiRuns.js', () => ({
  getRuns: async () => ({ runs: [failedRun, runningRun] }),
  getRun: vi.fn(),
  getRunPrompt: vi.fn().mockResolvedValue('Full prompt'),
  getRunOutput: vi.fn().mockResolvedValue('Full output'),
  stopRun: vi.fn(),
  deleteRun: vi.fn(),
  deleteFailedRuns: vi.fn(),
}));

const failedRun = {
  id: 'failed-example',
  source: 'cos-agent',
  success: false,
  providerName: 'Example provider',
  model: 'sample-model',
  prompt: 'Failed task',
  startTime: '2026-01-01T12:00:00Z',
  executionOptions: { requested: { serviceTier: 'fast' }, effective: { serviceTier: 'standard' } },
};
const runningRun = {
  ...failedRun,
  id: 'running-example',
  source: 'devtools',
  success: null,
  model: undefined,
  prompt: 'Running task',
};

const renderTab = () => render(
  <MemoryRouter>
    <RunsTab />
    <Toaster />
  </MemoryRouter>,
);

afterEach(() => act(() => toast.dismiss()));

describe('RunsTab details', () => {
  it('renders successful empty details even when the row has a prompt preview', async () => {
    const user = userEvent.setup();
    getRunPrompt.mockResolvedValueOnce('');
    getRunOutput.mockResolvedValueOnce('');
    renderTab();
    const row = within(await screen.findByTestId('run-row-failed-example'));
    const disclosure = row.getByRole('button', { expanded: false });
    await user.click(disclosure);
    const details = within(document.getElementById(disclosure.getAttribute('aria-controls')));

    expect(await details.findByText('(no prompt)')).toBeVisible();
    expect(details.getByText('(no output)')).toBeVisible();
    expect(details.queryByRole('status', { name: 'Loading run details' })).not.toBeInTheDocument();
  });

  it.each([
    ['prompt', getRunPrompt],
    ['output', getRunOutput],
  ])('shows an inline error when the %s read fails and recovers on Retry', async (field, read) => {
    const user = userEvent.setup();
    read.mockRejectedValueOnce(new Error(`Unavailable ${field}`));
    renderTab();
    const row = within(await screen.findByTestId('run-row-failed-example'));
    const disclosure = row.getByRole('button', { expanded: false });
    await user.click(disclosure);
    const details = within(document.getElementById(disclosure.getAttribute('aria-controls')));

    const error = within(await details.findByRole('alert'));
    expect(error.getByText(`Could not load run details — Unavailable ${field}`)).toBeVisible();
    expect(details.queryByText('(no output)')).not.toBeInTheDocument();
    await user.click(error.getByRole('button', { name: 'Retry' }));

    expect(await details.findByText('Full prompt')).toBeVisible();
    expect(details.getByText('Full output')).toBeVisible();
    expect(details.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('RunsTab accessibility', () => {
  it('exposes a native keyboard disclosure and separate, run-specific actions', async () => {
    const user = userEvent.setup();
    const { container } = renderTab();
    const failed = within(await screen.findByTestId('run-row-failed-example'));
    const running = within(screen.getByTestId('run-row-running-example'));
    const disclosure = failed.getByRole('button', { name: /Run details for Example provider/, expanded: false });
    const nextControls = [
      failed.getByRole('button', { name: 'View system logs for run Example provider sample-model (failed-example)' }),
      failed.getByRole('button', { name: 'Resume run Example provider sample-model (failed-example)' }),
      failed.getByRole('button', { name: 'Delete run Example provider sample-model (failed-example)' }),
      running.getByRole('button', { expanded: false }),
      running.getByRole('button', { name: 'Stop run Example provider (running-example)' }),
      running.getByRole('button', { name: 'Delete run Example provider (running-example)' }),
    ];
    expect(disclosure.tagName).toBe('BUTTON');
    expect(disclosure).toHaveAttribute('type', 'button');
    expect(disclosure).not.toHaveAttribute('aria-controls');
    expect(failed.getByText(/requested fast; effective standard/)).toBeVisible();

    disclosure.focus();
    await user.keyboard('{Enter}');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure).toHaveAttribute('aria-controls', 'run-details-failed-example');
    expect(document.getElementById('run-details-failed-example')).toContainElement(await screen.findByText('Full output'));
    expect(container.querySelector(':is(button, [role="button"]) :is(button, [role="button"], a[href], [tabindex])')).toBeNull();

    await user.keyboard(' ');
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(disclosure).not.toHaveAttribute('aria-controls');
    expect(document.getElementById('run-details-failed-example')).toBeNull();
    for (const control of nextControls) {
      await user.tab();
      expect(control).toHaveFocus();
    }
  });

  it('requires a separate confirmation to stop and delete a running run', async () => {
    const user = userEvent.setup();
    deleteRun.mockResolvedValueOnce({ success: true });
    renderTab();
    const row = within(await screen.findByTestId('run-row-running-example'));
    const deleteButton = () => row.getByRole('button', { name: /^Delete run/ });

    deleteButton().focus();
    await user.keyboard('{Enter}');
    const confirmation = within(row.getByRole('group', { name: /^Confirm stop and delete run/ }));
    expect(confirmation.getByText('Stop and delete?')).toBeVisible();
    expect(row.queryByRole('button', { name: /^Stop run/ })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(deleteRun).not.toHaveBeenCalled();

    await user.click(confirmation.getByRole('button', { name: 'Cancel' }));
    expect(deleteButton()).toBeVisible();
    expect(deleteRun).not.toHaveBeenCalled();

    await user.click(deleteButton());
    await user.click(row.getByRole('button', { name: 'Delete', exact: true }));
    expect(deleteRun).toHaveBeenCalledExactlyOnceWith(runningRun.id);
    expect(screen.queryByTestId('run-row-running-example')).not.toBeInTheDocument();
  });

  it('describes the install-wide scope and requires confirmation before clearing failed runs', async () => {
    const user = userEvent.setup();
    deleteFailedRuns.mockResolvedValueOnce({ deletedCount: 20 });
    renderTab();
    const clear = await screen.findByRole('button', { name: 'Clear Failed', exact: true });
    const question = 'Delete every failed run on this install? This removes their prompts and output.';

    await user.click(clear);
    const confirmation = screen.getByRole('group', { name: question });
    expect(confirmation).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(deleteFailedRuns).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('run-row-failed-example')).toBeVisible();
    expect(deleteFailedRuns).not.toHaveBeenCalled();

    await user.click(clear);
    await user.click(screen.getByRole('button', { name: 'Delete failed runs' }));
    expect(deleteFailedRuns).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('run-row-failed-example')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-row-running-example')).toBeVisible();
  });

  it('copies the selected execution ID and announces success', async () => {
    const user = userEvent.setup();
    renderTab();
    const row = within(await screen.findByTestId('run-row-failed-example'));
    await user.click(row.getByRole('button', { expanded: false }));
    const copy = screen.getByRole('button', { name: 'Copy execution ID' });

    expect(copy).toHaveAttribute('type', 'button');
    expect(copy).toHaveClass('min-h-[44px]', 'min-w-[44px]');
    await user.click(copy);

    expect(await navigator.clipboard.readText()).toBe(failedRun.id);
    expect(await screen.findByRole('status')).toHaveTextContent('Execution ID copied to clipboard');
  });

  it('presses exactly the selected button in each named filter group', async () => {
    const user = userEvent.setup();
    renderTab();
    const source = within(await screen.findByRole('group', { name: 'Filter runs by source' }));
    const status = within(screen.getByRole('group', { name: 'Filter runs by status' }));
    const sourceButtons = ['All', 'DevTools', 'CoS'];
    const statusButtons = ['All Status', 'Success', 'Running', 'Failed'];
    const expectPressed = (group, names, active) => {
      for (const name of names) {
        expect(group.getByRole('button', { name, pressed: name === active })).toHaveAttribute('type', 'button');
      }
    };

    expectPressed(source, sourceButtons, 'All');
    expectPressed(status, statusButtons, 'All Status');
    await user.click(source.getByRole('button', { name: 'CoS' }));
    await user.click(await screen.findByRole('button', { name: 'Failed', pressed: false }));

    expectPressed(within(screen.getByRole('group', { name: 'Filter runs by source' })), sourceButtons, 'CoS');
    expectPressed(within(screen.getByRole('group', { name: 'Filter runs by status' })), statusButtons, 'Failed');
    expect(screen.getByTestId('run-row-failed-example')).toBeVisible();
    expect(screen.queryByTestId('run-row-running-example')).not.toBeInTheDocument();
  });
});

describe('runLogProcessName', () => {
  it('maps cos-agent runs to the portos-cos process', () => {
    expect(runLogProcessName('cos-agent')).toBe('portos-cos');
  });

  it('maps devtools and unknown sources to the main portos-server process', () => {
    expect(runLogProcessName('devtools')).toBe('portos-server');
    expect(runLogProcessName(undefined)).toBe('portos-server');
  });
});
