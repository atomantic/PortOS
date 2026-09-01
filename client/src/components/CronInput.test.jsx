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

  it('closes immediately when there are no edits', () => {
    const onCancel = vi.fn();
    render(<CronInput value="0 7 * * *" onSave={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: 'Close schedule editor' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Discard your unsaved schedule changes/i)).toBeNull();
  });
});
