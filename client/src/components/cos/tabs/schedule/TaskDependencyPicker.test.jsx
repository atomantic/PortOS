import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TaskDependencyPicker from './TaskDependencyPicker';

const OPTIONS = ['simplify', 'module-hygiene', 'better-complexity', 'self'];

function renderPicker(props = {}) {
  const onChange = vi.fn();
  render(
    <TaskDependencyPicker
      label="Suggested order (advisory)"
      taskType="self"
      options={OPTIONS}
      value={['simplify']}
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
}

describe('TaskDependencyPicker', () => {
  it('offers only unselected tasks, and never the task itself', () => {
    renderPicker();
    const select = screen.getByLabelText('Suggested order (advisory)');
    const values = [...select.options].map(option => option.value);
    expect(values).toEqual(['', 'better-complexity', 'module-hygiene']);
  });

  it('appends the chosen task to the list', () => {
    const { onChange } = renderPicker();
    fireEvent.change(screen.getByLabelText('Suggested order (advisory)'), { target: { value: 'module-hygiene' } });
    expect(onChange).toHaveBeenCalledWith(['simplify', 'module-hygiene']);
  });

  it('removes a chip, handing back an empty list rather than nothing', () => {
    const { onChange } = renderPicker();
    fireEvent.click(screen.getByLabelText('Remove simplify'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('disables the roster when there is nothing left to add', () => {
    renderPicker({ value: ['simplify', 'module-hygiene', 'better-complexity'] });
    expect(screen.getByLabelText('Suggested order (advisory)')).toBeDisabled();
  });
});
