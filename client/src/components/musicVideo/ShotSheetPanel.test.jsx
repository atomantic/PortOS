import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import RealShotSheetPanel from './ShotSheetPanel.jsx';

const ShotSheetPanel = (props) => <MemoryRouter><RealShotSheetPanel {...props} /></MemoryRouter>;

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
    board.project.scenes[0].shotSheet = { cameraId: 'vhs', holder: 'Kevin', location: 'Street', timeOfDay: 'Dusk', emotion: 'Focused', action: 'Rides', characters: ['Renee'], checked: true };
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

  // Catches a bar missing from the map, a bar not following the sheet, or a stretch not narrowing the list.
  it('maps location, camera and time of day and filters to a tapped stretch', () => {
    const board = boardFor();
    Object.assign(board.project.scenes[0].shotSheet, { location: 'Street', timeOfDay: 'Dusk' });
    board.project.scenes[1].shotSheet = { location: 'Dead mall', timeOfDay: 'Dusk', cameraId: 'obs' };
    render(<ShotSheetPanel board={board} />);
    openPanel();
    const mall = within(screen.getByRole('group', { name: 'Location' })).getByRole('button', { name: /^Location Dead mall, 0:02/ });
    expect(mall.style.flex).toContain('2');
    within(screen.getByRole('group', { name: 'Camera' })).getByRole('button', { name: /^Camera VHS · Kevin, 0:00/ });
    const observer = within(screen.getByRole('group', { name: 'Camera' })).getByRole('button', { name: /^Camera Observer, 0:02/ });
    // One stretch across both shots: the light didn't change.
    within(screen.getByRole('group', { name: 'Time of day' })).getByRole('button', { name: /^Time of day Dusk, 0:00.*2 shots/ });
    fireEvent.click(observer);
    expect(observer).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Open Shot 1' })).not.toBeInTheDocument();
    fireEvent.click(observer);
    expect(screen.getByRole('button', { name: 'Open Shot 1' })).toBeInTheDocument();
  });

  // Catches ruler marks drifting from the bars' shared time scale.
  it('marks the song\u2019s time above the bars', () => {
    const board = boardFor();
    board.project.scenes[1].endSec = 80;
    render(<ShotSheetPanel board={board} />);
    openPanel();
    const marks = [...screen.getByTestId('map-ruler').children];
    expect(marks.map((mark) => mark.textContent)).toEqual(['0:00', '0:30', '1:00']);
    expect(marks[2].style.left).toBe('75%');
  });

  // Catches a borrowed camera changing color, which would read as a different camera.
  it('keeps one color per camera whoever holds it', () => {
    const board = boardFor();
    board.project.scenes[1].shotSheet = { cameraId: 'vhs', holder: 'Renee' };
    render(<ShotSheetPanel board={board} />);
    openPanel();
    const bar = within(screen.getByRole('group', { name: 'Camera' }));
    const color = (button) => button.className.match(/bg-port-\S+/)[0];
    expect(color(bar.getByRole('button', { name: /VHS · Renee/ }))).toBe(color(bar.getByRole('button', { name: /VHS · Kevin/ })));
  });

  // Catches the storyboard sketch standing in for the selected render, which the warning beside it describes.
  it('shows the selected frame ahead of the storyboard sketch', () => {
    const board = boardFor();
    Object.assign(board.project.scenes[1], { referenceImageId: 'selected.png', panelArt: 'storyboard.png' });
    const { container } = render(<ShotSheetPanel board={board} />);
    openPanel();
    const images = [...container.querySelectorAll('img')].map((image) => image.getAttribute('src'));
    expect(images.some((src) => src.includes('selected.png'))).toBe(true);
    expect(images.some((src) => src.includes('storyboard.png'))).toBe(false);
  });

  // Catches a bulk set reaching shots outside the list, overwriting the director's values, or not saving.
  it('sets a column across the listed shots, leaving set values unless told otherwise', () => {
    const board = boardFor();
    board.project.scenes[0].shotSheet.location = 'Street';
    render(<ShotSheetPanel board={board} />);
    openPanel();
    fireEvent.change(screen.getByLabelText('Value to set'), { target: { value: 'Mall' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set on 1 listed shot' }));
    expect(board.saveScene).toHaveBeenCalledTimes(1);
    expect(board.saveScene).toHaveBeenCalledWith('b', { shotSheet: { location: 'Mall' } });
  });

  // Catches a shot's medium not following its camera, or the match not saving both the plan and the layer.
  it('flags a shot that disagrees with its camera and matches it on request', async () => {
    const board = boardFor();
    board.treatment = { save: vi.fn(async () => ({})) };
    board.project.cameras[0].output = 'image';
    board.project.treatment = { shotDirections: [{ sceneId: 'a', medium: 'generated-footage' }] };
    render(<ShotSheetPanel board={board} />);
    openPanel();
    expect(screen.getByText('VHS shoots photos, but this shot is set to video')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Match 1 shot to its camera' }));
    await waitFor(() => expect(board.saveScene).toHaveBeenCalledWith('a', { visualLayer: 'still' }));
    expect(board.treatment.save).toHaveBeenCalledWith({ shotDirections: [{ sceneId: 'a', medium: 'still', mediumPinned: true }] });
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
