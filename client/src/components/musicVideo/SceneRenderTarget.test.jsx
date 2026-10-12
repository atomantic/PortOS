import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import SceneRenderTarget from './SceneRenderTarget.jsx';

const models = [
  { id: 'ltx25_example', name: 'LTX-2.5 Example', runtime: 'ltx25', supportedModes: ['text', 'image', 'fflf', 'a2v'] },
  { id: 'ref2va_example', name: 'Ref2VA Example', runtime: 'minimax_h3_ref2va', supportedModes: ['a2v'] },
  { id: 'wan_example', name: 'Wan Example', runtime: 'wan22', supportedModes: ['text', 'image'] },
];
const modelNames = (performance) => {
  const { unmount } = render(<SceneRenderTarget id="pick" value="local" performance={performance} saved={{}} models={models}
    scene={{ sceneId: 's1', startSec: 0, endSec: 4 }} onChange={() => {}} onOptionsChange={() => {}} />);
  const names = within(screen.getByLabelText('Model')).getAllByRole('option').map((option) => option.textContent);
  unmount();
  return names;
};

// Uniquely catches the shot card offering a model its kind of shot cannot
// render: an audio-only model for a cutaway, an image-only one for lip-sync.
describe('the shot card local model picker', () => {
  it('offers image models for a cutaway and audio-to-video models for a performance shot', () => {
    expect(modelNames(false)).toEqual(['LTX-2.5 Example', 'Wan Example']);
    expect(modelNames(true)).toEqual(['LTX-2.5 Example', 'Ref2VA Example']);
  });
});
