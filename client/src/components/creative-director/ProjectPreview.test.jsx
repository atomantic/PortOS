/**
 * Tests for ProjectPreview's audio branch (#2772): a `music` commission whose
 * output is a `project.musicBed` track renders a playable <audio> element in the
 * list card / commission run preview, so the run is rateable in place.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The audio branch never touches these, but the module imports them — stub so
// the test stays a unit of ProjectPreview's own branch selection.
vi.mock('../MediaImage.jsx', () => ({ default: () => <div data-testid="media-image" /> }));
vi.mock('./ScenePreview.jsx', () => ({ default: () => <div data-testid="scene-preview" /> }));
vi.mock('../../services/apiImageVideo.js', () => ({ listVideoHistory: vi.fn(async () => []) }));

import ProjectPreview from './ProjectPreview.jsx';

const renderPreview = (project) =>
  render(
    <MemoryRouter>
      <ProjectPreview project={project} to="/creative-director/cd-music-1" />
    </MemoryRouter>,
  );

describe('ProjectPreview audio branch (#2772)', () => {
  it('renders a playable audio element for a project with a music bed', () => {
    renderPreview({
      id: 'cd-music-1',
      name: 'Example Score',
      musicBed: { filename: 'music-gen-xyz.wav', durationSec: 30.4, engine: 'musicgen' },
    });
    const audio = document.querySelector('audio');
    expect(audio).toBeTruthy();
    expect(audio.getAttribute('src')).toBe('/data/music/music-gen-xyz.wav');
    // Duration is surfaced next to the label so the run reads as a finished asset.
    expect(screen.getByText(/Music bed · 30s/)).toBeTruthy();
    // No video play affordance for an audio result.
    expect(screen.queryByRole('button', { name: /Play/i })).toBeNull();
  });

  it('links the audio card to the project detail route', () => {
    renderPreview({ id: 'cd-music-1', name: 'Example Score', musicBed: { filename: 'm.wav' } });
    const link = screen.getByRole('link', { name: /Open Example Score/i });
    expect(link.getAttribute('href')).toBe('/creative-director/cd-music-1');
  });

  it('shows the no-render state when nothing has been produced', () => {
    renderPreview({ id: 'cd-1', name: 'Empty' });
    expect(screen.getByText(/no render yet/i)).toBeTruthy();
    expect(document.querySelector('audio')).toBeNull();
  });
});
