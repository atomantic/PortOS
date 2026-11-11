import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/socket', () => ({ default: { connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
// The dock asks before it plays a document; this one stays in the isolated worker.
vi.mock('../../services/apiMusicVideo.js', async (original) => ({ ...(await original()), getMusicVideoCompositionPlayback: vi.fn(async () => ({ native: false })) }));

import PreviewDock from './PreviewDock.jsx';
import { PREVIEW_FILM_LOOK_KEY } from './PreviewFilmLook.jsx';

const project = {
  id: 'example', filmLook: { preset: 'super8', grain: 0.5 },
  composition: { mode: 'document', document: { directory: 'music-video/example/composition/doc' } },
  scenes: [{ sceneId: 'a', startSec: 0, endSec: 5 }],
};
const sources = [{ id: 'document', kind: 'document', label: 'Composition' }, { id: 'animatic', kind: 'animatic', label: 'Storyboard' }];
const renderDock = async () => {
  const view = render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl={null} /></MemoryRouter>);
  await screen.findByRole('button', { name: 'Film look' });
  // The button mounts after the playback read resolves, outside act, so its
  // storage subscription is still a pending passive effect. Flush it before a
  // test dispatches a cross-tab `storage` event, or that event can be missed.
  await act(async () => {});
  return view;
};
const pickSource = (value) => fireEvent.change(screen.getByLabelText('Preview source'), { target: { value } });

describe('preview film look', () => {
  it('keeps the viewer choice when switching between composition and storyboard modes', async () => {
    const { container } = await renderDock();
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Film look' }));
    pickSource('animatic');
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-film-look="exact"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Film look' }));
    expect(container.querySelector('[data-film-look]')).toBeNull();
    pickSource('document');
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('retains the choice between modes when storage is blocked', async () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('storage blocked'); },
      setItem() { throw new Error('storage blocked'); },
    });
    try {
      await renderDock();
      fireEvent.click(screen.getByRole('button', { name: 'Film look' }));
      pickSource('animatic');
      expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Film look' }));
      pickSource('document');
      expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'false');
    } finally {
      vi.unstubAllGlobals();
      // Clear the in-memory fallback even if an assertion above failed.
      fireEvent(window, new StorageEvent('storage', { key: PREVIEW_FILM_LOOK_KEY }));
    }
  });

  it('reflects a preference change made in another tab', async () => {
    await renderDock();
    globalThis.localStorage.setItem(PREVIEW_FILM_LOOK_KEY, 'on');
    fireEvent(window, new StorageEvent('storage', { key: PREVIEW_FILM_LOOK_KEY, newValue: 'on' }));
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'true');
    globalThis.localStorage.removeItem(PREVIEW_FILM_LOOK_KEY);
    fireEvent(window, new StorageEvent('storage', { key: null }));
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'false');
  });
});
