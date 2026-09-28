import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CreativeSetupPanel from './CreativeSetupPanel.jsx';
import { getUniverse } from '../../services/apiUniverseBuilder.js';
vi.mock('../../services/apiUniverseBuilder.js', () => ({
  listUniverseNames: vi.fn(async () => [{ id: 'u1', name: 'Example universe' }, { id: 'u2', name: 'Other universe' }]),
  getUniverse: vi.fn(),
}));
vi.mock('../../services/apiMoodBoard.js', () => ({
  listMoodBoards: vi.fn(async () => [{ id: 'b1', name: 'Painted style' }]),
  getMoodBoard: vi.fn(async () => ({ name: 'Painted style', description: 'Watercolor', items: [{ type: 'text', text: 'Loose brush strokes' }] })),
}));
const project = { id: 'mv1', concept: {}, visualSpec: {} };
const open = (onSave = vi.fn(async () => {})) => {
  render(<MemoryRouter><CreativeSetupPanel project={project} onSave={onSave} onPendingChange={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByText('Set up creative direction'));
  return onSave;
};
beforeEach(() => {
  vi.clearAllMocks();
  getUniverse.mockResolvedValue({ id: 'u1', name: 'Example universe', styleNotes: 'Ink silhouettes', characters: [{ id: 'c1', name: 'Example singer', physicalDescription: 'Silver coat' }], places: [], objects: [] });
});
describe('creative setup', () => {
  it('saves image-free canon, an authored prop and mood-board direction together', async () => {
    const onSave = open();
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    await screen.findByText('Example singer');
    fireEvent.change(screen.getByLabelText('Select cast'), { target: { value: 'c1' } });
    fireEvent.change(screen.getByLabelText('Role for Example singer'), { target: { value: 'band' } });
    fireEvent.change(screen.getByLabelText('Create for this video'), { target: { value: 'object' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Glass guitar' } });
    fireEvent.change(screen.getByLabelText('Appearance / description'), { target: { value: 'Transparent blue glass' } });
    fireEvent.click(screen.getByText('Add to production'));
    fireEvent.click(screen.getByText('Mood board reference'));
    await screen.findByText('Painted style');
    fireEvent.change(screen.getByLabelText('Board'), { target: { value: 'b1' } });
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      concept: { universeId: 'u1', universeStyle: 'Example universe\nInk silhouettes', moodBoardStyle: expect.stringContaining('Loose brush strokes'), subjects: [
        { kind: 'character', name: 'Example singer', role: 'band', description: 'Silver coat', canonId: 'c1' },
        { kind: 'object', name: 'Glass guitar', description: 'Transparent blue glass' },
      ] }, visualSpec: { moodBoardId: 'b1' },
    });
  });
  it('discards an unsaved cast when the director cancels setup', async () => {
    const onSave = open();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved singer' } });
    fireEvent.click(screen.getByText('Add to production'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(/Unsaved singer/)).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Set up creative direction'));
    await act(async () => {});
    expect(screen.queryByText(/Unsaved singer/)).toBeNull();
  });

  it('cannot save a pending universe under the previously loaded style and clears style on deselection', async () => {
    let resolveNext;
    getUniverse.mockResolvedValueOnce({ id: 'u1', name: 'Example universe', styleNotes: 'Old style', characters: [] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
    const onSave = open();
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    await waitFor(() => expect(screen.getByText('Save creative setup').disabled).toBe(false));
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u2' } });
    expect(screen.getByText('Save creative setup').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save creative setup'));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ concept: expect.objectContaining({ universeId: null, universeStyle: '' }) })));
    await act(async () => { resolveNext({ id: 'u2', name: 'Other universe', styleNotes: 'Wrong style' }); });
  });

  it('ignores stale universe responses and retains the draft when saving fails', async () => {
    let resolveOld;
    getUniverse.mockImplementation((id) => id === 'u1' ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ id: 'u2', name: 'Other universe', characters: [] }));
    open(vi.fn(async () => { throw new Error('Save rejected'); }));
    await screen.findByText('Example universe');
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u1' } });
    fireEvent.change(screen.getByLabelText('Universe'), { target: { value: 'u2' } });
    await waitFor(() => expect(screen.queryByText('Loading canon…')).toBeNull());
    resolveOld({ id: 'u1', characters: [{ id: 'c1', name: 'Stale singer' }] });
    fireEvent.click(screen.getByText('Save creative setup'));
    await screen.findByText('Save rejected');
    expect(screen.queryByText('Stale singer')).toBeNull();
    expect(screen.getByLabelText('Universe').value).toBe('u2');
  });
});
