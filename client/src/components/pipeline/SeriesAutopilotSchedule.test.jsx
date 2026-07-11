import { it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiSystem', () => ({
  getSettings: vi.fn(),
  patchSettingsSlice: vi.fn(),
}));
vi.mock('../../services/apiProviders', () => ({ getProviders: vi.fn() }));
vi.mock('../../services/apiAgents', () => ({ getCosConfig: vi.fn() }));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { getSettings, patchSettingsSlice } from '../../services/apiSystem';
import { getProviders } from '../../services/apiProviders';
import { getCosConfig } from '../../services/apiAgents';
import SeriesAutopilotSchedule from './SeriesAutopilotSchedule';

const SERIES = { id: 's1', name: 'Test', llm: { provider: 'anthropic', model: 'claude-opus-4-8' } };

const settingsWith = (schedules = []) => ({ seriesAutopilot: { schedules } });

beforeEach(() => {
  vi.clearAllMocks();
  getSettings.mockResolvedValue(settingsWith([]));
  getProviders.mockResolvedValue({
    providers: [{ id: 'anthropic', name: 'Anthropic', models: ['claude-opus-4-8'] }],
    activeProvider: 'anthropic',
  });
  getCosConfig.mockResolvedValue({
    domainAutonomy: { cos: 'execute' },
    domainBudgets: { cos: { maxActionsPerDay: 40 } },
  });
  patchSettingsSlice.mockResolvedValue({});
});

it('shows "Set schedule" and no consent card when nothing is configured', async () => {
  render(<SeriesAutopilotSchedule series={SERIES} />);
  expect(await screen.findByText('Set schedule')).toBeInTheDocument();
  // No cron → no consent/enable UI yet.
  expect(screen.queryByText(/Enable scheduled autopilot/)).not.toBeInTheDocument();
});

it('names the effective provider/model and the cos budget cap in the consent copy', async () => {
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
  render(<SeriesAutopilotSchedule series={SERIES} />);
  // The daily budget cap is unique to the consent copy; provider/model also
  // appear in the override <select> options, so allow multiple matches there.
  expect(await screen.findByText(/40 actions\/day/)).toBeInTheDocument();
  expect(screen.getAllByText('Anthropic').length).toBeGreaterThan(0);
  expect(screen.getAllByText('claude-opus-4-8').length).toBeGreaterThan(0);
});

it('enable toggle is OFF by default and enabling persists enabled:true', async () => {
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
  render(<SeriesAutopilotSchedule series={SERIES} />);
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
  render(<SeriesAutopilotSchedule series={SERIES} />);
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
  getProviders.mockResolvedValue({
    providers: [
      { id: 'anthropic', name: 'Anthropic', models: ['claude-opus-4-8'] },
      { id: 'openai', name: 'OpenAI', models: ['gpt-5.6'] },
    ],
    activeProvider: 'anthropic',
  });
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *', provider: 'openai' }]));
  render(<SeriesAutopilotSchedule series={SERIES} />);
  expect(await screen.findByText(/provider default model/)).toBeInTheDocument();
  expect(screen.queryByText('claude-opus-4-8')).not.toBeInTheDocument();
});

it('clears the prior series schedule when switching series so it is not shown/saved under the new id', async () => {
  // settings only holds s1's schedule; s2 has none.
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: true, cron: '0 3 * * *' }]));
  const { rerender } = render(<SeriesAutopilotSchedule series={SERIES} />);
  await screen.findByText('Change'); // s1's configured schedule renders
  // Switch to s2 (different id, no schedule) — must not keep showing s1's cron/consent.
  rerender(<SeriesAutopilotSchedule series={{ id: 's2', name: 'Other', llm: {} }} />);
  expect(await screen.findByText('Set schedule')).toBeInTheDocument();
  expect(screen.queryByText(/Enable scheduled autopilot/)).not.toBeInTheDocument();
});

it('warns when CoS autonomy is off', async () => {
  getSettings.mockResolvedValue(settingsWith([{ seriesId: 's1', enabled: false, cron: '0 3 * * *' }]));
  getCosConfig.mockResolvedValue({ domainAutonomy: { cos: 'off' }, domainBudgets: {} });
  render(<SeriesAutopilotSchedule series={SERIES} />);
  expect(await screen.findByText(/CoS autonomy is off/)).toBeInTheDocument();
});
