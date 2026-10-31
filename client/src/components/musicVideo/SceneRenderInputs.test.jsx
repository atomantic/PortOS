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

  it('lists provider prompt expansion as disabled on an H3 fal take only', () => {
    const h3 = shotCardRenderRequest({ scene: scene(), settings: { backend: 'fal', falModelId: 'minimax/h3-max/image-to-video' } });
    expect(h3.promptAdditions).toContainEqual(expect.objectContaining({ id: 'prompt-expansion', text: expect.stringContaining('disabled') }));
    const hailuo = shotCardRenderRequest({ scene: scene(), settings: { backend: 'fal' } });
    expect(hailuo.promptAdditions.some((a) => a.id === 'prompt-expansion')).toBe(false);
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

  // Review on #11280: a split piece keeps its parent's longer contract, which must refuse Render, not crash the Board.
  it('reports a contract that outlasts its scene instead of throwing', () => {
    const request = shotCardRenderRequest({ project: { phrases: [] }, settings: { backend: 'grok' }, scene: scene({ startSec: 10, endSec: 12, prompt: 'p',
      direction: { actionContract: { version: 1, purpose: 'x', actions: [{ startSec: 0, endSec: 3, subject: 'A', description: 'walks' }] } } }) });
    expect(request.prompt).toBe('p');
    expect(shotCardRequestProblem(request)).toMatch(/must fit inside its 2.000s scene/);
  });

  it('requires the song for a performance shot and flags a prompt over the fal model limit', () => {
    expect(shotCardRenderRequest({ scene: scene(), performance: true, settings: { backend: 'local' }, models }).songAudio.state).toBe('required');
    const long = shotCardRenderRequest({ scene: scene({ prompt: 'x'.repeat(2100) }), settings: { backend: 'fal' } });
    expect(long.maxChars).toBe(2000);
    expect(shotCardRequestProblem(long)).toMatch(/2,100 characters; this model takes 2,000/);
  });
});

// The 80s drummer shot: a music-driven take hears the song slice as a reference its prompt names.
describe('music-driven shot on a reference model', () => {
  const drummer = scene({ shotMode: 'performance', performanceStyle: 'music', prompt: 'The drummer hits the snare' });
  it.each([
    [{}, 'Audio 1 is the song playing under this shot: time the movement to its beat.'],
    [{ falMusicModelId: 'bytedance/seedance-2.5/reference-to-video' },
      '@Image1 is the opening frame. @Audio1 is the song playing under this shot: time the movement to its beat.'],
  ])('lists the song audio reference as a chip, sent after the typed prompt (%o)', (pin, text) => {
    const request = shotCardRenderRequest({ scene: drummer, performance: true, settings: { backend: 'fal', ...pin } });
    expect(request.songAudio.state).toBe('required');
    expect(request.promptAdditions).toContainEqual({ id: 'audio-reference', label: 'Song audio reference', text });
    expect(request.prompt).toBe(`The drummer hits the snare. ${text}`);
  });

  it('adds nothing for an audio-to-video model that hears the song as its source audio', () => {
    const request = shotCardRenderRequest({ scene: drummer, performance: true, settings: { backend: 'fal', falMusicModelId: 'fal-ai/bytedance/omnihuman/v1.5' } });
    expect(request.promptAdditions.map((item) => item.id)).not.toContain('audio-reference');
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
