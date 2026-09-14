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

// The page resolves this once (`useDeckRenderTarget`) and hands the same object
// to the render bar and the grid; the grid uses only these two fields.
const renderTarget = (over = {}) => ({ summary: 'Local · flux2-klein-9b · 1096×1536', blocked: false, ...over });

const renderGrid = (over = {}) => {
  const props = {
    deck, renderTarget: renderTarget(), onOpenCard: vi.fn(), onRenderCard: vi.fn(), onPreview: vi.fn(),
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

  // A rendered card's slot is a lightbox opener, so before this button the only
  // way to redo the one card you disliked was its drawer or the whole deck.
  it('re-renders one card on the options the bar above is configured with', () => {
    const props = renderGrid();
    const reRender = screen.getByRole('button', { name: 'Re-render Card b on Local · flux2-klein-9b · 1096×1536' });
    fireEvent.click(reRender);
    expect(props.onRenderCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    // A card that has never rendered gets the same button, worded for a first run.
    expect(screen.getByRole('button', { name: 'Render Card a on Local · flux2-klein-9b · 1096×1536' })).toBeEnabled();
  });

  it('names why a card cannot be rendered rather than showing a bare dead icon', () => {
    renderGrid();
    // No prompt, and already rendering: both fixable, neither by this button.
    expect(screen.getByRole('button', { name: 'Write a prompt for Card e before rendering it' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Card c is rendering' })).toBeDisabled();
  });

  it('stands every card button down while the local runtime is unavailable', () => {
    renderGrid({ renderTarget: renderTarget({ blocked: true }) });
    const blocked = screen.getAllByRole('button', { name: /the local image runtime is unavailable/ });
    // Every card except the promptless one and the in-flight one, which each
    // keep their own more specific reason.
    expect(blocked).toHaveLength(3);
    blocked.forEach((b) => expect(b).toBeDisabled());
  });
});
