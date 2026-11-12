import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CombineMoodBoards from './CombineMoodBoards';
import { combineMoodBoards } from '../../services/apiMoodBoard';

vi.mock('../../services/apiMoodBoard', () => ({ combineMoodBoards: vi.fn() }));

describe('combining mood boards', () => {
  it('requires two distinct sources, keeps failed inputs, and opens the created board after retry', async () => {
    const onCreated = vi.fn();
    combineMoodBoards.mockRejectedValueOnce(new Error('Source board was deleted'))
      .mockResolvedValueOnce({ id: 'composite' });
    render(<CombineMoodBoards boards={[{ id: 'a', name: 'Ink' }, { id: 'b', name: 'Neon' }]} onClose={vi.fn()} onCreated={onCreated} />);
    const submit = screen.getByRole('button', { name: 'Create composite board' });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('First board'), 'a');
    expect(screen.getByLabelText('Second board').querySelector('option[value="a"]')).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Second board'), 'b');
    await userEvent.clear(screen.getByLabelText('New board name'));
    await userEvent.type(screen.getByLabelText('New board name'), 'Ink neon');
    await userEvent.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('Source board was deleted');
    expect(onCreated).not.toHaveBeenCalled();
    await userEvent.click(submit);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'composite' }));
    expect(combineMoodBoards).toHaveBeenLastCalledWith({ name: 'Ink neon', boardIds: ['a', 'b'] }, { silent: true });
  });
});
