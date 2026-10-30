import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/api', () => ({ listTracks: vi.fn(async () => [{ id: 'tape', title: 'Tape room' }]) }));
const { default: ScenePreMusic } = await import('./ScenePreMusic.jsx');

const fieldId = (name) => `field-${name}`;

describe('ScenePreMusic', () => {
  // Uniquely catches a cold-open shot losing its length to the 4 s default, or a layer saved with both sound kinds.
  it('moves a timed shot before the song at its own length, then sets its sound', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<ScenePreMusic fieldId={fieldId} scene={{ sceneId: 's', startSec: 2, endSec: 4.5 }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Before the song' }));
    expect(onChange).toHaveBeenLastCalledWith({ preMusic: { durationSec: 2.5 } });

    const scene = { sceneId: 's', preMusic: { durationSec: 2.5 } };
    rerender(<ScenePreMusic fieldId={fieldId} scene={scene} onChange={onChange} />);
    expect(screen.getByText('Silent')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Clip sound' }));
    expect(onChange).toHaveBeenLastCalledWith({ preMusic: { durationSec: 2.5, clipVolume: 1, layers: [] } });
    fireEvent.click(screen.getByRole('button', { name: /Add sound/ }));
    expect(onChange).toHaveBeenLastCalledWith({ preMusic: { durationSec: 2.5, clipVolume: null,
      layers: [{ effect: 'play-button', atSec: 0, durationSec: null, volume: 1 }] } });

    rerender(<ScenePreMusic fieldId={fieldId} scene={{ sceneId: 's', preMusic: { durationSec: 2.5, layers: [{ effect: 'play-button' }] } }} onChange={onChange} />);
    await screen.findByRole('option', { name: /^Tape room/ });
    fireEvent.change(screen.getByLabelText('Sound 1'), { target: { value: 'track:tape' } });
    expect(onChange).toHaveBeenLastCalledWith({ preMusic: { durationSec: 2.5, clipVolume: null,
      layers: [{ trackId: 'tape', atSec: 0, durationSec: null, volume: 1 }] } });
    fireEvent.click(screen.getByRole('switch', { name: 'Before the song' }));
    expect(onChange).toHaveBeenLastCalledWith({ preMusic: null });
  });
});
