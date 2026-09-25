import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const pollHarness = vi.hoisted(() => ({ callbacks: new Map() }));

vi.mock('../services/api', () => ({
  buildCodeAnimationPrompt: vi.fn(),
  generateCodeAnimationBrief: vi.fn(),
  getCodeAnimationJob: vi.fn(),
  getCodeAnimationOptions: vi.fn(),
  listCodeAnimationJobs: vi.fn().mockResolvedValue([]),
  listMoodBoardNames: vi.fn(),
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
vi.mock('../hooks/useAutoRefetch', () => ({
  useAutoRefetch: (callback, interval, { enabled }) => {
    if (enabled) pollHarness.callbacks.set(interval, callback);
    else pollHarness.callbacks.delete(interval);
  },
}));

import CodeAnimation from './CodeAnimation';
import {
  buildCodeAnimationPrompt,
  generateCodeAnimationBrief,
  getCodeAnimationJob,
  getCodeAnimationOptions,
  listMoodBoardNames,
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

describe('Code Animation page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pollHarness.callbacks.clear();
    localStorage.clear();
    getCodeAnimationOptions.mockResolvedValue(OPTIONS);
    listUniverseNames.mockResolvedValue([{ id: 'u1', name: 'Example Universe' }]);
    listUniverseStyles.mockResolvedValue([{ id: 'u1', name: 'Example Universe', influences: { embrace: ['ink wash'], avoid: ['photorealism'] } }]);
    listMoodBoardNames.mockResolvedValue([{ id: 'b1', name: 'Dusk' }]);
    buildCodeAnimationPrompt.mockResolvedValue({
      prompt: 'You are an award-winning creative coder…',
      attachments: [{ label: 'Night markets', origin: 'universe', url: '/data/image-refs/style-ref.png' }],
      frame: { width: 1920, height: 1080, fps: 30, durationSeconds: 20 },
      audioUrl: null,
      moodBoardId: 'b1',
    });
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

  it('keeps the artist\'s own style refinements when the writer asks for none', async () => {
    const user = userEvent.setup();
    generateCodeAnimationBrief.mockResolvedValue({
      brief: { title: '', concept: 'Fireflies gather over the water.', onScreenText: '', styleNotes: '' },
      moodBoardId: null,
      llm: { provider: 'api-1', model: null, runId: null },
    });
    await renderPage();
    await user.type(screen.getByLabelText(/style refinements/i), 'more fog');
    await user.type(screen.getByLabelText(/starting idea/i), 'fireflies');
    await user.click(screen.getByRole('button', { name: /write brief/i }));
    await waitFor(() => expect(generateCodeAnimationBrief).toHaveBeenCalled());
    expect(await screen.findByLabelText(/what happens/i)).toHaveValue('Fireflies gather over the water.');
    expect(screen.getByLabelText(/style refinements/i)).toHaveValue('more fog');
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

  it('keeps edits made after starting a generation when the first poll returns its input snapshot', async () => {
    const user = userEvent.setup();
    startCodeAnimationGeneration.mockResolvedValueOnce({
      id: 'job-1', status: 'running', prompt: 'Built prompt', input: { title: '', concept: 'Original concept' },
    });
    getCodeAnimationJob.mockResolvedValueOnce({
      id: 'job-1', status: 'running', prompt: 'Built prompt', input: { title: '', concept: 'Original concept' },
    });
    await renderPage();
    await user.type(screen.getByLabelText(/what happens/i), 'Original concept');
    await user.click(screen.getByRole('button', { name: /build prompt/i }));
    await screen.findByLabelText('Generated prompt');
    await user.click(screen.getByRole('button', { name: /generate animation/i }));
    await waitFor(() => expect(startCodeAnimationGeneration).toHaveBeenCalledOnce());
    await user.type(screen.getByLabelText(/^title/i), 'Edited after submit');

    await act(async () => pollHarness.callbacks.get(3_000)());

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
});
