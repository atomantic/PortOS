import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommissionConfigForm from './CommissionConfigForm.jsx';
import { patchFormState, toForm } from './commissionForm.js';

const api = vi.hoisted(() => ({
  listMusicEngines: vi.fn(), getProviders: vi.fn(), getSettings: vi.fn(),
  listImageModels: vi.fn(), listVideoModels: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../ProviderModelSelector', () => ({ default: () => <div data-testid="provider-model-selector" /> }));

function Harness() {
  const [form, setForm] = useState(toForm({
    targetAbility: 'music',
    brief: { intent: 'original ambient track', musicTaste: { source: 'digital-twin' } },
    generation: { lengthSeconds: 45 },
  }));
  return (
    <CommissionConfigForm
      form={form}
      patchForm={(path, value) => setForm((prev) => patchFormState(prev, path, value))}
      saving={false}
      onSave={() => {}}
    />
  );
}

beforeEach(() => {
  api.getProviders.mockResolvedValue({ providers: [] });
  api.getSettings.mockResolvedValue({});
  api.listImageModels.mockResolvedValue([]);
  api.listVideoModels.mockResolvedValue([]);
  api.listMusicEngines.mockResolvedValue({
    defaultEngine: 'musicgen',
    engines: [{
      id: 'musicgen', name: 'MusicGen', ready: true, runtimeReady: true, modelReady: true,
      platformSupported: true, cudaRequired: false, defaultModelId: 'default-model',
      models: [{ id: 'default-model', name: 'Default model' }],
    }],
  });
});

describe('CommissionConfigForm music taste controls', () => {
  it('exposes the source, window, anchors, exploration, engine, and model', async () => {
    render(<Harness />);
    expect(screen.getByRole('checkbox', { name: /use my digital twin music taste/i })).toBeChecked();
    expect(screen.getByLabelText('Taste source')).toHaveValue('digital-twin');
    expect(screen.getByLabelText('Listening window')).toHaveValue('month');
    expect(screen.getByLabelText('Anchors per run')).toHaveValue(3);
    expect(screen.getByLabelText('Exploration (%)')).toHaveValue(20);
    await waitFor(() => expect(screen.getByLabelText('Music engine')).toContainHTML('MusicGen'));
    expect(screen.getByLabelText('Music model')).toContainHTML('Default model');
    expect(api.listMusicEngines).toHaveBeenCalledWith({ silent: true });
  });

  it('shows an actionable warning when the selected default runtime is unavailable', async () => {
    api.listMusicEngines.mockResolvedValueOnce({
      defaultEngine: 'musicgen',
      engines: [{
        id: 'musicgen', name: 'MusicGen', ready: false, runtimeReady: false, modelReady: true,
        platformSupported: true, cudaRequired: false, defaultModelId: 'default-model', models: [],
      }],
    });
    render(<Harness />);
    expect(await screen.findByText(/install its runtime from music/i)).toBeInTheDocument();
  });

  it('warns when a configured model disappeared from the live engine catalog', async () => {
    function MissingModelHarness() {
      const [form, setForm] = useState(toForm({
        targetAbility: 'music', brief: {
          intent: 'original ambient track',
          musicTaste: { source: 'digital-twin', musicEngineId: 'musicgen', musicModelId: 'removed-model' },
        },
      }));
      return (
        <CommissionConfigForm
          form={form}
          patchForm={(path, value) => setForm((prev) => patchFormState(prev, path, value))}
          saving={false}
          onSave={() => {}}
        />
      );
    }
    render(<MissingModelHarness />);
    expect(await screen.findByText(/configured music model is no longer available/i)).toBeInTheDocument();
  });

  it('lets the user disable taste mode without losing the music commission', async () => {
    render(<Harness />);
    await waitFor(() => {
      expect(api.listMusicEngines).toHaveBeenCalled();
      expect(api.getProviders).toHaveBeenCalled();
      expect(api.getSettings).toHaveBeenCalled();
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /use my digital twin music taste/i }));
    expect(screen.queryByLabelText('Listening window')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Creative output')).toHaveValue('music');
  });
});

describe('CommissionConfigForm video duration controls', () => {
  it('defaults to Creative Director choice and reveals a manual length when selected', async () => {
    function VideoHarness() {
      const [form, setForm] = useState(toForm({ brief: { intent: 'a drifting city' } }));
      return (
        <CommissionConfigForm
          form={form}
          patchForm={(path, value) => setForm((prev) => patchFormState(prev, path, value))}
          saving={false}
          onSave={() => {}}
        />
      );
    }
    render(<VideoHarness />);
    await waitFor(() => {
      expect(api.getProviders).toHaveBeenCalled();
      expect(api.getSettings).toHaveBeenCalled();
    });
    expect(screen.getByLabelText('Video length')).toHaveValue('auto');
    expect(screen.queryByLabelText('Duration (sec)')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Video length'), { target: { value: 'manual' } });
    expect(screen.getByLabelText('Duration (sec)')).toHaveValue(10);
  });
});
