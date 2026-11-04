import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../services/socket', () => ({ default: { connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));

import PreviewDock from './PreviewDock.jsx';
import { PREVIEW_FILM_LOOK_KEY } from './PreviewFilmLook.jsx';

const project = {
  id: 'example', filmLook: { preset: 'super8', grain: 0.5 },
  composition: { mode: 'document', document: { directory: 'music-video/example/composition/doc' } },
  scenes: [{ sceneId: 'a', startSec: 0, endSec: 5 }],
};
const sources = [{ id: 'document', kind: 'document', label: 'Composition' }, { id: 'animatic', kind: 'animatic', label: 'Storyboard' }];
const renderDock = () => render(<MemoryRouter><PreviewDock project={project} sources={sources} audioUrl={null} /></MemoryRouter>);
const pickSource = (value) => fireEvent.change(screen.getByLabelText('Preview source'), { target: { value } });

describe('preview film look', () => {
  it('keeps the viewer choice when switching between composition and storyboard modes', () => {
    const { container } = renderDock();
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

  it('retains the choice between modes when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('storage blocked'); },
      setItem() { throw new Error('storage blocked'); },
    });
    try {
      renderDock();
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

  it('reflects a preference change made in another tab', () => {
    renderDock();
    globalThis.localStorage.setItem(PREVIEW_FILM_LOOK_KEY, 'on');
    fireEvent(window, new StorageEvent('storage', { key: PREVIEW_FILM_LOOK_KEY, newValue: 'on' }));
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'true');
    globalThis.localStorage.removeItem(PREVIEW_FILM_LOOK_KEY);
    fireEvent(window, new StorageEvent('storage', { key: null }));
    expect(screen.getByRole('button', { name: 'Film look' })).toHaveAttribute('aria-pressed', 'false');
  });
});
