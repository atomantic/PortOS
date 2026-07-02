import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import HunkDiff from './HunkDiff';

const lines = (p, n) => Array.from({ length: n }, (_, i) => `${p} line ${i}`).join('\n');

describe('HunkDiff', () => {
  it('shows the empty-label when the two texts are identical', () => {
    render(<HunkDiff oldText="same\ntext" newText="same\ntext" />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });

  it('word-highlights only the changed region, with surrounding context dimmed', () => {
    const oldText = `${lines('top', 3)}\nThe cat sat here\n${lines('bottom', 3)}`;
    const newText = `${lines('top', 3)}\nThe dog sat here\n${lines('bottom', 3)}`;
    const { container } = render(<HunkDiff oldText={oldText} newText={newText} />);
    const removed = container.querySelectorAll('.bg-port-error\\/20');
    const added = container.querySelectorAll('.bg-port-success\\/20');
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].textContent).toBe('cat');
    expect(added[0].textContent).toBe('dog');
    expect(screen.getByText(/1 changed region/)).toBeInTheDocument();
  });

  it('collapses long unchanged runs and expands them on click', () => {
    const oldText = `start A\n${lines('mid', 20)}\nend A`;
    const newText = `start B\n${lines('mid', 20)}\nend B`;
    render(<HunkDiff oldText={oldText} newText={newText} />);
    // 20 unchanged middle lines minus 2 context on each side = 16 hidden.
    const toggle = screen.getByText(/16 unchanged lines/);
    expect(screen.queryByText(/mid line 10/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(/mid line 10/)).toBeInTheDocument();
    expect(screen.queryByText(/16 unchanged lines/)).not.toBeInTheDocument();
  });

  it('stays word-granular on a long manuscript-sized section (past the flat word-diff cap)', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(' ');
    const oldText = `${body}\nmiddle cat paragraph\n${body}`;
    const newText = `${body}\nmiddle dog paragraph\n${body}`;
    const { container } = render(<HunkDiff oldText={oldText} newText={newText} />);
    const removed = container.querySelectorAll('.bg-port-error\\/20');
    expect(removed).toHaveLength(1);
    expect(removed[0].textContent).toBe('cat');
    expect(screen.queryByText(/Diff too large/)).not.toBeInTheDocument();
  });

  it('renders custom column labels', () => {
    render(<HunkDiff oldText="a" newText="b" oldLabel="Current" newLabel="With edits" />);
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('With edits')).toBeInTheDocument();
  });
});
