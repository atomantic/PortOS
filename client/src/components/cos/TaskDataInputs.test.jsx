import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TaskDataInputs from './TaskDataInputs';

const CATALOG = [
  { id: 'project-goals', label: 'Project goals', description: 'Include GOALS.md.' },
  { id: 'open-issues', label: 'Open issues', description: 'Include open issues.' },
];

describe('TaskDataInputs', () => {
  it('toggles ids while preserving catalog-independent selection order', () => {
    const onChange = vi.fn();
    render(<TaskDataInputs catalog={CATALOG} value={['project-goals']} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Project goals: on' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Open issues: off' }));
    expect(onChange).toHaveBeenCalledWith(['project-goals', 'open-issues']);

    fireEvent.click(screen.getByRole('button', { name: 'Project goals: on' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('renders nothing until the server catalog is available', () => {
    const { container } = render(<TaskDataInputs value={[]} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
