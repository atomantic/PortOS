import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import InlineDiff from './InlineDiff';

describe('InlineDiff', () => {
  it('shows the empty-label when the two texts are identical', () => {
    render(<InlineDiff oldText="Hello world" newText="Hello world" />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });

  it('shows a custom empty-label when supplied', () => {
    render(<InlineDiff oldText="" newText="" emptyLabel="(blank on both sides)" />);
    expect(screen.getByText('(blank on both sides)')).toBeInTheDocument();
  });

  it('renders both stacked rows when the texts differ', () => {
    const { container } = render(<InlineDiff oldText="The cat sat" newText="The dog sat" />);
    expect(screen.queryByText('No changes.')).not.toBeInTheDocument();
    // Two stacked diff rows — the red (removed) and green (added) divs.
    expect(container.querySelectorAll('.text-red-400')).toHaveLength(1);
    expect(container.querySelectorAll('.text-green-400')).toHaveLength(1);
  });

  it('highlights only the changed words inside each row, not the unchanged ones', () => {
    const { container } = render(<InlineDiff oldText="The cat sat" newText="The dog sat" />);
    // Removed-word span lives inside the red row.
    const removedSpans = container.querySelectorAll('.text-red-400 .bg-red-900\\/50');
    const addedSpans = container.querySelectorAll('.text-green-400 .bg-green-900\\/50');
    expect(removedSpans).toHaveLength(1);
    expect(addedSpans).toHaveLength(1);
    expect(removedSpans[0].textContent).toBe('cat');
    expect(addedSpans[0].textContent).toBe('dog');
  });

  it('tolerates null/undefined inputs by treating them as empty strings', () => {
    render(<InlineDiff oldText={null} newText={undefined} />);
    expect(screen.getByText('No changes.')).toBeInTheDocument();
  });

  it('bails to plain side-by-side render when m·n exceeds the DP-cell budget', () => {
    // 2500 words on each side → 5000 tokens after whitespace split → 25M cells,
    // well past the 4M budget; bail to the fallback.
    const buildHuge = (prefix) => Array.from({ length: 2500 }, (_, i) => `${prefix}${i}`).join(' ');
    const { container } = render(<InlineDiff oldText={buildHuge('a')} newText={buildHuge('b')} />);
    expect(screen.getByText(/Diff too large/i)).toBeInTheDocument();
    // No per-word highlight spans — just the two flat color blocks.
    expect(container.querySelectorAll('.bg-red-900\\/50, .bg-green-900\\/50')).toHaveLength(0);
  });

  it('stays within the LCS path when one side is short, even if the other is long', () => {
    // 5000 words × 2 tokens = 10K, but other side has 1 token → 10K cells (in budget).
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(' ');
    render(<InlineDiff oldText={long} newText="x" />);
    expect(screen.queryByText(/Diff too large/i)).not.toBeInTheDocument();
  });
});
