import { describe, it, expect, vi } from 'vitest';
vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
import { render, screen, fireEvent } from '@testing-library/react';
vi.mock('../../hooks/useFederatedMediaTarget.js', () => ({ useFederatedMediaTarget: () => ({ peers: [] }) }));
import VideoRenderSettings from './VideoRenderSettings.jsx';
import { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL } from '../../lib/runwayVideoModels.js';

const base = {
  settings: { backend: 'local', generationMode: 'audioReactive', modelId: '', audioReactiveLora: '', audioReactiveScale: 1.2 },
  saving: false, models: [], modelsLoading: false, defaultModel: '', effectiveModelId: '',
  audioReactiveModels: [], audioReactiveLoras: [], detectedAudioReactiveLora: null,
  audioReactiveReady: false, audioReactiveSelected: true, change: vi.fn(),
};

describe('VideoRenderSettings catalog failure', () => {
  it('preserves an explicitly pinned Runway default model in the selector', () => {
    render(<VideoRenderSettings videoSettings={{ ...base, settings: { ...base.settings, backend: 'runway', runwayModelId: RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL } }} />);
    expect(screen.getByLabelText('Runway cutaway model').value).toBe(RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL);
  });

  it('offers Retry instead of claiming audio-reactive is unavailable', () => {
    const retryCatalog = vi.fn();
    render(<VideoRenderSettings videoSettings={{ ...base, catalogStatus: 'error', retryCatalog }} />);
    expect(screen.queryByText('audio-reactive unavailable')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps the unavailable copy after a successful read', () => {
    render(<VideoRenderSettings videoSettings={{ ...base, catalogStatus: 'ready', retryCatalog: vi.fn() }} />);
    expect(screen.getByText('audio-reactive unavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
