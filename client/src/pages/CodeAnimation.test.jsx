import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const socketHarness = vi.hoisted(() => ({ handlers: new Map() }));

vi.mock('../services/socket', () => ({ default: {
  emit: vi.fn(),
  on: vi.fn((event, handler) => {
    const handlers = socketHarness.handlers.get(event) || new Set();
    handlers.add(handler);
    socketHarness.handlers.set(event, handlers);
  }),
  off: vi.fn((event, handler) => socketHarness.handlers.get(event)?.delete(handler)),
} }));

vi.mock('../services/api', () => ({
  buildCodeAnimationPrompt: vi.fn(),
  generateCodeAnimationBrief: vi.fn(),
  getCodeAnimationJob: vi.fn(),
  getCodeAnimationOptions: vi.fn(),
  listCodeAnimationJobPage: vi.fn().mockResolvedValue({ items: [], total: 0, counts: { running: 0, completed: 0 }, nextCursor: null }),
  listMoodBoardNames: vi.fn(),
  listTracks: vi.fn().mockResolvedValue([]),
  listUniverseNames: vi.fn(),
  listUniverseStyles: vi.fn(),
  startCodeAnimationGeneration: vi.fn(),
  uploadFile: vi.fn(),
  uploadGalleryVideo: vi.fn(),
}));
vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'api-1', name: 'Example API', type: 'api', enabled: true }],
    selectedProviderId: 'api-1',
    selectedModel: '',
    availableModels: [],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

import CodeAnimation from './CodeAnimation';
import {
  buildCodeAnimationPrompt,
  generateCodeAnimationBrief,
  getCodeAnimationJob,
  listCodeAnimationJobPage,
  getCodeAnimationOptions,
  listMoodBoardNames,
  listTracks,
  listUniverseNames,
  listUniverseStyles,
  startCodeAnimationGeneration,
} from '../services/api';

const OPTIONS = {
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720p', '1080p'],
  renderers: ['auto', 'canvas2d'],
  limits: { durationMin: 3, durationMax: 180, fpsOptions: [24, 30, 60], referenceImagesMax: 8, seedIdeaMax: 2000 },
  messages: { ready: 'r', record: 'rec', recorded: 'done', progress: 'p', error: 'e' },
  audioGlobal: 'ANIMATION_AUDIO_URL',
  audioExtensions: ['mp3', 'wav'],
};

const renderPage = async (initialEntry = '/code-animation') => {
  const result = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/code-animation" element={<CodeAnimation />} />
        <Route path="/code-animation/:jobId" element={<CodeAnimation />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  return result;
};

const emitSocket = async (event, payload) => {
  await act(async () => {
    for (const handler of socketHarness.handlers.get(event) || []) handler(payload);
  });
};

const changeVisibility = async (value) => {
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

const runningJob = {
  id: 'job-1', status: 'running', title: 'Example animation',
  input: { title: 'Example animation', concept: 'A lantern rises' },
  prompt: 'Example prompt', createdAt: '2026-01-01T00:00:00.000Z',
};
const completedJob = {
  ...runningJob, status: 'completed', html: '<html><body>Finished animation</body></html>',
  audioUrl: '/api/uploads/example-audio.mp3',
  frame: { width: 1280, height: 720, durationSeconds: 20, fps: 30 },
};

describe('Code Animation page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socketHarness.handlers.clear();
    listCodeAnimationJobPage.mockResolvedValue({ items: [], total: 0, counts: { running: 0, completed: 0 }, nextCursor: null });
    localStorage.clear();
    getCodeAnimationOptions.mockResolvedValue(OPTIONS);
    listUniverseNames.mockResolvedValue([{ id: 'u1', name: 'Example Universe' }]);
    listUniverseStyles.mockResolvedValue([{ id: 'u1', name: 'Example Universe', influences: { embrace: ['ink wash'], avoid: ['photorealism'] } }]);
    listMoodBoardNames.mockResolvedValue([{ id: 'b1', name: 'Dusk' }]);
    listTracks.mockResolvedValue([]);
    buildCodeAnimationPrompt.mockResolvedValue({
      prompt: 'You are an award-winning creative coder…',
      attachments: [{ label: 'Night markets', origin: 'universe', url: '/data/image-refs/style-ref.png' }],
      frame: { width: 1920, height: 1080, fps: 30, durationSeconds: 20 },
      audioUrl: null,
      moodBoardId: 'b1',
    });
  });

  afterEach(() => vi.useRealTimers());

  it('restores a routed job, updates its preview on its event, and never polls', async () => {
    getCodeAnimationJob.mockResolvedValue(runningJob);
    await renderPage('/code-animation/job-1');
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Example animation');
    expect(screen.getByLabelText(/what happens/i)).toHaveValue('A lantern rises');
    expect(screen.getByLabelText('Generated prompt')).toHaveValue('Example prompt');
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(1);
    vi.useRealTimers();

    await emitSocket('code-animation:changed', { id: 'unrelated-job' });
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(1);
    getCodeAnimationJob.mockResolvedValue(completedJob);
    await emitSocket('code-animation:changed', { id: 'job-1' });
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Run with audio' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Example animation/ })).toHaveTextContent('Completed');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Preview without audio' }));
    expect(screen.getByTitle('Code animation preview')).toHaveAttribute('srcdoc', expect.stringContaining('Finished animation'));

    // Terminal records still reconcile: a missing output can be discovered later.
    getCodeAnimationJob.mockResolvedValue({ ...completedJob, status: 'failed', error: 'Output missing', html: null });
    await emitSocket('code-animation:changed', { id: 'job-1' });
    expect(screen.getByText('Generation failed: Output missing')).toBeInTheDocument();
    expect(screen.queryByTitle('Code animation preview')).not.toBeInTheDocument();
  });

  it('reconciles once per reconnect and tab re-show, including transient errors and missing jobs', async () => {
    getCodeAnimationJob.mockRejectedValueOnce(new Error('Temporary outage')).mockResolvedValue(runningJob);
    await renderPage('/code-animation/job-1');
    expect(screen.queryByText('That generation is no longer available.')).not.toBeInTheDocument();
    await emitSocket('connect');
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Example animation');
    await changeVisibility('hidden');
    await emitSocket('code-animation:changed', { id: 'job-1' });
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(2);
    getCodeAnimationJob.mockRejectedValueOnce({ status: 404, message: 'Missing' });
    await changeVisibility('visible');
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(3);
    expect(screen.getByText('That generation is no longer available.')).toBeInTheDocument();
    await changeVisibility('visible');
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(3);
  });

  it('drops a pending response after selecting another job and releases listeners on unmount', async () => {
    let resolveFirst;
    getCodeAnimationJob.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue({ ...runningJob, id: 'job-2', title: 'Second animation',
        input: { title: 'Second animation', concept: 'Another scene' } });
    listCodeAnimationJobPage.mockResolvedValue({ items: [{ ...runningJob, id: 'job-2', title: 'Second animation' }],
      total: 1, counts: { running: 1, completed: 0 }, nextCursor: null });
    const view = await renderPage('/code-animation/job-1');
    await userEvent.setup().click(screen.getByRole('link', { name: /Second animation/ }));
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Second animation');
    await act(async () => resolveFirst(completedJob));
    expect(screen.getByLabelText(/^title/i)).toHaveValue('Second animation');
    expect(screen.queryByRole('button', { name: 'Run with audio' })).not.toBeInTheDocument();
    await emitSocket('code-animation:changed', { id: 'job-1' });
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(2);
    view.unmount();
    await emitSocket('code-animation:changed', { id: 'job-2' });
    await emitSocket('connect');
    expect(getCodeAnimationJob).toHaveBeenCalledTimes(2);
  });

  it('recovers from a parseable but malformed saved draft', async () => {
    localStorage.setItem('portos.codeAnimation.draft', JSON.stringify({
      title: { text: 'not a string' },
      audio: { filename: 42 },
      format: null,
      referenceImages: null,
    }));

    await renderPage();

    expect(screen.getByLabelText(/^title/i)).toHaveValue('');
    expect(screen.getByText('Reference images (0/8)')).toBeInTheDocument();
  });

  it('loads one compact page, stays idle, and refreshes on durable changes and reconnect', async () => {
    const jobs = Array.from({ length: 50 }, (_, n) => ({
      id: `job-${n}`, status: 'completed', title: `Animation ${n}`, createdAt: '2026-01-01T00:00:00.000Z',
    }));
    listCodeAnimationJobPage.mockResolvedValue({ items: jobs, total: 1000,
      counts: { running: 0, completed: 1000 }, nextCursor: 'next-page' });
    await renderPage();
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Animation \d+/ })).toHaveLength(50));
    expect(listCodeAnimationJobPage).toHaveBeenCalledTimes(1);
    expect(screen.getByText('0 in progress · 1,000 completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older animations' })).toBeInTheDocument();
    vi.useFakeTimers();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    vi.useRealTimers();
    expect(listCodeAnimationJobPage).toHaveBeenCalledTimes(1);
    await act(async () => { for (const handler of socketHarness.handlers.get('code-animation:changed') || []) handler({ id: 'job-0' }); });
    await waitFor(() => expect(listCodeAnimationJobPage).toHaveBeenCalledTimes(2));
    await act(async () => { for (const handler of socketHarness.handlers.get('connect') || []) handler(); });
    await waitFor(() => expect(listCodeAnimationJobPage).toHaveBeenCalledTimes(3));
  });

  it('builds a universe-styled prompt that follows the universe mood board by default', async () => {
    const user = userEvent.setup();
    await renderPage();
    const build = screen.getByRole('button', { name: /build prompt/i });
    expect(build).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/universe \(sets the art style\)/i), 'u1');
    expect(screen.getByText('ink wash')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/what happens/i), 'A lantern drifts over a harbor');
    await user.click(build);

    await waitFor(() => expect(buildCodeAnimationPrompt).toHaveBeenCalledTimes(1));
    const brief = buildCodeAnimationPrompt.mock.calls[0][0];
    expect(brief).toMatchObject({ universeId: 'u1', concept: 'A lantern drifts over a harbor' });
    expect('moodBoardId' in brief).toBe(false);
    expect(await screen.findByLabelText('Generated prompt')).toHaveValue('You are an award-winning creative coder…');
    expect(screen.getByText(/Using the universe's mood board: Dusk/)).toBeInTheDocument();
    expect(screen.getByAltText('Night markets')).toHaveAttribute('src', '/data/image-refs/style-ref.png');

    // Editing the brief marks the built prompt stale until it is rebuilt.
    await user.type(screen.getByLabelText(/style refinements/i), 'more fog');
    expect(screen.getByText(/brief changed since this prompt was built/i)).toBeInTheDocument();
  });

  it('writes the brief from the universe and drops it into the form', async () => {
    const user = userEvent.setup();
    generateCodeAnimationBrief.mockResolvedValue({
      brief: {
        title: 'The Brass Wick',
        concept: 'Mira climbs the flooded arcade as the lamps go out.',
        cast: 'Mira — tall, oil-stained coat',
        onScreenText: '0:02 "One light remains"',
        styleNotes: 'colder blues at the climax',
      },
      moodBoardId: 'b1',
      llm: { provider: 'api-1', model: null, runId: 'run-b' },
    });
    await renderPage();
    const write = screen.getByRole('button', { name: /write brief/i });
    // Nothing to be faithful to yet — no universe, no spark, no words.
    expect(write).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/universe \(sets the art style\)/i), 'u1');
    await user.type(screen.getByLabelText(/starting idea/i), 'a chase that ends in silence');
    await user.click(write);

    await waitFor(() => expect(generateCodeAnimationBrief).toHaveBeenCalledTimes(1));
    expect(generateCodeAnimationBrief.mock.calls[0][0]).toMatchObject({
      universeId: 'u1',
      seedIdea: 'a chase that ends in silence',
      providerId: 'api-1',
      current: { title: '', concept: '' },
    });
    expect(await screen.findByLabelText(/what happens/i)).toHaveValue('Mira climbs the flooded arcade as the lamps go out.');
    expect(screen.getByLabelText(/^title/i)).toHaveValue('The Brass Wick');
    expect(screen.getByLabelText(/^characters/i)).toHaveValue('Mira — tall, oil-stained coat');
    expect(screen.getByLabelText(/on-screen text/i)).toHaveValue('0:02 "One light remains"');
    expect(screen.getByLabelText(/style refinements/i)).toHaveValue('colder blues at the climax');
  });

  it('keeps the artist\'s own style refinements and characters when the writer adds none', async () => {
    const user = userEvent.setup();
    generateCodeAnimationBrief.mockResolvedValue({
      brief: { title: '', concept: 'Fireflies gather over the water.', cast: '', onScreenText: '', styleNotes: '' },
      moodBoardId: null,
      llm: { provider: 'api-1', model: null, runId: null },
    });
    await renderPage();
    await user.type(screen.getByLabelText(/style refinements/i), 'more fog');
    await user.type(screen.getByLabelText(/^characters/i), 'Wick, a paper lantern');
    await user.type(screen.getByLabelText(/starting idea/i), 'fireflies');
    await user.click(screen.getByRole('button', { name: /write brief/i }));
    await waitFor(() => expect(generateCodeAnimationBrief).toHaveBeenCalled());
    expect(await screen.findByLabelText(/what happens/i)).toHaveValue('Fireflies gather over the water.');
    expect(screen.getByLabelText(/style refinements/i)).toHaveValue('more fog');
    expect(screen.getByLabelText(/^characters/i)).toHaveValue('Wick, a paper lantern');
  });

  it('preserves brief fields edited while Write Brief is in flight', async () => {
    const user = userEvent.setup();
    let resolveBrief;
    generateCodeAnimationBrief.mockImplementationOnce(() => new Promise((resolve) => { resolveBrief = resolve; }));
    await renderPage();
    await user.type(screen.getByLabelText(/starting idea/i), 'A quiet departure');
    await user.click(screen.getByRole('button', { name: /write brief/i }));

    await user.type(screen.getByLabelText(/^title/i), 'My title');
    await user.type(screen.getByLabelText(/what happens/i), 'My concept');
    await user.type(screen.getByLabelText(/on-screen text/i), 'My text');
    await user.type(screen.getByLabelText(/style refinements/i), 'My style');

    await act(async () => resolveBrief({
      brief: { title: 'Generated title', concept: 'Generated concept', onScreenText: 'Generated text', styleNotes: 'Generated style' },
    }));

    expect(screen.getByLabelText(/^title/i)).toHaveValue('My title');
    expect(screen.getByLabelText(/what happens/i)).toHaveValue('My concept');
    expect(screen.getByLabelText(/on-screen text/i)).toHaveValue('My text');
    expect(screen.getByLabelText(/style refinements/i)).toHaveValue('My style');
  });

  it('keeps edits made after starting a generation when an invalidation returns its input snapshot', async () => {
    const user = userEvent.setup();
    startCodeAnimationGeneration.mockResolvedValueOnce({
      id: 'job-1', status: 'running', prompt: 'Built prompt', input: { title: '', concept: 'Original concept' },
    });
    getCodeAnimationJob.mockResolvedValue({
      id: 'job-1', status: 'running', prompt: 'Built prompt', input: { title: '', concept: 'Original concept' },
    });
    await renderPage();
    await user.type(screen.getByLabelText(/what happens/i), 'Original concept');
    await user.click(screen.getByRole('button', { name: /build prompt/i }));
    await screen.findByLabelText('Generated prompt');
    await user.click(screen.getByRole('button', { name: /generate animation/i }));
    await waitFor(() => expect(startCodeAnimationGeneration).toHaveBeenCalledOnce());
    await user.type(screen.getByLabelText(/^title/i), 'Edited after submit');

    await emitSocket('code-animation:changed', { id: 'job-1' });

    expect(screen.getByLabelText(/^title/i)).toHaveValue('Edited after submit');
  });

  it('sends an explicit empty board when the user opts out of a mood board', async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.type(screen.getByLabelText(/what happens/i), 'Fireflies');
    await user.selectOptions(screen.getByLabelText('Mood board'), 'none');
    await user.click(screen.getByRole('button', { name: /build prompt/i }));
    await waitFor(() => expect(buildCodeAnimationPrompt).toHaveBeenCalled());
    expect(buildCodeAnimationPrompt.mock.calls[0][0].moodBoardId).toBe('');
  });

  it('picks a track from the music library, shows library badge, and sends track audio in brief', async () => {
    const user = userEvent.setup();
    listTracks.mockResolvedValue([
      { id: 'track-1', title: 'Neon Rain', audioFilename: 'neon-rain.mp3', durationSec: 42.5 },
    ]);
    await renderPage();

    expect(screen.getByRole('button', { name: /pick from music library/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /pick from music library/i }));

    expect(screen.getByText('Pick soundtrack track')).toBeInTheDocument();
    expect(screen.getByText('Neon Rain')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: /select neon rain/i }));
    await user.click(screen.getByRole('button', { name: /select track/i }));

    expect(screen.getByText('Neon Rain')).toBeInTheDocument();
    expect(screen.getByText('42.5s')).toBeInTheDocument();
    expect(screen.getByText('Library track')).toBeInTheDocument();

    await user.type(screen.getByLabelText(/what happens/i), 'Robots dancing');
    await user.click(screen.getByRole('button', { name: /build prompt/i }));
    await waitFor(() => expect(buildCodeAnimationPrompt).toHaveBeenCalled());
    expect(buildCodeAnimationPrompt.mock.calls[0][0].audio).toEqual({
      source: 'track',
      trackId: 'track-1',
      label: 'Neon Rain',
      durationSeconds: 42.5,
      notes: '',
    });

    await user.click(screen.getByRole('button', { name: /remove audio track/i }));
    expect(screen.getByRole('button', { name: /pick from music library/i })).toBeInTheDocument();
  });

  it('restores draft with library track audio from localStorage', async () => {
    localStorage.setItem('portos.codeAnimation.draft', JSON.stringify({
      audio: {
        source: 'track',
        trackId: 'track-stored',
        label: 'Ambient Drone',
        durationSeconds: 60,
      },
    }));

    await renderPage();

    expect(screen.getByText('Ambient Drone')).toBeInTheDocument();
    expect(screen.getByText('60.0s')).toBeInTheDocument();
    expect(screen.getByText('Library track')).toBeInTheDocument();
  });
});
