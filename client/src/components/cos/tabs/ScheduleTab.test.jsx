import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const api = vi.hoisted(() => ({
  getCodeReviewDefaults: vi.fn(),
  getCosSchedule: vi.fn(),
  triggerCosOnDemandTask: vi.fn(),
  updateCosTaskInterval: vi.fn(),
  getLocalLlmStatus: vi.fn().mockResolvedValue(null),
  getProviders: vi.fn().mockResolvedValue({ providers: [] }),
}));

vi.mock('../../ui/Toast', () => ({ default: toast }));
vi.mock('../../../services/api', () => api);

const { default: ScheduleTab, mergeUpdatedTaskInterval } = await import('./ScheduleTab');

describe('mergeUpdatedTaskInterval', () => {
  it('applies the persisted interval while retaining derived schedule status', () => {
    const schedule = {
      lastUpdated: 'earlier',
      tasks: {
        'plan-feature': {
          dataInputs: ['project-goals'],
          enabledAppCount: 2,
          status: { shouldRun: false },
        },
      },
    };

    expect(mergeUpdatedTaskInterval(schedule, 'plan-feature', {
      dataInputs: ['project-goals', 'open-issues'],
    })).toEqual({
      ...schedule,
      tasks: {
        'plan-feature': {
          dataInputs: ['project-goals', 'open-issues'],
          enabledAppCount: 2,
          status: { shouldRun: false },
        },
      },
    });
    expect(schedule.tasks['plan-feature'].dataInputs).toEqual(['project-goals']);
  });
});

describe('ScheduleTab on-demand feedback', () => {
  it('names the selected app and paints the returned request before the refresh settles', async () => {
    const user = userEvent.setup();
    const request = {
      id: 'request-1',
      taskType: 'review',
      appId: 'app-1',
      requestedAt: '2026-09-01T12:00:00.000Z',
    };
    api.getCodeReviewDefaults.mockResolvedValue({});
    api.getCosSchedule
      .mockResolvedValueOnce({
        improvementEnabled: true,
        tasks: {
          review: {
            type: 'on-demand',
            enabled: true,
            enabledAppCount: 1,
            totalAppCount: 1,
            invocation: { userInvokable: true },
          },
        },
        onDemandRequests: [],
      })
      // Hold the background refresh so this assertion uniquely proves the
      // mutation response updates the visible schedule immediately.
      .mockReturnValueOnce(new Promise(() => {}));
    api.triggerCosOnDemandTask.mockResolvedValue({ success: true, request });

    render(
      <MemoryRouter>
        <ScheduleTab
          apps={[{ id: 'app-1', name: 'Example App' }]}
          providers={[]}
          activeProviderId={null}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /Run on App/i }));
    await user.click(screen.getByRole('button', { name: 'Example App' }));

    await waitFor(() => expect(api.triggerCosOnDemandTask).toHaveBeenCalledWith(
      'review',
      'app-1',
      { silent: true },
    ));
    expect(toast.success).toHaveBeenCalledWith(
      'Queued review request for Example App — it will appear in Tasks when evaluation begins',
    );
    expect(await screen.findByText('Request queued for Example App')).toBeVisible();
    expect(screen.getByText('Pending On-Demand Tasks')).toBeVisible();
    expect(screen.getByText(/review \(Example App\) - requested/)).toBeVisible();
  });

  it('warns instead of celebrating a queued request when the CoS daemon is stopped', async () => {
    const user = userEvent.setup();
    const request = {
      id: 'request-2',
      taskType: 'review',
      appId: 'app-1',
      requestedAt: '2026-09-01T12:00:00.000Z',
    };
    api.getCodeReviewDefaults.mockResolvedValue({});
    api.getCosSchedule
      .mockResolvedValueOnce({
        improvementEnabled: true,
        tasks: {
          review: {
            type: 'on-demand',
            enabled: true,
            enabledAppCount: 1,
            totalAppCount: 1,
            invocation: { userInvokable: true },
          },
        },
        onDemandRequests: [],
      })
      // Hold the background refresh so this assertion proves the
      // optimistically-painted request (and its daemon-stopped warning)
      // stays visible without waiting on a second round trip.
      .mockReturnValueOnce(new Promise(() => {}));
    api.triggerCosOnDemandTask.mockResolvedValue({ success: true, request });

    render(
      <MemoryRouter>
        <ScheduleTab
          apps={[{ id: 'app-1', name: 'Example App' }]}
          providers={[]}
          activeProviderId={null}
          daemonRunning={false}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('button', { name: /Run on App/i }));
    await user.click(screen.getByRole('button', { name: 'Example App' }));

    await waitFor(() => expect(api.triggerCosOnDemandTask).toHaveBeenCalledWith(
      'review',
      'app-1',
      { silent: true },
    ));
    expect(toast.error).toHaveBeenCalledWith(
      'Queued review request for Example App — but the CoS daemon is stopped, so it will not run until you start it',
    );
    expect(await screen.findByText(/CoS daemon is stopped/)).toBeVisible();
  });
});


describe('Schedule labels', () => {
  it('filters by a linked label, searches legacy names, and saves custom labels through the drawer', async () => {
    const user = userEvent.setup();
    api.getCodeReviewDefaults.mockResolvedValue({});
    api.getCosSchedule.mockResolvedValue({ tasks: {
      security: { type: 'on-demand', enabled: false, displayName: 'better-security', defaultLabels: ['slashdo'], labels: [], description: 'Security audit' },
      'claim-issue': { type: 'on-demand', enabled: false, description: 'Claim work' },
    } });
    api.updateCosTaskInterval.mockResolvedValue({ success: true, interval: { labels: ['backend'] } });
    render(<MemoryRouter initialEntries={['/cos/schedule?label=slashdo']}><ScheduleTab apps={[]} providers={[]} providersLoaded /></MemoryRouter>);
    expect(await screen.findByText('better-security')).toBeTruthy();
    expect(screen.queryByText('claim-issue')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Clear label' }));
    expect(screen.getByText('claim-issue')).toBeTruthy();
    await user.type(screen.getByRole('textbox', { name: 'Filter tasks by name' }), 'security');
    expect(screen.queryByText('claim-issue')).toBeNull();
    await user.click(screen.getByText('better-security'));
    const labels = await screen.findByRole('textbox', { name: 'Custom labels' });
    await user.type(labels, 'backend');
    await user.tab();
    await waitFor(() => expect(api.updateCosTaskInterval).toHaveBeenCalledWith('security', { labels: ['backend'] }, { silent: true }));
    expect(await screen.findByRole('option', { name: 'backend (1)' })).toBeTruthy();
  });
});

it('keeps maintenance selections and the last saved schedule after a refresh failure', async () => {
  const user = userEvent.setup();
  api.getCodeReviewDefaults.mockResolvedValue({});
  api.getCosSchedule.mockReset().mockResolvedValueOnce({ tasks: {} }).mockRejectedValueOnce(new Error('offline'));
  render(<MemoryRouter><ScheduleTab apps={[{ id: 'example', name: 'Example App' }]} providers={[]} providersLoaded /></MemoryRouter>);
  await user.click(await screen.findByText('Run maintenance now'));
  await user.selectOptions(screen.getByLabelText('App'), 'example');
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(api.getCosSchedule).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('App')).toHaveValue('example');
  expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  expect(screen.queryByText('Failed to load task schedule')).not.toBeInTheDocument();
});
