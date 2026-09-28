import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import PromptFromMedia from './PromptFromMedia';
import * as api from '../../services/apiMediaJobs';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));

vi.mock('../../hooks/useProviderModels', () => ({
  default: vi.fn(() => ({
    providers: [
      { id: 'openai', name: 'OpenAI', type: 'api', enabled: true, defaultModel: 'gpt-4o' },
    ],
    selectedProviderId: 'openai',
    selectedModel: 'gpt-4o',
    availableModels: ['gpt-4o'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  })),
}));

vi.mock('../../hooks/useVisionModelIds', () => ({
  default: () => ({ idsByProvider: null, loaded: true }),
}));

vi.mock('../../services/apiMediaJobs', () => ({
  promptFromMedia: vi.fn(),
  listMediaPromptExaminations: vi.fn(async () => ({ items: [], hasMore: false })),
  getMediaPromptExamination: vi.fn(),
}));

vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../videoGen/GalleryVideoPicker', () => ({ default: () => null }));

const INITIAL = {
  kind: 'image',
  filename: 'still.png',
  previewUrl: '/data/images/still.png',
  prompt: 'a reference still',
};

function renderPanel(props = {}) {
  return render(
    <MemoryRouter>
      <PromptFromMedia
        kindDefault="image"
        applyKind="image"
        initialSource={INITIAL}
        setPrompt={vi.fn()}
        setNegativePrompt={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe('PromptFromMedia', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the selected still to a vision provider and applies the image prompt', async () => {
    const setPrompt = vi.fn();
    const setNegativePrompt = vi.fn();
    vi.mocked(api.promptFromMedia).mockResolvedValue({
      imagePrompt: 'moonlit painted wizard',
      imageNegativePrompt: 'blurry',
      rationale: 'Painted moonlight look.',
    });

    renderPanel({ setPrompt, setNegativePrompt });

    fireEvent.click(screen.getByRole('button', { name: /create prompt/i }));

    await waitFor(() => {
      expect(api.promptFromMedia).toHaveBeenCalledWith({
        sourceKind: 'image',
        filename: 'still.png',
        videoId: undefined,
        targets: ['image'],
        providerId: 'openai',
        model: 'gpt-4o',
        effort: undefined,
      });
    });

    fireEvent.click(screen.getByRole('button', { name: /use as prompt/i }));
    expect(setPrompt).toHaveBeenCalledWith('moonlit painted wizard');
    expect(setNegativePrompt).toHaveBeenCalledWith('blurry');
  });

  it('can request both image and video prompts from a gallery clip', async () => {
    vi.mocked(api.promptFromMedia).mockResolvedValue({
      imagePrompt: 'a still of the clip',
      videoPrompt: 'the camera dollies past the subject',
    });

    renderPanel({
      kindDefault: 'both',
      applyKind: undefined,
      initialSource: { kind: 'video', id: 'vid-1', filename: 'vid-1.mp4', previewUrl: '/data/video-thumbnails/t.jpg' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create prompt/i }));

    await waitFor(() => {
      expect(api.promptFromMedia).toHaveBeenCalledWith(expect.objectContaining({
        sourceKind: 'video',
        videoId: 'vid-1',
        targets: ['image', 'video'],
      }));
    });
    expect(screen.getByText('the camera dollies past the subject')).toBeInTheDocument();
  });

  it('notifies the host via onResult and sends a filename-only clip without a videoId (#4188)', async () => {
    const onResult = vi.fn();
    const payload = {
      videoPrompt: 'a slow dolly through fog',
      videoNegativePrompt: 'jitter',
      rationale: 'Foggy push-in.',
      providerId: 'openai',
      model: 'gpt-4o',
    };
    vi.mocked(api.promptFromMedia).mockResolvedValue(payload);

    renderPanel({
      kindDefault: 'video',
      applyKind: undefined,
      onResult,
      // A mood-board video item resolves by on-disk filename — no history id.
      initialSource: { kind: 'video', filename: 'clip.mp4', previewUrl: '/data/video-thumbnails/clip.jpg' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create prompt/i }));

    await waitFor(() => {
      expect(api.promptFromMedia).toHaveBeenCalledWith(expect.objectContaining({
        sourceKind: 'video',
        videoId: undefined,
        filename: 'clip.mp4',
        targets: ['video'],
      }));
    });
    expect(onResult).toHaveBeenCalledWith(payload);
  });

  it('skips the disclosure toggle when hosted as an always-open card', async () => {
    renderPanel({ alwaysOpen: true, initialSource: null });
    await screen.findByText('No saved examinations yet.');
    expect(screen.queryByRole('button', { name: /toggle prompt from media/i })).toBeNull();
    expect(screen.getByRole('button', { name: /pick image/i })).toBeInTheDocument();
  });
});

// Returning from either renderer restores the complete examination without a provider call.
it('reopens both saved prompts from a durable examination URL', async () => {
  api.getMediaPromptExamination.mockResolvedValue({
    id: 'saved', source: { sourceKind: 'image', filename: 'still.png' },
    result: { imagePrompt: 'Moonlit mountains', videoPrompt: 'Clouds drift over mountains', imageNegativePrompt: 'blur' },
  });
  render(<MemoryRouter initialEntries={['/media/prompt/saved']}><Routes>
    <Route path="/media/prompt/:examinationId" element={<PromptFromMedia alwaysOpen />} />
  </Routes></MemoryRouter>);
  await screen.findByDisplayValue('Moonlit mountains');
  expect(screen.getByDisplayValue('Clouds drift over mountains')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open in Image Gen' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open in Video Gen' })).toBeTruthy();
  expect(api.promptFromMedia).not.toHaveBeenCalled();
});

it('does not duplicate a saved examination already received through history refresh', async () => {
  api.listMediaPromptExaminations.mockResolvedValueOnce({
    items: [{ id: 'saved', source: { filename: 'still.png' }, createdAt: '2026-01-01T00:00:00Z' }], hasMore: false,
  });
  api.promptFromMedia.mockResolvedValueOnce({ imagePrompt: 'Mountains', examinationId: 'saved' });
  renderPanel();
  await screen.findByText(/still.png ·/);
  fireEvent.click(screen.getByRole('button', { name: 'Create prompt' }));
  await screen.findByDisplayValue('Mountains');
  expect(screen.getAllByText(/still.png ·/)).toHaveLength(1);
});
