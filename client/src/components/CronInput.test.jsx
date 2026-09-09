import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import CronInput from './CronInput.jsx';

describe('CronInput', () => {
  it('makes an edited schedule visibly unsaved and clears the state after the saved value changes', () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <CronInput value="0 7 * * *" onSave={onSave} onCancel={vi.fn()} />,
    );

    expect(screen.queryByText(/Unsaved changes/i)).toBeNull();

    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '03:30' } });

    expect(screen.getByText('Unsaved changes — save before closing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save schedule' })).toHaveClass('ring-2');

    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledWith('30 3 * * *');

    rerender(<CronInput value="30 3 * * *" onSave={onSave} onCancel={vi.fn()} />);
    expect(screen.queryByText(/Unsaved changes/i)).toBeNull();
  });

  it('confirms before discarding an edited schedule from the close control', () => {
    const onCancel = vi.fn();
    render(<CronInput value="0 7 * * *" onSave={vi.fn()} onCancel={onCancel} />);

    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '03:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule edits' }));

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Discard your unsaved schedule changes?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByText('Discard your unsaved schedule changes?')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule edits' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Unsaved changes/i)).toBeNull();
  });

  it('blocks saving an out-of-range expression and says which field is wrong', () => {
    // #6634: the editor used to enable Save on any 5-token expression, so the
    // user could save a schedule the server now 400s and the scheduler could
    // never fire.
    const onSave = vi.fn();
    render(<CronInput value="0 7 * * *" onSave={onSave} onCancel={vi.fn()} />);

    const expression = screen.getByLabelText('Cron expression');
    fireEvent.change(expression, { target: { value: '99 9 * * *' } });

    const save = screen.getByRole('button', { name: 'Save schedule' });
    expect(save).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Invalid minute field');
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();

    // A leap-day cron has no occurrence in the scheduler's search window but is
    // valid syntax, so the editor must not block it.
    fireEvent.change(expression, { target: { value: '0 0 29 2 *' } });
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(onSave).toHaveBeenCalledWith('0 0 29 2 *');
  });

  it('closes immediately when there are no edits', () => {
    const onCancel = vi.fn();
    render(<CronInput value="0 7 * * *" onSave={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close schedule editor' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Discard your unsaved schedule changes/i)).toBeNull();
  });
});
