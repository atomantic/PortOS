import { describe, it, expect, vi, afterEach } from 'vitest';
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
afterEach(() => vi.unstubAllGlobals());

describe('MusicVideoProjectCard', () => {
  it('offers a distinct review action for an existing final render', () => {
    const onSelect = vi.fn(), onReview = vi.fn();
    render(<MusicVideoProjectCard project={{ ...BASE_PROJECT, renderHistoryId: 'example-final' }} onSelect={onSelect} onReview={onReview} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review video' }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('offers exact imported-draft playback and only says ready after media loaded', async () => {
    let intersect;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback) { intersect = callback; }
      observe() {}
      disconnect() {}
    });
    const src = '/api/music-video/example/dev-artifacts/film/file?version=2';
    const project = { ...BASE_PROJECT, preview: { kind: 'video', source: 'animatic', artifactId: 'film', version: 2, src, poster: null, label: 'Imported draft · v2', reviewStatus: 'pending' } };
    const { container } = render(<MusicVideoProjectCard project={project} />);
    expect(screen.queryByText('Ready to review')).toBeNull();
    expect(container.querySelector('video')).toBeNull(); // offscreen cards fetch no media
    act(() => intersect([{ isIntersecting: true }]));
    fireEvent.loadedData(container.querySelector('video'));
    expect(screen.getByText('Ready to review')).toBeInTheDocument();
    fireEvent.error(container.querySelector('video'));
    expect(screen.queryByText('Ready to review')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play Imported draft · v2' }));
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toContain(src));
    fireEvent.error(container.querySelector('video'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(container.querySelector('video').getAttribute('src')).toBe(`${src}&retry=1`);
  });
  it('renders a bounded summary (no scenes/runs) the same as a full record (#10169)', () => {
    const { scenes, ...rest } = BASE_PROJECT;
    const summary = {
      ...rest,
      audioAnalysis: { bpm: 128 },
      midiTranscription: true,
      stage: 'board',
      spend: { spentUsd: 1.5, capUsd: 5 },
      shotSummary: '2 scenes',
      sceneCount: 2,
      clipCount: 1,
      frameCount: 2,
      preview: { kind: 'none', label: 'No render yet' },
    };
    render(<MusicVideoProjectCard project={summary} onSelect={vi.fn()} />);
    expect(screen.getByText('Board')).toBeInTheDocument();
    expect(screen.getByText('128 BPM')).toBeInTheDocument();
    expect(screen.getByText(/2 scenes · 1 clip/)).toBeInTheDocument();
    expect(screen.getByTitle('50% clips rendered')).toBeInTheDocument();
    expect(screen.getByText(/\$1\.50/)).toBeInTheDocument();
  });

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

describe('MusicVideoProjectCard run pill and version switcher', () => {
  it('shows the run pill and steps through versions', () => {
    const onVersionStep = vi.fn();
    render(
      <MusicVideoProjectCard
        project={{ ...BASE_PROJECT, autonomousRun: { status: 'awaiting-approval', awaiting: 'lyrics' } }}
        versionCount={3}
        versionIndex={0}
        onVersionStep={onVersionStep}
      />,
    );
    expect(screen.getByTestId('mv-run-pill-mv-card-1').textContent).toBe('Needs you');
    expect(screen.getByText('v2 of 3')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Older version'));
    expect(onVersionStep).toHaveBeenCalledWith(1);
    expect(screen.getByLabelText('Newer version').disabled).toBe(true);
  });
});
