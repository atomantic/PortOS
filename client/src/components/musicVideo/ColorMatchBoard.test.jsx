import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import ColorMatchBoard from './ColorMatchBoard.jsx';
import { measureMusicVideoColorMatch } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({ measureMusicVideoColorMatch: vi.fn(), setMusicVideoColorMatchReference: vi.fn() }));

// Uniquely catches a late color measurement restoring rejected takes or dropping a new take.
it('merges measured color fields into current take decisions', async () => {
  let finish;
  measureMusicVideoColorMatch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const scene = { sceneId: 's', referenceImageId: 'frame.png', shotSheet: { cameraId: 'cam', location: 'Set', timeOfDay: 'Day' },
    takes: [{ takeId: 'a', kind: 'image', assetId: 'frame.png', status: 'candidate' }] };
  const project = { id: 'mv-example', cameras: [{ id: 'cam', name: 'Main' }], scenes: [scene] };
  const onProject = vi.fn();
  render(<ColorMatchBoard project={project} onProject={onProject} />);
  fireEvent.click(screen.getByRole('button', { name: 'Measure shots' }));
  const colorMatch = { enabled: true, strength: 0.5 };
  await act(async () => finish({ scenes: [{ ...scene, takes: [{ ...scene.takes[0], colorMatch }] }] }));
  await waitFor(() => expect(onProject).toHaveBeenCalledTimes(1));
  const current = { ...project, scenes: [{ ...scene, takes: [{ ...scene.takes[0], status: 'rejected' }, { takeId: 'b', kind: 'image', assetId: 'new.png', status: 'candidate' }] }] };
  expect(onProject.mock.calls[0][0](current).scenes[0].takes).toEqual([
    { ...scene.takes[0], status: 'rejected', colorMatch }, current.scenes[0].takes[1],
  ]);
});
