import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SceneRenderInputs, { shotCardRenderRequest, shotCardRequestProblem } from './SceneRenderInputs.jsx';

const models = [
  { id: 'ltx25_example', name: 'LTX-2.5 Example', runtime: 'ltx25', supportedModes: ['text', 'image', 'fflf', 'a2v'] },
  { id: 'wan_example', name: 'Wan Example', runtime: 'wan22', supportedModes: ['text', 'image'] },
];
const scene = (over = {}) => ({ sceneId: 's1', startSec: 64.2, endSec: 69.8, prompt: 'She shakes her head', referenceImageId: 'still.png', ...over });

// Adam: the card's Render sends only what the card shows, with the inputs he picks.
describe('shotCardRenderRequest', () => {
  it('sends the typed prompt and the card camera move, nothing else', () => {
    const request = shotCardRenderRequest({ scene: scene({ camera: { move: 'slow-dolly-in' } }), settings: { backend: 'local', modelId: 'wan_example' }, models });
    expect(request.prompt).toMatch(/^She shakes her head\nCamera movement: /);
    expect(request.prompt).not.toMatch(/bible|hold the reference frame/i);
    expect(request.songAudio).toEqual({ state: 'unavailable', note: 'This model hears no audio' });
  });

  it('offers song audio for a cutaway on an LTX-2 model, off unless toggled, and drops the end frame with it', () => {
    const base = { scene: scene({ endImageId: 'end.png' }), settings: { backend: 'local', modelId: 'ltx25_example' }, models, endFramePlan: { used: true } };
    expect(shotCardRenderRequest(base)).toMatchObject({ songAudio: { state: 'off', note: 'Song 1:04.2–1:09.8' }, endFrame: { state: 'on' } });
    expect(shotCardRenderRequest({ ...base, inputs: { songAudio: true } })).toMatchObject({ songAudio: { state: 'on' }, endFrame: { state: 'unavailable' } });
    expect(shotCardRenderRequest({ ...base, inputs: { endFrame: false } }).endFrame.state).toBe('off');
  });

  // Review on #11280: an audio-reactive render hears the song through its LoRA, so the card must say so and never stack a supplied window.
  it('shows an audio-reactive render as hearing the song, with its guard in the prompt', () => {
    const request = shotCardRenderRequest({ scene: scene(), settings: { backend: 'local', modelId: 'ltx25_example', generationMode: 'audioReactive' }, models,
      inputs: { songAudio: false } });
    expect(request.songAudio.state).toBe('required');
    expect(request.prompt).toMatch(/No singing, lip-sync/);
  });

  it('requires the song for a performance shot and flags a prompt over the fal model limit', () => {
    expect(shotCardRenderRequest({ scene: scene(), performance: true, settings: { backend: 'local' }, models }).songAudio.state).toBe('required');
    const long = shotCardRenderRequest({ scene: scene({ prompt: 'x'.repeat(2100) }), settings: { backend: 'fal' } });
    expect(long.maxChars).toBe(2000);
    expect(shotCardRequestProblem(long)).toMatch(/2,100 characters; this model takes 2,000/);
  });
});

describe('SceneRenderInputs', () => {
  it('shows the exact prompt and reports a toggle', () => {
    const onChange = vi.fn();
    const request = shotCardRenderRequest({ scene: scene(), settings: { backend: 'local', modelId: 'ltx25_example' }, models });
    render(<SceneRenderInputs id="card" request={request} onChange={onChange} />);
    expect(screen.getByText('She shakes her head')).toBeTruthy();
    expect(screen.getByLabelText('Still').disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Song audio'));
    expect(onChange).toHaveBeenCalledWith({ songAudio: true });
  });
});
