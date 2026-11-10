import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ShotColorMatch from './ShotColorMatch.jsx';
import { measureMusicVideoColorMatch } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({ measureMusicVideoColorMatch: vi.fn(), updateMusicVideoTakeColorMatch: vi.fn() }));

// The shot-level measurement shares the board's stale response boundary.
it('keeps newer take decisions when a shot measurement finishes', async () => {
  let finish;
  measureMusicVideoColorMatch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const scene = { sceneId: 's', referenceImageId: 'frame.png', shotSheet: { cameraId: 'cam', location: 'Set', timeOfDay: 'Day' },
    takes: [{ takeId: 'a', kind: 'image', assetId: 'frame.png', status: 'candidate' }] };
  const project = { id: 'mv-example', cameras: [{ id: 'cam', name: 'Main' }], scenes: [scene] };
  const onApplied = vi.fn();
  const { rerender } = render(<ShotColorMatch project={project} scene={scene} onApplied={onApplied} />);
  fireEvent.click(screen.getByRole('button', { name: 'Measure this shot' }));
  const newest = { ...scene, takes: [{ ...scene.takes[0], status: 'rejected' }, { takeId: 'b', kind: 'image', assetId: 'new.png', status: 'candidate' }] };
  rerender(<ShotColorMatch project={project} scene={newest} onApplied={onApplied} />);
  const colorMatch = { enabled: true, strength: 0.5 };
  await act(async () => finish({ scenes: [{ ...scene, takes: [{ ...scene.takes[0], colorMatch }] }] }));
  await waitFor(() => expect(onApplied).toHaveBeenCalledWith({ takes: [{ ...newest.takes[0], colorMatch }, newest.takes[1]] }));
});
