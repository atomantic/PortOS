import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import MediaPreview from './MediaPreview';
import usePreviewRoute from '../../hooks/usePreviewRoute';
import { updateVideoPrompt } from '../../services/apiImageVideo';

vi.mock('../../services/apiImageVideo', () => ({
  updateImagePrompt: vi.fn(),
  updateVideoPrompt: vi.fn(),
}));

// Keep this test focused on the wrapper's save/state contract. The lightbox has
// its own interaction coverage; this stub exposes the item it receives and
// invokes the same callback the real Save prompt button uses.
vi.mock('./MediaLightbox', () => ({
  default: ({ item, onPromptChange }) => item ? (
    <div data-testid="lightbox">
      <span data-testid="lightbox-prompt">{item.prompt}</span>
      <button type="button" onClick={() => onPromptChange(item, 'a saved prompt')}>
        Save prompt
      </button>
    </div>
  ) : null,
}));

const VIDEO = {
  kind: 'video',
  key: 'video:video-1',
  id: 'video-1',
  filename: 'video-1.mp4',
  prompt: '(no prompt)',
  raw: { id: 'video-1', filename: 'video-1.mp4' },
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function PromptSaveHarness({ syncCard = true }) {
  const [items, setItems] = useState([VIDEO]);
  const [preview, setPreview] = usePreviewRoute(items);
  const handlePromptSaved = (item, prompt) => {
    setItems((current) => current.map((candidate) => candidate.key === item.key
      ? { ...candidate, prompt }
      : candidate));
  };
  return (
    <>
      <button type="button" onClick={() => setPreview(items[0])}>Open video</button>
      <p data-testid="card-prompt">{items[0].prompt}</p>
      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={items}
        onPromptSaved={syncCard ? handlePromptSaved : undefined}
      />
      <LocationProbe />
    </>
  );
}

describe('MediaPreview prompt saving', () => {
  beforeEach(() => {
    updateVideoPrompt.mockReset();
    updateVideoPrompt.mockResolvedValue({ id: VIDEO.id, prompt: 'a saved prompt' });
  });

  it('updates the card and modal immediately without treating the URL setter as React state', async () => {
    render(
      <MemoryRouter>
        <PromptSaveHarness />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open video' }));
    expect(screen.getByTestId('lightbox-prompt')).toHaveTextContent('(no prompt)');

    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => {
      expect(updateVideoPrompt).toHaveBeenCalledWith('video-1', 'a saved prompt', { silent: true });
      expect(screen.getByTestId('card-prompt')).toHaveTextContent('a saved prompt');
      expect(screen.getByTestId('lightbox-prompt')).toHaveTextContent('a saved prompt');
    });
    expect(screen.getByTestId('location')).toHaveTextContent('preview=video%3Avideo-1');
  });

  it('keeps the saved prompt visible when the host has no card-state callback', async () => {
    render(
      <MemoryRouter>
        <PromptSaveHarness syncCard={false} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open video' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save prompt' }));

    await waitFor(() => {
      expect(screen.getByTestId('lightbox-prompt')).toHaveTextContent('a saved prompt');
    });
    expect(screen.getByTestId('lightbox')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('preview=video%3Avideo-1');
  });
});
