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
  it('groups cards by suit/arcana with a rendered count per group', () => {
    renderGrid();
    const major = screen.getByRole('region', { name: 'Major Arcana' });
    expect(within(major).getByText('1/2')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Cups' })).getByText('0/3')).toBeInTheDocument();
  });

  it('offers a render only for prompted, idle cards and routes the click to that card', () => {
    const props = renderGrid();
    // EntryThumbSlot names the empty slot by its state: a renderable card reads
    // "Render image…", a blocked one carries the slot's disabled copy. Card a
    // (prompted) and d (failed, retryable) are enabled; e has no prompt.
    const enabled = screen.getAllByRole('button', { name: /render image for this item/i });
    expect(enabled).toHaveLength(2);
    expect(screen.getByRole('button', { name: /save the universe first/i })).toBeDisabled();
    fireEvent.click(enabled[0]);
    expect(props.onRenderCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it('derives every badge from the card record: in-flight, rendered, failed, ready, needs prompt', () => {
    renderGrid();
    expect(screen.getByText('rendering')).toBeInTheDocument();
    expect(screen.getByText('rendered')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    expect(screen.getByText('needs prompt')).toBeInTheDocument();
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
