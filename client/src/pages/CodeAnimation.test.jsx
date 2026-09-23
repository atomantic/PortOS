import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  buildCodeAnimationPrompt: vi.fn(),
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
