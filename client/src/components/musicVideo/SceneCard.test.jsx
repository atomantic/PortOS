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

describe('persisted render failure chip (#10154)', () => {
  const failedScene = (lane) => ({ sceneId: 's1', startSec: 0, endSec: 5, referenceImageId: 'frame.png', takes: [],
    lastFailure: { lane, error: 'CUDA out of memory', at: '2026-10-05T00:00:00.000Z' } });

  it('shows "Frame failed: <reason>" with a Retry that re-runs the failed lane, and hides while retrying', () => {
    const onGenerateFrame = vi.fn();
    const onGenerateVideo = vi.fn();
    const props = { index: 0, onEditLocal: vi.fn(), onSave: vi.fn(), onGenerateFrame, onGenerateVideo };
    const { rerender } = render(<SceneCard scene={failedScene('image')} {...props} />);
    expect(screen.getByText(/Frame failed: CUDA out of memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onGenerateFrame).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 's1' }));
    expect(onGenerateVideo).not.toHaveBeenCalled();

    rerender(<SceneCard scene={failedScene('image')} generatingFrame {...props} />);
    expect(screen.queryByText(/Frame failed/)).toBeNull();

    rerender(<SceneCard scene={failedScene('video')} {...props} />);
    expect(screen.getByText(/Video failed: CUDA out of memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onGenerateVideo).toHaveBeenCalledTimes(1);
  });
});
