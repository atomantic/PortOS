import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  buildCodeAnimationPrompt: vi.fn(),
  generateCodeAnimationBrief: vi.fn(),
  getCodeAnimationJob: vi.fn(),
  getCodeAnimationOptions: vi.fn(),
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

import CodeAnimation from './CodeAnimation';
import {
  buildCodeAnimationPrompt,
  generateCodeAnimationBrief,
  getCodeAnimationOptions,
  listMoodBoardNames,
  listUniverseNames,
  listUniverseStyles,
} from '../services/api';

const OPTIONS = {
  aspectRatios: ['16:9', '9:16'],
  resolutions: ['720p', '1080p'],
  renderers: ['auto', 'canvas2d'],
  limits: { durationMin: 3, durationMax: 180, fpsOptions: [24, 30, 60], referenceImagesMax: 8 },
  briefLimits: { seedIdeaMax: 2000 },
  messages: { ready: 'r', record: 'rec', recorded: 'done', progress: 'p', error: 'e' },
  audioGlobal: 'ANIMATION_AUDIO_URL',
  audioExtensions: ['mp3', 'wav'],
};

const renderPage = async () => {
  const result = render(<MemoryRouter initialEntries={['/code-animation']}><CodeAnimation /></MemoryRouter>);
  await act(async () => {});
  return result;
};

describe('Code Animation page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
