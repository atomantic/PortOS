import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { getMusicVideoOutroStats } = vi.hoisted(() => ({
  getMusicVideoOutroStats: vi.fn(async () => ({ stats: { stills: { made: 3, kept: 1 }, clips: { made: 2, kept: 1 }, rejected: 1, shots: 1, floorImages: [] } })),
}));
vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({ ...(await importOriginal()), getMusicVideoOutroStats }));

const { default: StoryboardAnimatic } = await import('./StoryboardAnimatic.jsx');
const { default: StatsOutroPanel } = await import('./StatsOutroPanel.jsx');

const scenes = [{ sceneId: 'a', label: 'Opening', startSec: 0 }];

// A 2D context that records the text it is asked to draw (happy-dom's canvas draws nothing).
function stubCanvas() {
  const texts = [];
  const ctx = new Proxy({}, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'fillText') return (text) => texts.push(text);
      if (key === 'measureText') return (text) => ({ width: String(text).length * 10 });
      if (key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const spy = vi.spyOn(window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  return { texts, restore: () => spy.mockRestore() };
}

describe('cutting room floor ending', () => {
  // Uniquely catches the ending never reaching the player: it must follow the song and leave when the song plays again.
  it('plays after the song ends, from Ending, and leaves when the song plays', async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const canvas = stubCanvas();
    // The scene's own clock holds at its first frame.
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    const project = { id: 'p', scenes, statsOutro: { enabled: true, durationSec: 6 } };
    render(<StoryboardAnimatic project={project} audioUrl="/song.mp3" />);
    expect(screen.queryByTestId('animatic-stats-outro')).toBeNull();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    act(() => { audio.dispatchEvent(new Event('ended')); });
    expect(screen.getByTestId('animatic-stats-outro')).toBeTruthy();
    await waitFor(() => expect(getMusicVideoOutroStats).toHaveBeenCalledWith('p', { silent: true }));
    expect(canvas.texts).toContain('THE CUTTING ROOM FLOOR');
    fireEvent.play(audio);
    expect(screen.queryByTestId('animatic-stats-outro')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Ending/ }));
    await act(async () => {});
    expect(screen.getByTestId('animatic-stats-outro')).toBeTruthy();
    canvas.restore();
    raf.mockRestore();
    play.mockRestore();
  });

  it('offers no ending while it is off', () => {
    render(<StoryboardAnimatic project={{ id: 'p', scenes, statsOutro: { enabled: false, durationSec: 6 } }} audioUrl="/song.mp3" />);
    expect(screen.queryByRole('button', { name: /Ending/ })).toBeNull();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    act(() => { audio.dispatchEvent(new Event('ended')); });
    expect(screen.queryByTestId('animatic-stats-outro')).toBeNull();
  });

  it('turns on with its default length and saves a new length', () => {
    const onSave = vi.fn(async () => {});
    const onEditLocal = vi.fn();
    const { rerender } = render(<StatsOutroPanel project={{ id: 'p', statsOutro: null }} onEditLocal={onEditLocal} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText('Off'));
    expect(onSave).toHaveBeenLastCalledWith({ statsOutro: { enabled: true, durationSec: 8 } });
    rerender(<StatsOutroPanel project={{ id: 'p', statsOutro: { enabled: true, durationSec: 8 } }} onEditLocal={onEditLocal} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: '12' } });
    expect(onSave).toHaveBeenLastCalledWith({ statsOutro: { enabled: true, durationSec: 12 } });
  });
});
