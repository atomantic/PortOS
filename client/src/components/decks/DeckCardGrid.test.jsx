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
  kind: 'playing',
  cardSize: { width: 1096, height: 1536 },
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
  it('shows the complete failure beside an enabled retry and clears it after success', () => {
    const error = `Render failed: ${'diagnostic '.repeat(60)}${'x'.repeat(180)}. Remedy: select an available model and retry.`;
    const failed = card('failed', 'major', { prompt: 'a fool', render: { status: 'failed', error } });
    const props = {
      deck: { ...deck, cards: [failed] }, renderTarget: renderTarget(),
      onOpenCard: vi.fn(), onRenderCard: vi.fn(),
    };
    const { rerender } = render(<DeckCardGrid {...props} />);
    const message = screen.getByText(error);
    expect(message).toBeVisible();
    expect(message).not.toHaveAttribute('title');
    expect(message).not.toHaveClass('line-clamp-3');
    expect(message).toHaveClass('[overflow-wrap:anywhere]');
    const retry = screen.getByRole('button', { name: /^Render Card failed$/ });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(props.onRenderCard).toHaveBeenCalledWith(failed);
    expect(props.onOpenCard).not.toHaveBeenCalled();

    rerender(<DeckCardGrid {...props} deck={{ ...deck, cards: [{
      ...failed, imageRefs: ['result.png'], primaryImageRef: 'result.png',
      render: { status: 'completed', filename: 'result.png' },
    }] }} />);
    expect(screen.queryByText(error)).toBeNull();
    expect(screen.getByText('Rendered')).toBeInTheDocument();
  });

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
    expect(screen.getAllByRole('button', { name: /^Render / })).toHaveLength(2);
    renderable.forEach((button) => expect(button).toBeEnabled());
    fireEvent.click(renderable[0]);
    fireEvent.click(renderable[1]);
    expect(props.onRenderCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'd' }));
    expect(props.onRenderCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));

    const write = screen.getByRole('button', { name: 'Write a prompt for Card e' });
    expect(write).toBeEnabled();
    fireEvent.click(write);
    expect(props.onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'e' }));
    expect(props.onRenderCard).toHaveBeenCalledTimes(2);
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
    fireEvent.click(screen.getByRole('img', { name: 'Card b' }));
    expect(props.onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'b.png');
    expect(props.onRenderCard).toHaveBeenCalledTimes(1);
  });

  it('keeps queued cards out of the render actions and promptless cards on the editor path', () => {
    renderGrid();
    const queued = screen.getByText('Card c').closest('li');
    expect(within(queued).queryByRole('button', { name: /render/i })).toBeNull();
    const promptless = screen.getByText('Card e').closest('li');
    expect(within(promptless).getByRole('button', { name: 'Write a prompt for Card e' })).toBeEnabled();
    expect(within(promptless).queryByRole('button', { name: /render/i })).toBeNull();
  });

  it('stands every render affordance down while the local runtime is unavailable', () => {
    const props = renderGrid({ renderTarget: renderTarget({ blocked: true }) });
    const blocked = screen.getAllByRole('button', { name: /the local image runtime is unavailable/ });
    // One action each: empty slots for a/d and the rendered card's footer.
    expect(blocked).toHaveLength(3);
    blocked.forEach((b) => {
      expect(b).toBeDisabled();
      fireEvent.click(b);
    });
    expect(props.onRenderCard).not.toHaveBeenCalled();
    // The promptless card keeps its way out: that slot opens the editor, which
    // works whatever the runtime is doing.
    const write = screen.getByRole('button', { name: 'Write a prompt for Card e' });
    expect(write).toBeEnabled();
    fireEvent.click(write);
    expect(props.onOpenCard).toHaveBeenCalledWith(expect.objectContaining({ id: 'e' }));
  });

  it('displays v1 indicator for a card with one render', () => {
    renderGrid();
    expect(screen.getByText('v1')).toBeInTheDocument();
  });

  it('identifies the service and model for the active render', () => {
    renderGrid({
      deck: {
        ...deck,
        cards: [card('rendered', 'major', {
          prompt: 'a rendered card', imageRefs: ['rendered.png'], primaryImageRef: 'rendered.png',
          render: { status: 'completed', mode: 'local', model: 'flux2-klein-9b', filename: 'rendered.png' },
        })],
      },
    });

    expect(screen.getByText('Rendered by Local · flux2-klein-9b')).toBeInTheDocument();
  });

  it('does not attribute a non-active version to the current card', () => {
    renderGrid({
      deck: {
        ...deck,
        cards: [card('versions', 'major', {
          prompt: 'versioned card', imageRefs: ['old.png', 'active.png'], primaryImageRef: 'active.png',
          render: { status: 'completed', mode: 'local', model: 'flux2-klein-9b', filename: 'active.png' },
        })],
      },
    });

    const prev = screen.getByRole('button', { name: 'Previous render version for Card versions' });
    fireEvent.click(prev);
    expect(screen.queryByText('Rendered by Local · flux2-klein-9b')).not.toBeInTheDocument();
  });

  it('allows viewing different versions and toggling active version on a multi-render card', () => {
    const multiDeck = {
      id: 'd1',
      cards: [
        card('f', 'major', {
          prompt: 'lovers',
          imageRefs: ['f1.png', 'f2.png', 'f3.png'],
          primaryImageRef: 'f3.png',
        }),
      ],
    };
    const onSetActiveVersion = vi.fn();
    const onPreview = vi.fn();
    renderGrid({ deck: multiDeck, onSetActiveVersion, onPreview });

    // Starts at v3/3 which is active
    expect(screen.getByText('v3/3')).toBeInTheDocument();
    expect(screen.getByTitle('Active version for this card')).toBeInTheDocument();

    // Click previous to view v2
    const prevBtn = screen.getByRole('button', { name: 'Previous render version for Card f' });
    fireEvent.click(prevBtn);

    expect(screen.getByText('v2/3')).toBeInTheDocument();
    // v2 is not active, so "Set active" button should appear
    const setActiveBtn = screen.getByRole('button', { name: 'Set v2 as active version for Card f' });
    expect(setActiveBtn).toBeInTheDocument();

    // Clicking Set active fires onSetActiveVersion
    fireEvent.click(setActiveBtn);
    expect(onSetActiveVersion).toHaveBeenCalledWith('f', 'f2.png');

    // Click preview on the thumbnail should open v2
    const thumbImg = screen.getByRole('img', { name: 'Card f' });
    expect(thumbImg).toHaveAttribute('src', '/data/image-thumbnails/f2.webp');
    fireEvent.click(thumbImg);
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' }), 'f2.png');

    // Click previous again to reach v1
    fireEvent.click(prevBtn);
    expect(screen.getByText('v1/3')).toBeInTheDocument();
    expect(prevBtn).toBeDisabled();

    // Next button moves back to v2
    const nextBtn = screen.getByRole('button', { name: 'Next render version for Card f' });
    fireEvent.click(nextBtn);
    expect(screen.getByText('v2/3')).toBeInTheDocument();
  });

  it('sizes a playing-card thumb to 5:7 and contains the art so the index is not cropped', () => {
    renderGrid();
    const img = screen.getByRole('img', { name: 'Card b' });
    expect(img.className).toMatch(/\bobject-contain\b/);
    expect(img.className).not.toMatch(/\bobject-cover\b/);
    expect(img.closest('.overflow-hidden')?.style.aspectRatio).toBe('1096 / 1536');
  });

  it('sizes a tarot thumb to 11:19 so the title banner is not cropped', () => {
    const tarotDeck = {
      id: 'd1',
      kind: 'tarot',
      cardSize: { width: 888, height: 1536 },
      cards: [
        card('f', 'major', { prompt: 'the fool', imageRefs: ['fool.png'], primaryImageRef: 'fool.png' }),
      ],
    };
    renderGrid({ deck: tarotDeck });
    const img = screen.getByRole('img', { name: 'Card f' });
    expect(img.className).toMatch(/\bobject-contain\b/);
    expect(img.closest('.overflow-hidden')?.style.aspectRatio).toBe('888 / 1536');
  });
});
