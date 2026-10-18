import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OutputBlocks from './OutputBlocks';

// Tool lines render one block each, so block counts equal line counts here.
const toolLines = (count, from = 0) => Array.from({ length: count }, (_, i) => ({ line: `🔧 step ${from + i}` }));

describe('OutputBlocks paging windows', () => {
  it('shows a live transcript tail-first and pages backwards', () => {
    const { rerender } = render(<OutputBlocks output={toolLines(200)} anchor="tail" />);

    expect(screen.getByText('🔧 step 199')).toBeInTheDocument();
    expect(screen.getByText('🔧 step 120')).toBeInTheDocument();
    expect(screen.queryByText('🔧 step 119')).not.toBeInTheDocument();
    expect(screen.queryByText(/Show more/)).not.toBeInTheDocument();

    // A line the agent writes now lands in view; the window slides, not freezes.
    rerender(<OutputBlocks output={[...toolLines(200), { line: '🔧 step 200' }]} anchor="tail" />);
    expect(screen.getByText('🔧 step 200')).toBeInTheDocument();
    expect(screen.queryByText('🔧 step 120')).not.toBeInTheDocument();

    // Paging backwards grows the window by a page; the tail stays in view.
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier (121)' }));
    expect(screen.getByText('🔧 step 1')).toBeInTheDocument();
    expect(screen.getByText('🔧 step 200')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show earlier (1)' }));
    expect(screen.getByText('🔧 step 0')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show earlier/ })).not.toBeInTheDocument();
  });

  it('keeps finished transcripts head-first with forward paging', () => {
    render(<OutputBlocks output={toolLines(200)} />);

    expect(screen.getByText('🔧 step 0')).toBeInTheDocument();
    expect(screen.getByText('🔧 step 79')).toBeInTheDocument();
    expect(screen.queryByText('🔧 step 80')).not.toBeInTheDocument();
    expect(screen.queryByText(/Show earlier/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show more (120 remaining)' }));
    expect(screen.getByText('🔧 step 199')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });
});
