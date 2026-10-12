import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import SceneEndFrame from './SceneEndFrame.jsx';

const scene = { sceneId: 's1', referenceImageId: 'start.png', endImageId: 'end.png', endFramePrompt: 'head thrown back' };
const renderFor = (localVideoRuntime) => render(
  <SceneEndFrame scene={scene} index={0} onEditLocal={() => {}} onSave={() => {}}
    videoSettings={{ backend: 'local' }} localVideoRuntime={localVideoRuntime} />,
);

// Uniquely catches the card telling the director a local LTX clip ignores the
// end frame it now renders to (#11258), or promising it on a one-frame model.
describe('SceneEndFrame on the local renderer', () => {
  it('says a local LTX clip ends on the end frame', () => {
    renderFor('ltx25');
    expect(screen.getByText('The clip ends on this frame.')).toBeInTheDocument();
  });

  it('warns that a single-frame local model ignores it', () => {
    renderFor('fastmetal');
    expect(screen.getByText(/animates from the start frame only/)).toBeInTheDocument();
  });
});
