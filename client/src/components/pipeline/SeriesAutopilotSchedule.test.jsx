import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
}));
vi.mock('../../services/apiAgents', () => ({ getCosConfig: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { getSettings, patchSettingsSlice } from '../../services/apiSystem';
import { getCosConfig } from '../../services/apiAgents';
import SeriesAutopilotSchedule from './SeriesAutopilotSchedule';

const SERIES = { id: 's1', name: 'Test', llm: { provider: 'anthropic', model: 'claude-opus-4-8' } };

const settingsWith = (schedules = []) => ({ seriesAutopilot: { schedules } });

// The provider list is owned by AutopilotPanel and passed down (one fetch per
// panel); tests supply it the same way the parent does.
let providerProps = () => ({
  providers: [{ id: 'anthropic', name: 'Anthropic', models: ['claude-opus-4-8'] }],
  activeProviderId: 'anthropic',
});

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(settingsWith([]));
  providerProps = () => ({
    providers: [{ id: 'anthropic', name: 'Anthropic', models: ['claude-opus-4-8'] }],
    activeProviderId: 'anthropic',
  });
  getCosConfig.mockResolvedValue({
    domainAutonomy: { cos: 'execute' },
    domainBudgets: { cos: { maxActionsPerDay: 40 } },
  });
  patchSettingsSlice.mockResolvedValue({});
});

it('shows "Set schedule" and no consent card when nothing is configured', async () => {
  render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  expect(await screen.findByText('Set schedule')).toBeInTheDocument();
  // No cron → no consent/enable UI yet.
  expect(screen.queryByText(/Enable scheduled autopilot/)).not.toBeInTheDocument();
});

it('names the effective provider/model and the cos budget cap in the consent copy', async () => {
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
  render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  // The daily budget cap is unique to the consent copy; provider/model also
  // appear in the override <select> options, so allow multiple matches there.
  expect(await screen.findByText(/40 actions\/day/)).toBeInTheDocument();
  expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0);
  expect(screen.getAllByText('claude-opus-4-8').length).toBeGreaterThan(0);
});

it('enable toggle is OFF by default and enabling persists enabled:true', async () => {
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
  render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  const toggle = await screen.findByRole('checkbox');
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalled());
  const [slice, payload] = patchSettingsSlice.mock.calls[0];
  expect(slice).toBe('seriesAutopilot');
  expect(payload.schedules).toEqual([
    expect.objectContaining({ seriesId: 's1', cron: '0 3 * * *', enabled: true }),
  ]);
});

it('preserves OTHER series schedules when saving this one', async () => {
  getSettings.mockResolvedValue(settingsWith([
    { seriesId: 'other', enabled: true, cron: '0 5 * * *' },
    { seriesId: 's1', enabled: false, cron: '0 3 * * *' },
  ]));
  render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  const toggle = await screen.findByRole('checkbox');
  fireEvent.click(toggle);
  await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalled());
  const ids = patchSettingsSlice.mock.calls[0][1].schedules.map((s) => s.seriesId);
  expect(ids).toContain('other');
  expect(ids).toContain('s1');
});

it('does not name the series model when the override provider differs from the series provider', async () => {
  // Override to openai; the series is on anthropic. The run will use openai's
  // DEFAULT model, so the consent copy must not show the series' anthropic model.
  providerProps = () => ({
    providers: [
      { id: 'anthropic', name: 'Anthropic', models: ['claude-opus-4-8'] },
      { id: 'openai', name: 'OpenAI', models: ['gpt-5.6'] },
    ],
    activeProviderId: 'anthropic',
  });
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *', provider: 'openai' }]));
  render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  expect(await screen.findByText(/provider default model/)).toBeInTheDocument();
  expect(screen.queryByText('claude-opus-4-8')).not.toBeInTheDocument();
});

it('clears the prior series schedule when switching series so it is not shown/saved under the new id', async () => {
  // settings only holds s1's schedule; s2 has none.
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
  const { rerender } = render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  await screen.findByText('Change'); // s1's configured schedule renders
  // Switch to s2 (different id, no schedule) — must not keep showing s1's cron/consent.
  rerender(<SeriesAutopilotSchedule series={{ id: 's2', name: 'Other', llm: {} }} {...providerProps()} />);
  expect(await screen.findByText('Set schedule')).toBeInTheDocument();
  expect(screen.queryByText(/Enable scheduled autopilot/)).not.toBeInTheDocument();
});

it('warns when CoS autonomy is off', async () => {
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
  getCosConfig.mockResolvedValue({ domainAutonomy: { cos: 'off' }, domainBudgets: {} });
  render(<SeriesAutopilotSchedule series={SERIES} {...providerProps()} />);
  expect(await screen.findByText(/CoS autonomy is off/)).toBeInTheDocument();
});

it('persists a per-schedule reasoning effort and names it in the consent copy (#3641)', async () => {
  // `codex` is effort-capable, so the picker renders its ladder; the entry is
  // stored as `effort` and the scheduler maps it to the run's effortOverride.
  providerProps = () => ({
    providers: [{ id: 'codex', name: 'Codex', models: ['gpt-5-codex'] }],
    activeProviderId: 'codex',
  });
  getSettings.mockResolvedValue(settingsWith([
    { seriesId: 's1', enabled: false, cron: '0 3 * * *', provider: 'codex' },
  ]));
  render(<SeriesAutopilotSchedule series={{ id: 's1', name: 'Test', llm: {} }} {...providerProps()} />);
  fireEvent.change(await screen.findByLabelText('Thinking effort'), { target: { value: 'high' } });
  await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith(
    'seriesAutopilot',
    { schedules: [expect.objectContaining({ seriesId: 's1', effort: 'high' })] },
    { silent: true },
  ));
  expect(await screen.findByText(/reasoning effort/)).toBeInTheDocument();
});

it('drops a stored effort when the schedule provider changes (#3641)', async () => {
  providerProps = () => ({
    providers: [
      { id: 'codex', name: 'Codex', models: ['gpt-5-codex'] },
      { id: 'anthropic', name: 'Anthropic', models: ['claude-opus-4-8'] },
    ],
    activeProviderId: 'codex',
  });
  getSettings.mockResolvedValue(settingsWith([
    { seriesId: 's1', enabled: false, cron: '0 3 * * *', provider: 'codex', effort: 'high' },
  ]));
  render(<SeriesAutopilotSchedule series={{ id: 's1', name: 'Test', llm: {} }} {...providerProps()} />);
  fireEvent.change(
    await screen.findByLabelText('Override provider for scheduled runs'),
    { target: { value: 'anthropic' } },
  );
  await waitFor(() => expect(patchSettingsSlice).toHaveBeenCalledWith(
    'seriesAutopilot',
    { schedules: [expect.objectContaining({ provider: 'anthropic', effort: undefined })] },
    { silent: true },
  ));
});
