import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DeckCardGrid from './DeckCardGrid';

// MediaJobThumb (the pending branch of EntryThumbSlot) subscribes to a socket;
// stub the hook so the in-flight card renders without a live queue.
vi.mock('../../hooks/useMediaJobProgress', () => ({
  default: () => ({ status: 'running', progress: 0.4, step: 4, totalSteps: 10, currentImage: null, filename: null, error: null }),
}));

const card = (id, group, extra = {}) => ({
  id, key: id, name: `Card ${id}`, group, groupLabel: group === 'major' ? 'Major Arcana' : 'Cups',
  prompt: '', imageRefs: [], primaryImageRef: null, render: null, canonRef: null, ...extra,
});
const deck = {
  id: 'd1',
  cards: [
    card('a', 'major', { prompt: 'a fool' }),
    card('b', 'major', { prompt: 'a magician', imageRefs: ['b.png'], primaryImageRef: 'b.png', canonRef: { kind: 'character', id: 'c1', name: 'Alice' } }),
    card('c', 'cups', { prompt: 'an ace', render: { jobId: 'job-c', status: 'queued' } }),
    card('d', 'cups', { prompt: 'a two', render: { jobId: 'job-d', status: 'canceled' } }),
    card('e', 'cups'),
  ],
};

const renderGrid = (over = {}) => {
  const props = {
    deck, onOpenCard: vi.fn(), onRenderCard: vi.fn(), onPreview: vi.fn(),
    onRenderComplete: vi.fn(), onRenderTerminal: vi.fn(), ...over,
  };
  render(<DeckCardGrid {...props} />);
  return props;
};

describe('DeckCardGrid', () => {
  it('spells out each group\'s rendered count and how many still need a prompt', () => {
    renderGrid();
    const major = screen.getByRole('region', { name: 'Major Arcana' });
    expect(within(major).getByText('1/2 rendered')).toBeInTheDocument();
    expect(within(major).queryByText(/need a prompt/)).toBeNull();
    const cups = screen.getByRole('region', { name: 'Cups' });
    expect(within(cups).getByText('0/3 rendered')).toBeInTheDocument();
    expect(within(cups).getByText('1 need a prompt')).toBeInTheDocument();
  });

  it('renders a prompted card from its slot and sends a promptless one to its editor', () => {
    const props = renderGrid();
    // Card a (prompted) and d (failed, retryable) render; e has no prompt, so
    // its slot is an opening into the editor rather than a dead grey button.
    const renderable = screen.getAllByRole('button', { name: /^Render Card [ad]$/ });
    expect(renderable).toHaveLength(2);
    fireEvent.click(renderable[0]);
    expect(props.onRenderCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));

    const write = screen.getByRole('button', { name: 'Write a prompt for Card e' });
    expect(write).toBeEnabled();
    fireEvent.click(write);
    expect(props.onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'e' }));
    expect(props.onRenderCard).toHaveBeenCalledTimes(1);
  });

  it('derives every badge from the card record: in-flight, rendered, failed, ready, needs prompt', () => {
    renderGrid();
    expect(screen.getByText('Rendering…')).toBeInTheDocument();
    expect(screen.getByText('Rendered')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Ready to render')).toBeInTheDocument();
    expect(screen.getByText('Needs prompt')).toBeInTheDocument();
  });

  it('opens the drawer from the card name and shows the cast canon entry', () => {
    const props = renderGrid();
    // The completed thumb is also a button named by the card, so reach the
    // name button through its title (second card of the first group).
    fireEvent.click(screen.getAllByTitle('Edit this card')[1]);
    expect(props.onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
