import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import MusicVideoProjectCard from './MusicVideoProjectCard.jsx';
import { summarizeMusicVideoProject } from '../../../../server/lib/musicVideoSummary.js';
import { autopilotStatus, deriveNextAction, deriveStages, describeProjectStatus } from '../../lib/musicVideoStages.js';
import { deriveAttentionItems } from '../../lib/musicVideoAttention.js';

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
    expect(screen.getByText('Storyboard')).toBeInTheDocument();
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

  it('offers the footer as the single project entry on every preview surface', () => {
    const src = '/api/music-video/example/dev-artifacts/film/file?version=2';
    const cases = {
      placeholder: { ...BASE_PROJECT, preview: { kind: 'none', source: null } },
      image: { ...BASE_PROJECT, preview: { kind: 'image', source: 'frame', src: '/data/images/example.png', label: 'Frame' } },
      video: { ...BASE_PROJECT, preview: { kind: 'video', source: 'draft', jobId: 'job-1', poster: '/data/images/example.png', label: 'Draft' } },
      final: { ...BASE_PROJECT, preview: { kind: 'video', source: 'final', jobId: 'job-1', poster: '/data/images/example.png', label: 'Final' } },
      imported: { ...BASE_PROJECT, preview: { kind: 'video', source: 'animatic', artifactId: 'film', version: 2, src, poster: null, label: 'Imported draft · v2', reviewStatus: 'pending' } },
    };
    for (const [name, project] of Object.entries(cases)) {
      const onSelect = vi.fn(), onReview = vi.fn();
      const { unmount } = render(<MusicVideoProjectCard project={project} onSelect={onSelect} onReview={name === 'final' || name === 'imported' ? onReview : undefined} />);
      expect(screen.getByRole('heading', { name: 'Cyber Horizon' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cyber Horizon' })).toBeNull();
      expect(screen.queryByRole('button', { name: /Open project/ })).toBeNull();
      const entry = screen.getByRole('button', { name: /^(Open|Review video|Review draft)\b/ });
      fireEvent.click(entry);
      const expected = name === 'final' || name === 'imported' ? onReview : onSelect;
      expect(expected).toHaveBeenCalledTimes(1);
      unmount();
    }
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


describe('completed project with an old stills checkpoint', () => {
  const finished = () => ({
    ...BASE_PROJECT, status: 'complete', renderHistoryId: 'example-final',
    renderDependencyState: { status: 'current' },
    scenes: [{ sceneId: 's1', referenceImageId: 'example-frame', videoHistoryId: 'example-clip' }],
    productionReadiness: { art: { approved: true }, storyboard: { approved: true }, proof: { approved: false } },
    publishKit: { builtAt: '2026-01-01', posts: { example: { url: 'https://example.com/video' } } },
    autonomousRun: { id: 'auto-example', status: 'awaiting-approval', awaiting: 'stills', stage: 'produce', output: { productionRunId: 'production-example' } },
    productionRuns: [{ id: 'production-example', status: 'awaiting-video' }],
  });

  it('keeps the summary card, full card and header past the obsolete checkpoint without changing run history', () => {
    const project = finished();
    const original = structuredClone(project);
    const summary = summarizeMusicVideoProject(project, project.productionReadiness);
    expect(summary).toMatchObject({ status: 'complete', runStatus: 'awaiting-approval', runAwaiting: false });
    const { rerender } = render(<MusicVideoProjectCard project={summary} />);
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
    rerender(<MusicVideoProjectCard project={project} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Done');
    const progress = deriveStages(project);
    const nextAction = deriveNextAction(project);
    expect(nextAction.id).toBe('goto-publish');
    expect(describeProjectStatus(project, { progress, nextAction })).toMatchObject({ headline: 'Published', needsYouStage: null });
    expect(autopilotStatus(project).short).toBe('Autopilot');
    expect(deriveAttentionItems(project)).toEqual([]);
    expect(project).toEqual(original);
  });

  it.each([
    ['incomplete project', (p) => { p.status = 'ready'; p.renderHistoryId = null; }],
    ['stale final', (p) => { p.renderDependencyState.status = 'stale'; }],
    ['unverified final', (p) => { delete p.renderDependencyState; }],
    ['unapproved storyboard', (p) => { p.productionReadiness.storyboard.approved = false; }],
    ['changed art approval', (p) => { p.productionReadiness.art.stale = { changed: [] }; }],
    ['different checkpoint', (p) => { p.autonomousRun.awaiting = 'song'; }],
    ['failed child', (p) => { p.productionRuns[0].status = 'failed'; }],
    ['child needing review', (p) => { p.productionRuns[0].status = 'needs-human'; }],
    ['unrelated child', (p) => { p.autonomousRun.output.productionRunId = 'different-run'; }],
  ])('retains actionable attention for %s in both card payloads', (_label, change) => {
    const project = finished();
    change(project);
    const summary = summarizeMusicVideoProject(project, project.productionReadiness);
    expect(summary.runAwaiting).toBe(true);
    const { rerender } = render(<MusicVideoProjectCard project={summary} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
    rerender(<MusicVideoProjectCard project={project} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
    expect(deriveAttentionItems(project).some((item) => item.kind === 'autonomous')).toBe(true);
  });

  it('preserves failures, live work, interruptions and unrelated revision attention after a final render', () => {
    const project = finished();
    const { rerender } = render(<MusicVideoProjectCard project={{ ...project, autonomousRun: { ...project.autonomousRun, status: 'failed' } }} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
    rerender(<MusicVideoProjectCard project={{ ...project, productionRuns: [], autonomousRun: { ...project.autonomousRun, status: 'running' } }} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Running');
    for (const target of ['autonomousRun', 'productionRuns']) {
      const interrupted = structuredClone(project);
      (target === 'autonomousRun' ? interrupted.autonomousRun : interrupted.productionRuns[0]).interrupted = true;
      rerender(<MusicVideoProjectCard project={interrupted} />);
      expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Interrupted');
      expect(summarizeMusicVideoProject(interrupted, interrupted.productionReadiness).runInterrupted).toBe(true);
    }
    const revised = { ...project, revisions: [{ id: 'revision-example', status: 'open', sections: [] }] };
    rerender(<MusicVideoProjectCard project={revised} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
    expect(deriveAttentionItems(revised).map((item) => item.kind)).toContain('revision');
    rerender(<MusicVideoProjectCard project={summarizeMusicVideoProject(revised, revised.productionReadiness)} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
    const otherRun = { ...project, productionRuns: [...project.productionRuns, { id: 'other-run', status: 'blocked' }] };
    rerender(<MusicVideoProjectCard project={otherRun} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
    rerender(<MusicVideoProjectCard project={summarizeMusicVideoProject(otherRun, otherRun.productionReadiness)} />);
    expect(screen.getByTestId('mv-run-pill-mv-card-1')).toHaveTextContent('Needs you');
  });
});
