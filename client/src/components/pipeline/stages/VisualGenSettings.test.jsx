/**
 * The "Auto → …" label must name the backend that will actually render
 * (#6815). Before this, `resolveAutoLabel` was a hand copy of the server's
 * mode ladder that only ever consulted `settings.imageGen.mode` + the enable
 * flags — it ignored both a `renderDefaults['pipeline-visual']` pin and a
 * series-level render pin, so the label could name one backend while the
 * server dispatched to another. These tests render through the real shared
 * ladder (`pickUsableMode` + `imageModeCandidates`, server/lib/renderModeLadder.js)
 * and assert on the rendered blurb text, not an internal function — the bug
 * lived in a function these tests would happily re-implement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  getSettings: vi.fn(),
  listImageModels: vi.fn(),
  getProviders: vi.fn(),
}));

import { VisualGenSettingsPanel } from './VisualGenSettings';
import { getSettings, listImageModels, getProviders } from '../../../services/api';

const CODEX_ONLY = { mode: 'codex', codex: { enabled: true }, local: { pythonPath: '/usr/bin/python3' } };

beforeEach(() => {
  vi.clearAllMocks();
  listImageModels.mockResolvedValue([]);
  getProviders.mockResolvedValue({ providers: [] });
});

describe('VisualGenSettings — "Auto →" label (#6815)', () => {
  it('honors a pipeline-visual renderDefaults pin over the install-wide default', async () => {
    getSettings.mockResolvedValue({
      imageGen: CODEX_ONLY,
      renderDefaults: { 'pipeline-visual': { imageMode: 'local' } },
    });
    render(<VisualGenSettingsPanel value={null} onChange={vi.fn()} />);
    expect(await screen.findByText(/currently Local diffusion\./)).toBeInTheDocument();
  });

  it('names the backend a series is pinned to, even when the install default would pick a different enabled backend', async () => {
    // Both codex and agy are enabled, so an unpinned auto-default resolves to
    // codex (CLOUD_IMAGE_GEN_MODES order) — an observed "Agy" can only have
    // come from the series pin.
    getSettings.mockResolvedValue({ imageGen: { codex: { enabled: true }, agy: { enabled: true } } });
    render(<VisualGenSettingsPanel value={null} onChange={vi.fn()} series={{ id: 'ser-1', imageMode: 'agy' }} />);
    expect(await screen.findByText(/currently Agy\./)).toBeInTheDocument();
  });

  it('falls through a series pin on a disabled backend to the pipeline-visual renderDefaults pin', async () => {
    getSettings.mockResolvedValue({
      imageGen: { mode: 'codex', codex: { enabled: true }, agy: { enabled: false }, grok: { enabled: true } },
      renderDefaults: { 'pipeline-visual': { imageMode: 'grok' } },
    });
    render(
      <VisualGenSettingsPanel value={null} onChange={vi.fn()} series={{ id: 'ser-1', imageMode: 'agy' }} />,
    );
    expect(await screen.findByText(/currently Grok\./)).toBeInTheDocument();
  });

  it('keeps the "(not configured)" suffix when Auto resolves to local with no pythonPath set', async () => {
    getSettings.mockResolvedValue({ imageGen: {} });
    render(<VisualGenSettingsPanel value={null} onChange={vi.fn()} />);
    expect(await screen.findByText(/currently Local diffusion \(not configured\)\./)).toBeInTheDocument();
  });
});

describe('VisualGenSettings — failed lookups', () => {
  it('reports a failed provider read with Retry instead of "No enabled providers", and recovers', async () => {
    getSettings.mockResolvedValue({ imageGen: CODEX_ONLY });
    getProviders
      .mockRejectedValueOnce(new Error('registry down'))
      .mockResolvedValueOnce({ providers: [{ id: 'p1', name: 'P1', enabled: true, models: ['m1'], defaultModel: 'm1' }] });
    render(<VisualGenSettingsPanel value={null} onChange={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load providers');
    expect(screen.queryByText(/No enabled providers/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox', { name: 'Override default' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not claim Codex is disabled or name an Auto backend when the settings read failed', async () => {
    getSettings.mockRejectedValue(new Error('settings down'));
    const { rerender } = render(<VisualGenSettingsPanel value={null} onChange={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load settings');
    expect(screen.getByText('Auto follows the server default.')).toBeInTheDocument();

    rerender(<VisualGenSettingsPanel value={{ imageMode: 'codex' }} onChange={vi.fn()} />);
    expect(screen.queryByText(/Codex Imagegen is disabled/)).not.toBeInTheDocument();
  });
});
