import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { Toaster, toast } from '../../ui/Toast';
import RunsTab, { runLogProcessName } from './RunsTab';

vi.mock('../../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../ui/ProcessLogModal', () => ({ default: () => null }));
vi.mock('../../../services/apiRuns.js', () => ({
  getRuns: async () => ({ runs: [failedRun, runningRun] }),
  getRun: vi.fn(),
  getRunPrompt: async () => 'Full prompt',
  getRunOutput: async () => 'Full output',
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
