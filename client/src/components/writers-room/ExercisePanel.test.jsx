import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';

// The "Add to draft" promotion (#5300) only offers itself for a finished
// sprint that (a) actually captured prose, (b) belongs to the work currently
// open in the editor, and (c) hasn't already been promoted — and it must stay
// out of reach while the editor holds unsaved changes, or the server-side
// append would be overwritten by the next save.

vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const listWritersRoomExercises = vi.fn(async () => []);
const promoteWritersRoomExercise = vi.fn(async () => ({
  exercise: { id: 'wr-ex-1', promotedAt: '2026-01-01T00:00:00.000Z' },
  work: { id: 'wr-work-1', activeDraftBody: 'The hero wakes.\n\nThen he runs.\n' },
}));

vi.mock('../../services/apiWritersRoom', () => ({
  listWritersRoomExercises: (...a) => listWritersRoomExercises(...a),
  createWritersRoomExercise: vi.fn(),
  finishWritersRoomExercise: vi.fn(),
  discardWritersRoomExercise: vi.fn(),
  promoteWritersRoomExercise: (...a) => promoteWritersRoomExercise(...a),
}));

import ExercisePanel from './ExercisePanel';
import toast from '../ui/Toast';

const activeWork = { id: 'wr-work-1', title: 'Example Work', activeDraftVersionId: 'wr-draft-1', drafts: [] };

const exercise = (over = {}) => ({
  id: 'wr-ex-1',
  workId: 'wr-work-1',
  status: 'finished',
  appendedText: 'Then he runs.',
  // Deliberately unequal to countWords(appendedText) so the success toast
  // can't pass by reading the wrong field.
  wordsAdded: 99,
  durationSeconds: 600,
  prompt: '',
  ...over,
});

const renderPanel = async ({ history = [], ...props } = {}) => {
  listWritersRoomExercises.mockResolvedValue(history);
  const view = render(<ExercisePanel activeWork={activeWork} onClose={() => {}} {...props} />);
  await act(async () => {});
  return view;
};

const promoteButton = () => screen.queryByRole('button', { name: 'Add sprint text to draft' });

beforeEach(() => { vi.clearAllMocks(); });

describe('ExercisePanel promote-to-draft button (#5300)', () => {
  it('offers the action on a finished sprint tied to the open work', async () => {
    await renderPanel({ history: [exercise()] });
    expect(promoteButton()).toBeInTheDocument();
  });

  it.each([
    ['a still-running sprint', { status: 'running' }],
    ['a sprint with no captured text', { appendedText: '' }],
    ['a standalone sprint', { workId: null }],
  ])('hides the action for %s', async (_label, over) => {
    await renderPanel({ history: [exercise(over)] });
    expect(promoteButton()).not.toBeInTheDocument();
  });

  it('replaces the action with a promoted marker once the sprint is in the draft', async () => {
    await renderPanel({ history: [exercise({ promotedAt: '2026-01-01T00:00:00.000Z' })] });
    expect(promoteButton()).not.toBeInTheDocument();
    expect(screen.getByText('✓ in draft')).toBeInTheDocument();
  });

  it('disables the action with a save hint while the editor is dirty', async () => {
    await renderPanel({ history: [exercise()], editorDirty: true });
    expect(promoteButton()).toBeDisabled();
    expect(promoteButton()).toHaveAttribute('title', 'Save first');
  });

  it('pushes the updated work back to the editor and reloads history on success', async () => {
    const onWorkChange = vi.fn();
    await renderPanel({ history: [exercise()], onWorkChange });

    await act(async () => { fireEvent.click(promoteButton()); });

    expect(promoteWritersRoomExercise).toHaveBeenCalledWith('wr-ex-1', { silent: true });
    expect(onWorkChange).toHaveBeenCalledWith({ id: 'wr-work-1', activeDraftBody: 'The hero wakes.\n\nThen he runs.\n' });
    expect(toast.success).toHaveBeenCalledWith('Added 3 words to draft');
    // Mount load + the post-promote refresh, so the row can flip to the marker.
    expect(listWritersRoomExercises).toHaveBeenCalledTimes(2);
  });

  it('keeps the editor untouched when the promotion fails', async () => {
    const onWorkChange = vi.fn();
    promoteWritersRoomExercise.mockRejectedValueOnce(new Error('Exercise already promoted'));
    await renderPanel({ history: [exercise()], onWorkChange });

    await act(async () => { fireEvent.click(promoteButton()); });

    expect(onWorkChange).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not add to draft: Exercise already promoted');
  });
});
