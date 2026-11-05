import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ShotSheetPanel from './ShotSheetPanel.jsx';

const boardFor = (over = {}) => ({
  project: {
    id: 'p',
    cameras: [
      { id: 'vhs', name: 'VHS', kind: 'in-world', owner: 'Kevin' },
      { id: 'obs', name: 'Observer', kind: 'observer' },
    ],
    concept: { subjects: [{ kind: 'character', name: 'Renee' }, { kind: 'character', name: 'Kevin' }] },
    lyricCues: [{ id: 'c', text: 'Hold still', startSec: 0, endSec: 2 }],
    scenes: [
      { sceneId: 'a', label: 'Shot 1', startSec: 0, endSec: 2, framePrompt: 'New wording', prompt: 'She rides', referenceImageId: 'a.png',
        takes: [{ kind: 'image', assetId: 'a.png', prompt: 'Old wording' }], shotSheet: { cameraId: 'vhs', holder: 'Kevin', emotion: 'Focused' } },
      { sceneId: 'b', label: 'Shot 2', startSec: 2, endSec: 4, framePrompt: 'Empty lot', prompt: '' },
    ],
    ...over,
  },
  locked: false, editSceneLocal: vi.fn(), saveScene: vi.fn(), editProjectLocal: vi.fn(), saveProjectFields: vi.fn(), onEditShot: vi.fn(),
});

const openPanel = () => fireEvent.click(screen.getByText('Shot sheet'));

describe('ShotSheetPanel', () => {
  // Catches a missing column the director reads the story from, or the outdated-frame warning not reaching the row.
  it('shows each shot with its time, lyric, camera and outdated frame warning', () => {
    render(<ShotSheetPanel board={boardFor()} />);
    openPanel();
    expect(screen.getByText('0 of 2 shots checked · 2 incomplete · 1 frame older than its prompt')).toBeInTheDocument();
    const row = screen.getByRole('button', { name: 'Open Shot 1' }).closest('tr');
    expect(within(row).getByText('Hold still')).toBeInTheDocument();
    expect(within(row).getByText('Prompt changed since this frame')).toBeInTheDocument();
    expect(within(row).getByLabelText('Shot 1 camera')).toHaveValue('vhs');
    expect(within(row).getByLabelText('Shot 1 emotion')).toHaveValue('Focused');
  });

  // Catches a sheet edit dropping sibling fields, or saving when nothing changed.
  it('saves a changed field with the rest of the sheet, and nothing when unchanged', () => {
    const board = boardFor();
    render(<ShotSheetPanel board={board} />);
    openPanel();
    const emotion = screen.getByLabelText('Shot 1 emotion');
    fireEvent.blur(emotion);
    expect(board.saveScene).not.toHaveBeenCalled();
    fireEvent.change(emotion, { target: { value: 'Scared' } });
    fireEvent.blur(emotion);
    expect(board.saveScene).toHaveBeenCalledWith('a', { shotSheet: { cameraId: 'vhs', holder: 'Kevin', emotion: 'Scared' } });
    expect(board.editSceneLocal).toHaveBeenCalledWith('a', { shotSheet: { cameraId: 'vhs', holder: 'Kevin', emotion: 'Scared' } });
  });

  // Catches an observer keeping a holder: it isn't in their world, so nobody holds it.
  it('clears the holder when a shot changes to the observer and hides the held-by picker', () => {
    const board = boardFor();
    render(<ShotSheetPanel board={board} />);
    openPanel();
    fireEvent.change(screen.getByLabelText('Shot 1 camera'), { target: { value: 'obs' } });
    expect(board.saveScene).toHaveBeenCalledWith('a', { shotSheet: { cameraId: 'obs', emotion: 'Focused' } });
  });

  // Catches the human review not saving with the plan, or the filters ignoring it.
  it('saves a Checked tick with the sheet and narrows to unchecked and incomplete shots', () => {
    const board = boardFor();
    board.project.scenes[0].shotSheet = { cameraId: 'vhs', holder: 'Kevin', location: 'Street', light: 'Dusk', emotion: 'Focused', action: 'Rides', characters: ['Renee'], checked: true };
    render(<ShotSheetPanel board={board} />);
    openPanel();
    expect(screen.getByLabelText('Shot 1 checked')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Shot 2 checked'));
    expect(board.saveScene).toHaveBeenCalledWith('b', { shotSheet: { checked: true } });
    fireEvent.click(screen.getByLabelText('Only not checked'));
    expect(screen.queryByRole('button', { name: 'Open Shot 1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Only not checked'));
    fireEvent.click(screen.getByLabelText('Only incomplete'));
    expect(screen.queryByRole('button', { name: 'Open Shot 1' })).not.toBeInTheDocument();
    expect(screen.getByText(/Missing camera, location/)).toBeInTheDocument();
  });

  // Catches a column losing its pick list.
  it('offers the project\u2019s places and earlier wording as pick lists', () => {
    const board = boardFor();
    board.project.concept.subjects.push({ kind: 'place', name: 'Dead mall' });
    board.project.scenes[0].shotSheet.light = 'Sodium streetlight';
    const { container } = render(<ShotSheetPanel board={board} />);
    openPanel();
    expect(screen.getByLabelText('Shot 2 location')).toHaveAttribute('list', 'mv-sheet-location');
    expect(container.querySelector('#mv-sheet-location option[value="Dead mall"]')).not.toBeNull();
    expect(container.querySelector('#mv-sheet-light option[value="Sodium streetlight"]')).not.toBeNull();
    expect(container.querySelector('#mv-sheet-emotion option[value="Contemplative"]')).not.toBeNull();
  });

  // Catches the route not following the sheet, or a stretch not narrowing the list.
  it('shows the route from each shot\u2019s location and filters to a tapped stretch', () => {
    const board = boardFor();
    board.project.scenes[0].shotSheet.location = 'Street';
    board.project.scenes[1].shotSheet = { location: 'Dead mall' };
    render(<ShotSheetPanel board={board} />);
    openPanel();
    const route = screen.getByRole('group', { name: 'Route by time' });
    const mall = within(route).getByRole('button', { name: /^Dead mall, 0:02/ });
    expect(mall.style.flex).toContain('2');
    fireEvent.click(mall);
    expect(mall).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Open Shot 1' })).not.toBeInTheDocument();
    fireEvent.click(mall);
    expect(screen.getByRole('button', { name: 'Open Shot 1' })).toBeInTheDocument();
  });

  // Catches a camera edit not persisting to the project.
  it('adds a camera to the project', () => {
    const board = boardFor();
    render(<ShotSheetPanel board={board} />);
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Add camera' }));
    const saved = board.saveProjectFields.mock.calls[0][0].cameras;
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({ name: 'Camera 3', kind: 'in-world' });
  });

  // Catches the prompts being unavailable beside the plan, or filters not narrowing the list.
  it('shows the real prompts on request and narrows by search and outdated frames', () => {
    render(<ShotSheetPanel board={boardFor()} />);
    openPanel();
    expect(screen.queryByText('She rides')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show prompts'));
    expect(screen.getByText('She rides')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Only frames older than their prompt'));
    expect(screen.queryByRole('button', { name: 'Open Shot 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Only frames older than their prompt'));
    fireEvent.change(screen.getByLabelText('Search shots'), { target: { value: 'empty lot' } });
    expect(screen.queryByRole('button', { name: 'Open Shot 1' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Shot 2' })).toBeInTheDocument();
  });
});
