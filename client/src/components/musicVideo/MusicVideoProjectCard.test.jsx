import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import MusicVideoProjectCard from './MusicVideoProjectCard.jsx';

vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoHistoryItem: vi.fn(async (id) => ({ id, filename: `${id}.mp4` })),
}));

const BASE_PROJECT = {
  id: 'mv-card-1',
  name: 'Cyber Horizon',
  version: 2,
  status: 'ready',
  mode: 'autonomous',
  trackId: 'track-1',
  audioAnalysis: { bpm: 128, durationSec: 180 },
  vocalStemFilename: 'vocals.wav',
  midiTranscription: 'notes.mid',
  videoSettings: {
    backend: 'fal',
    modelId: 'hunyuan_video',
    generationMode: 'image',
    audioReactiveLora: 'audio-reactive.safetensors',
  },
  concept: {
    universeId: 'neon-city',
    style: 'retro synthwave neon lighting',
  },
  visualSpec: {
    palette: ['#ff007f', '#00f0ff'],
    references: [],
  },
  scenes: [
    { sceneId: 's1', referenceImageId: 'frame-1.png', videoHistoryId: 'vid-1' },
    { sceneId: 's2', referenceImageId: 'frame-2.png', videoHistoryId: null },
  ],
  renderHistoryId: null,
};

describe('MusicVideoProjectCard', () => {
  it('renders richly detailed metadata and configuration options', () => {
    const onSelect = vi.fn();
    render(
      <MusicVideoProjectCard
        project={BASE_PROJECT}
        trackLabel="Synth Dreams"
        onSelect={onSelect}
      />,
    );

    // Title and version
    expect(screen.getByText('Cyber Horizon')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();

    // Mode and stage
    expect(screen.getByText(/Autopilot/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage:/i)).toBeInTheDocument();
    expect(screen.getByText('neon-city')).toBeInTheDocument();

    // Audio & analysis
    expect(screen.getByText('Synth Dreams')).toBeInTheDocument();
    expect(screen.getByText('128 BPM')).toBeInTheDocument();
    expect(screen.getByText('Vocal Stem')).toBeInTheDocument();
    expect(screen.getByText('MIDI')).toBeInTheDocument();

    // Video settings
    expect(screen.getByText('fal')).toBeInTheDocument();
    expect(screen.getByText('hunyuan_video')).toBeInTheDocument();
    expect(screen.getByText('I2V')).toBeInTheDocument();
    expect(screen.getByText('Reactive')).toBeInTheDocument();

    // Style text
    expect(screen.getByText(/retro synthwave neon lighting/i)).toBeInTheDocument();

    // Scene stats
    expect(screen.getByText(/2 scenes · 1 clip/i)).toBeInTheDocument();
  });

  it('handles clicking the open button or title to select project', () => {
    const onSelect = vi.fn();
    render(
      <MusicVideoProjectCard
        project={BASE_PROJECT}
        trackLabel="Synth Dreams"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Open$/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cyber Horizon' }));
    expect(onSelect).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Open project Cyber Horizon' }));
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('renders video preview with play button and handles clicking play', async () => {
    render(
      <MusicVideoProjectCard
        project={BASE_PROJECT}
        trackLabel="Synth Dreams"
      />,
    );

    // Shows scene clip label and play button
    expect(screen.getByText('Scene 1 clip')).toBeInTheDocument();
    const playBtn = screen.getByRole('button', { name: /Play Scene 1 clip/i });
    expect(playBtn).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(playBtn);
    });

    // After clicking play, it mounts ScenePreview
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Play Scene 1 clip/i })).not.toBeInTheDocument();
    });
  });

  it('handles fork/clone and delete confirmation', () => {
    const onClone = vi.fn();
    const onRequestDelete = vi.fn();
    const onConfirmDelete = vi.fn();
    const onCancelDelete = vi.fn();

    const { rerender } = render(
      <MusicVideoProjectCard
        project={BASE_PROJECT}
        onClone={onClone}
        onRequestDelete={onRequestDelete}
        isConfirmingDelete={false}
      />,
    );

    // Fork
    fireEvent.click(screen.getByRole('button', { name: /Fork/i }));
    expect(onClone).toHaveBeenCalledTimes(1);

    // Delete request
    fireEvent.click(screen.getByRole('button', { name: /Delete project Cyber Horizon/i }));
    expect(onRequestDelete).toHaveBeenCalledTimes(1);

    // When confirming delete
    rerender(
      <MusicVideoProjectCard
        project={BASE_PROJECT}
        onClone={onClone}
        onRequestDelete={onRequestDelete}
        isConfirmingDelete={true}
        onConfirmDelete={onConfirmDelete}
        onCancelDelete={onCancelDelete}
      />,
    );

    expect(screen.getByText('Delete?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete project Cyber Horizon' }));
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
  });

  it('renders placeholder when no render is present', () => {
    const emptyProj = {
      ...BASE_PROJECT,
      id: 'empty-1',
      scenes: [],
      visualSpec: null,
      renderHistoryId: null,
    };
    render(<MusicVideoProjectCard project={emptyProj} />);
    expect(screen.getByText('No render preview yet')).toBeInTheDocument();
  });
});
