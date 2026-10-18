import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const handlers = new Map();
const savedLooks = vi.hoisted(() => []);
vi.mock('../../hooks/useFilmLookPresets.js', () => ({ default: () => ({ presets: savedLooks, loaded: true, save: vi.fn(), remove: vi.fn() }) }));
vi.mock('../../services/socket', () => ({
  default: { on: vi.fn((event, fn) => handlers.set(event, fn)), off: vi.fn((event) => handlers.delete(event)) },
}));
vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoShotRenders: vi.fn(),
  renderMusicVideoShot: vi.fn(async () => ({ state: 'rendering' })),
  cancelMusicVideoShotRender: vi.fn(async () => ({ ok: true })),
  musicVideoShotRenderUrl: (id, name) => `/api/music-video/${id}/shot-renders/${name}`,
}));

import ShotFinalRender from './ShotFinalRender.jsx';
import { filmLookPreset } from '../../lib/filmLook.js';
import { getMusicVideoShotRenders, renderMusicVideoShot } from '../../services/apiMusicVideo.js';

const project = { id: 'mv-1', composition: { mode: 'composed' }, filmLook: { preset: 'vhs' }, scenes: [{ sceneId: 'a' }, { sceneId: 'b' }] };
const fieldId = (name) => `f-${name}`;
const shot = (sceneId, state, files = []) => ({ sceneId, state, rendering: false, files });

beforeEach(() => {
  vi.clearAllMocks();
  savedLooks.length = 0;
  handlers.clear();
});

describe('ShotFinalRender', () => {
  it('renders only this shot, shows its progress pushed from the server, then offers its segment to play', async () => {
    getMusicVideoShotRenders.mockResolvedValue({ available: true, shots: [shot('a', 'stale'), shot('b', 'rendered', ['b.mp4'])], ready: 1, total: 2 });
    render(<ShotFinalRender project={project} scene={project.scenes[0]} onChange={() => {}} fieldId={fieldId} />);
    const button = await screen.findByRole('button', { name: /Render shot/ });
    await act(async () => fireEvent.click(button));
    expect(renderMusicVideoShot).toHaveBeenCalledWith('mv-1', 'a', { silent: true });
    await waitFor(() => expect(screen.getByTestId('shot-render-state').textContent).toBe('Rendering 0%'));
    act(() => handlers.get('music-video:shot-render')({ projectId: 'mv-1', sceneId: 'a', state: 'rendering', progress: 0.45 }));
    await waitFor(() => expect(screen.getByTestId('shot-render-state').textContent).toBe('Rendering 45%'));

    getMusicVideoShotRenders.mockResolvedValue({ available: true, shots: [shot('a', 'rendered', ['a.mp4']), shot('b', 'rendered', ['b.mp4'])], ready: 2, total: 2 });
    await act(async () => handlers.get('music-video:shot-render')({ projectId: 'mv-1', sceneId: 'a', state: 'rendered', progress: 1 }));
    await waitFor(() => expect(screen.getByTestId('shot-render-state').textContent).toBe('Rendered'));
    fireEvent.click(screen.getByRole('button', { name: /Play/ }));
    expect(document.querySelector('video').getAttribute('src')).toBe('/api/music-video/mv-1/shot-renders/a.mp4');
  });

  it("keeps the video's look on the shot, or returns it to the video's look", async () => {
    getMusicVideoShotRenders.mockResolvedValue({ available: true, shots: [shot('a', 'rendered', ['a.mp4'])], ready: 1, total: 1 });
    const onChange = vi.fn();
    const { rerender } = render(<ShotFinalRender project={project} scene={project.scenes[0]} onChange={onChange} fieldId={fieldId} />);
    const picker = await screen.findByLabelText('Film look');
    fireEvent.change(picker, { target: { value: 'keep' } });
    expect(onChange.mock.calls[0][0].filmLook.preset).toBe('vhs');
    rerender(<ShotFinalRender project={project} scene={{ sceneId: 'a', filmLook: { preset: 'polaroid' } }} onChange={onChange} fieldId={fieldId} />);
    expect(screen.getByLabelText('Film look').value).toBe('polaroid');
    fireEvent.change(screen.getByLabelText('Film look'), { target: { value: 'video' } });
    expect(onChange).toHaveBeenLastCalledWith({ filmLook: null });
  });

  it('offers the saved looks, sets one on the shot, and shows it as picked', async () => {
    savedLooks.push({ id: 'dusk-1', label: 'Dusk', look: { preset: 'custom', warmth: 0.4, grain: 0.2 } });
    getMusicVideoShotRenders.mockResolvedValue({ available: true, shots: [shot('a', 'rendered', ['a.mp4'])], ready: 1, total: 1 });
    const onChange = vi.fn();
    const { rerender } = render(<ShotFinalRender project={project} scene={project.scenes[0]} onChange={onChange} fieldId={fieldId} />);
    fireEvent.change(await screen.findByLabelText('Film look'), { target: { value: 'saved:dusk-1' } });
    const look = onChange.mock.calls[0][0].filmLook;
    expect(look).toMatchObject({ preset: 'custom', warmth: 0.4, grain: 0.2 });
    rerender(<ShotFinalRender project={project} scene={{ sceneId: 'a', filmLook: look }} onChange={onChange} fieldId={fieldId} />);
    expect(screen.getByLabelText('Film look').value).toBe('saved:dusk-1');
  });

  it("tunes this shot's own look from the video's look, down to a lighter strength", async () => {
    getMusicVideoShotRenders.mockResolvedValue({ available: true, shots: [shot('a', 'rendered', ['a.mp4'])], ready: 1, total: 1 });
    const onChange = vi.fn();
    render(<ShotFinalRender project={{ ...project, filmLook: filmLookPreset('vhs') }} scene={{ sceneId: 'a', referenceImageId: 'a.png' }} onChange={onChange} fieldId={fieldId} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Tune' }));
    expect(screen.getByTestId('film-look-image')).toHaveAttribute('src', '/data/images/a.png');
    const strength = screen.getByLabelText(/Strength/);
    fireEvent.change(strength, { target: { value: '0.2' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(strength);
    const look = onChange.mock.calls[0][0].filmLook;
    // VHS at a fifth: effects scale down, the shaping values stay.
    expect(look).toMatchObject({ preset: 'custom', bleed: 0.16, tapeNoise: 0.1, grainSize: 0.2, grainColor: true });
    fireEvent.change(strength, { target: { value: '1' } });
    fireEvent.pointerUp(strength);
    expect(onChange.mock.calls[1][0].filmLook).toMatchObject({ preset: 'vhs', bleed: 0.8 });
  });

  it('names the refusal when the cut cannot be planned, and stays away from other render styles', async () => {
    getMusicVideoShotRenders.mockResolvedValue({ available: true, error: { message: 'Shot 3: the selected clip file is missing' }, shots: [] });
    const { unmount } = render(<ShotFinalRender project={project} scene={project.scenes[0]} onChange={() => {}} fieldId={fieldId} />);
    expect(await screen.findByText('Shot 3: the selected clip file is missing')).toBeTruthy();
    unmount();
    getMusicVideoShotRenders.mockClear();
    // The read is debounced 600ms; fake time runs past that debounce exactly
    // instead of sleeping and hoping a loaded worker kept up (#12047).
    vi.useFakeTimers();
    try {
      const { container } = render(<ShotFinalRender project={{ ...project, composition: { mode: 'concat' } }} scene={project.scenes[0]} onChange={() => {}} fieldId={fieldId} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(700); });
      expect(vi.getTimerCount()).toBe(0);
      expect(getMusicVideoShotRenders).not.toHaveBeenCalled();
      expect(container.innerHTML).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});
