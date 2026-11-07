import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PrevizStage from './PrevizStage.jsx';

vi.mock('../../../hooks/useMusicVideoGreyboxPlaces.js', () => ({
  default: () => ({ 'cat-street': { ingredient: { type: 'place', payload: { greybox: { anchors: [], shots: [{ id: 'wide', label: 'Wide', position: [0, 2, 8], target: [0, 1, 0], figures: [] }] } } }, media: [] } }),
}));
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const project = {
  id: 'mv-1',
  concept: { subjects: [{ id: 'c-ana', kind: 'character', name: 'Ana' }, { id: 'c-bo', kind: 'character', name: 'Bo' }, { id: 'p-street', kind: 'place', name: 'Example Street', ingredientId: 'cat-street' }] },
  cameras: [{ id: 'cam', name: 'VHS camera', kind: 'in-world' }],
  scenes: [{ sceneId: 's1', startSec: 0, endSec: 4, setReference: { subjectId: 'p-street', greyboxShotId: 'wide' }, shotSheet: { cameraId: 'cam', holder: 'Bo', characters: ['Ana'] } }],
};

// Catches the backfill or the per-shot cast picker never reaching the saved project.
it('builds a cut per shot from the shot list, then saves who is in shot from the chips', () => {
  const board = { project, locked: false, editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), seekToScene: vi.fn() };
  const { rerender } = render(<MemoryRouter><PrevizStage board={board} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /Build previz from 1 shot/ }));
  const { previz } = board.saveProjectFields.mock.calls[0][0];
  expect(previz.cuts[0]).toMatchObject({ sceneId: 's1', viewShotId: 'wide', holderSubjectId: 'c-bo', visibleSubjectIds: ['c-ana'] });

  rerender(<MemoryRouter><PrevizStage board={{ ...board, project: { ...project, previz } }} /></MemoryRouter>);
  expect(screen.getByLabelText('Held by').value).toBe('c-bo');
  // The holder is behind the camera, so only Ana is offered as in shot.
  expect(screen.queryByRole('button', { name: 'Bo' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ana', pressed: true }));
  expect(board.saveProjectFields.mock.calls.at(-1)[0].previz.cuts[0].visibleSubjectIds).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: /Watch/ }));
  expect(board.seekToScene).toHaveBeenCalledWith({ startSec: 0 }, { play: true });
});
