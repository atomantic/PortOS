import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BlurCommitTextarea from './BlurCommitTextarea.jsx';

describe('BlurCommitTextarea', () => {
  // Catches a parent re-render per keystroke (the shot prompt boxes lagged while typing).
  it('holds typing locally and commits once on blur, before onBlur', () => {
    const calls = [];
    const onCommit = vi.fn((text) => calls.push(`commit:${text}`));
    const onBlur = vi.fn(() => calls.push('blur'));
    render(<BlurCommitTextarea aria-label="Prompt" value="old" onCommit={onCommit} onBlur={onBlur} />);
    const box = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.change(box, { target: { value: 'new' } });
    fireEvent.change(box, { target: { value: 'newer' } });
    expect(box.value).toBe('newer');
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(box);
    expect(calls).toEqual(['commit:newer', 'blur']);
  });

  it('does not commit when nothing was typed and shows the parent value again after blur', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<BlurCommitTextarea aria-label="Prompt" value="old" onCommit={onCommit} />);
    const box = screen.getByRole('textbox', { name: 'Prompt' });
    fireEvent.blur(box);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'typed' } });
    fireEvent.blur(box);
    rerender(<BlurCommitTextarea aria-label="Prompt" value="saved" onCommit={onCommit} />);
    expect(box.value).toBe('saved');
  });
});
