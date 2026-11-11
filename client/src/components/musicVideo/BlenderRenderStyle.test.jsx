import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoShotRenders: vi.fn(), updateMusicVideoProject: vi.fn() }));
// The panels themselves have their own suites; this one pins which of them a render style mounts.
vi.mock('./BlenderFilmPanel.jsx', () => ({ default: () => <div data-testid="blender-film" />, FILM_LOOK_ANCHOR: 'mv-film-look' }));
vi.mock('./FilmLookPanel.jsx', () => ({ default: () => <div data-testid="film-look" /> }));
vi.mock('./TypographyPanel.jsx', () => ({ default: () => <div data-testid="typography" /> }));

import CompositionPanel from './CompositionPanel.jsx';
import { GenerationActions, RenderFinalButton, RenderStyleSelect } from './ProjectActionGroups.jsx';
import { RENDER_STYLES, RENDER_STYLE_HELP, renderStyleLabel } from './compositionDraft.js';
import { blenderFilmProject } from '../../test/blenderFilmFixture.js';

const board = (project) => ({
  project, locked: false, audioUrl: null, renderJob: { active: false }, activeSceneId: null,
  openSettings: vi.fn(), goToStage: vi.fn(), editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), saveCompositionGrade: vi.fn(), replaceProject: vi.fn(),
});

beforeEach(() => { vi.clearAllMocks(); });

describe('Blender film render style', () => {
  it('is offered beside the other styles, with its own help line', () => {
    expect(RENDER_STYLES.map(([value]) => value)).toEqual(['concat', 'composed', 'code', 'document', 'eidoverse', 'blender']);
    expect(renderStyleLabel('blender')).toBe('Blender film');
    // Every style explains itself beside the picker.
    for (const [value] of RENDER_STYLES) expect(RENDER_STYLE_HELP[value]).toBeTruthy();
    const onRenderStyle = vi.fn();
    render(<RenderStyleSelect project={blenderFilmProject({ composition: { mode: 'concat' } })} onRenderStyle={onRenderStyle} />);
    fireEvent.change(screen.getByLabelText('Render style'), { target: { value: 'blender' } });
    expect(onRenderStyle).toHaveBeenCalledWith('blender');
  });

  it('leads the composition with the film panel, keeps Film look, and drops typography and the draft-excerpt hint', () => {
    const view = render(<CompositionPanel board={board(blenderFilmProject())} />);
    expect(screen.getByTestId('blender-film')).toBeInTheDocument();
    // The finishing pass still runs over a Blender film's final render, and the panel links here.
    expect(document.getElementById('mv-film-look')).toContainElement(screen.getByTestId('film-look'));
    expect(screen.queryByTestId('typography')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Render grade' })).toBeNull();
    expect(screen.queryByText(/No live preview for this style/)).toBeNull();
    expect(screen.getByText('Blender film')).toBeInTheDocument();

    view.rerender(<CompositionPanel board={board(blenderFilmProject({ composition: { mode: 'composed', textCues: [] } }))} />);
    expect(screen.queryByTestId('blender-film')).toBeNull();
    expect(screen.getByTestId('film-look')).toBeInTheDocument();
    expect(screen.getByTestId('typography')).toBeInTheDocument();
  });

  it('renders the final only once every shot has a current final render, and leaves the call to the server while that is unknown', () => {
    const renderJob = { start: vi.fn(), active: false };
    const readiness = { readyForProduction: true };
    const project = blenderFilmProject();
    const view = render(<RenderFinalButton project={{ ...project, blenderShots: { total: 80, finalReady: 78, ready: false } }} renderJob={renderJob} readiness={readiness} />);
    expect(screen.getByRole('button', { name: 'Render final' })).toBeDisabled();
    expect(screen.getByText('Render every shot at final quality in Blender film first (78 of 80 ready)')).toBeInTheDocument();

    view.rerender(<RenderFinalButton project={{ ...project, blenderShots: { total: 0, finalReady: 0, ready: false } }} renderJob={renderJob} readiness={readiness} />);
    expect(screen.getByText('Sync the shots from the film scripts in Blender film first')).toBeInTheDocument();

    view.rerender(<RenderFinalButton project={{ ...project, blenderShots: { total: 80, finalReady: 80, ready: true } }} renderJob={renderJob} readiness={readiness} />);
    fireEvent.click(screen.getByRole('button', { name: 'Render final' }));
    expect(renderJob.start).toHaveBeenCalledWith('mv-test');

    // A record without the server's count: the server's own check decides, so the button is not held shut on a guess.
    view.rerender(<RenderFinalButton project={project} renderJob={renderJob} readiness={readiness} />);
    expect(screen.getByRole('button', { name: 'Render final' })).toBeEnabled();
    // The approvals gate still applies.
    view.rerender(<RenderFinalButton project={{ ...project, blenderShots: { total: 80, finalReady: 80, ready: true } }} renderJob={renderJob} readiness={{ readyForProduction: false }} />);
    expect(screen.getByRole('button', { name: 'Render final' })).toBeDisabled();
  });

  it('does not offer footage generation for mirrored Blender shots', () => {
    const project = blenderFilmProject({ scenes: [{ sceneId: 'scene-s010', order: 0, prompt: 'The stage wakes up.', visualLayer: 'code' }] });
    const sceneMedia = { genScenes: {}, genVideoScenes: {}, planMissingFrames: vi.fn(() => []), planMissingVideos: vi.fn(() => ({ pending: [] })), frameBatch: { state: null }, videoBatch: { state: null } };
    render(<GenerationActions project={project} videoSettings={{ settings: {}, framePinSaving: false, saving: false }} sceneMedia={sceneMedia} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'This render style draws its own scene and does not generate footage');
    }
  });
});
