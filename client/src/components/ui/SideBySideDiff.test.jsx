import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import SideBySideDiff from './SideBySideDiff';

describe('SideBySideDiff', () => {
  it('shows the empty-label when the two texts are identical', () => {
    render(<SideBySideDiff oldText="Hello world" newText="Hello world" />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });

  it('renders both columns with their labels when the texts differ', () => {
    render(<SideBySideDiff oldText="The cat sat" newText="The dog sat" oldLabel="Old" newLabel="New" />);
    expect(screen.getByText('Old')).toBeInTheDocument();
    expect(screen.getByText('New')).toBeInTheDocument();
    expect(screen.queryByText('No changes.')).not.toBeInTheDocument();
  });

  it('highlights removed words on the left and added words on the right', () => {
    const { container } = render(<SideBySideDiff oldText="The cat sat" newText="The dog sat" />);
    const removed = container.querySelectorAll('.bg-port-error\\/20');
    const added = container.querySelectorAll('.bg-port-success\\/20');
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].textContent).toBe('cat');
    expect(added[0].textContent).toBe('dog');
  });

  it('falls back to both-versions-in-full past the diff cell cap', () => {
    const build = (p) => Array.from({ length: 2500 }, (_, i) => `${p}${i}`).join(' ');
    const { container } = render(<SideBySideDiff oldText={build('a')} newText={build('b')} />);
    expect(screen.getByText(/Diff too large/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.bg-port-error\\/20, .bg-port-success\\/20')).toHaveLength(0);
  });

  it('treats null/undefined as empty (identical → empty label)', () => {
    render(<SideBySideDiff oldText={null} newText={undefined} />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });
});
