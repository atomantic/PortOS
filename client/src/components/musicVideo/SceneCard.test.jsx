import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({}) }));
import SceneCard from './SceneCard.jsx';

describe('performance speaker save boundary', () => {
  it('keeps paid generation disabled until the speaker edit is saved, including a failed save', async () => {
    let settle;
    const onSave = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', shotMode: 'performance', startSec: 0, endSec: 5, referenceImageId: 'frame.png', takes: [] });
      return <SceneCard scene={scene} index={0} lipSyncBackend="fal" songDurationSec={30}
        onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('Speaker / singer');
    const generate = screen.getByRole('button', { name: 'Generate video' });
    expect(generate.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Example Singer' } });
    expect(generate.disabled).toBe(true);
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledWith('s1', { performanceSpeaker: 'Example Singer' });
    expect(generate.disabled).toBe(true);
    settle(false);
    await waitFor(() => expect(generate.disabled).toBe(true));
    fireEvent.blur(input);
    settle(true);
    await waitFor(() => expect(generate.disabled).toBe(false));
  });
});
