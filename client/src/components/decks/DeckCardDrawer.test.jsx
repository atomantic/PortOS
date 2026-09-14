import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeckCardDrawer from './DeckCardDrawer';

const deck = {
  id: 'd1',
  kind: 'tarot',
  cardSize: { width: 888, height: 1536 },
  layoutPrompt: 'Full tarot card, framed border',
  influences: { embrace: ['copperplate engraving'], avoid: ['blurry'] },
};
const card = {
  id: 'c1', key: 'major-0', name: 'The Fool', groupLabel: 'Major Arcana',
  prompt: 'a youth at a cliff edge', negativePrompt: 'text', imageRefs: [],
  primaryImageRef: null, render: null, canonRef: null,
};

const renderDrawer = (over = {}) => render(
  <DeckCardDrawer
    deck={deck}
    card={card}
    open
    inFlight={null}
    onClose={vi.fn()}
    onSave={vi.fn()}
    onRender={vi.fn()}
    onPreview={vi.fn()}
    {...over}
  />,
);

describe('DeckCardDrawer render prompt', () => {
  it('attributes each clause, so deck-wide wording is not mistaken for the card', () => {
    renderDrawer();
    expect(screen.getByText('copperplate engraving')).toBeInTheDocument();
    expect(screen.getByText('Full tarot card, framed border')).toBeInTheDocument();
    expect(screen.getByText('The Fool: a youth at a cliff edge')).toBeInTheDocument();
    expect(screen.getByText('text, blurry')).toBeInTheDocument();
    expect(screen.getByText(/copperplate engraving\. Full tarot card, framed border\. The Fool: a youth at a cliff edge/)).toBeInTheDocument();
  });

  it('still names a clause the deck has not filled in', () => {
    renderDrawer({ deck: { id: 'd1', kind: 'tarot' } });
    // "Deck style: —" is the answer to "why doesn't my card match the deck?";
    // dropping the empty row hides the answer.
    expect(screen.getByText('Deck style')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders each version with v{N}, active indicator, and unrounded thumbnail', () => {
    const onSave = vi.fn();
    renderDrawer({
      card: {
        ...card,
        imageRefs: ['fool-v1.png', 'fool-v2.png'],
        primaryImageRef: 'fool-v2.png',
      },
      onSave,
    });

    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('v2')).toBeInTheDocument();

    // v2 is active
    expect(screen.getByRole('button', { name: 'v2 is active' })).toBeDisabled();

    // v1 is not active, can be set as active
    const setActiveBtn = screen.getByRole('button', { name: 'Set v1 as active' });
    expect(setActiveBtn).toBeEnabled();
    setActiveBtn.click();
    expect(onSave).toHaveBeenCalledWith({ primaryImageRef: 'fool-v1.png' });

    // Thumbnails should not have rounded corners cutting off card art, and
    // must use the deck's own trim (not a 2:3 cover box) so the banner stays
    // in frame.
    const imgs = screen.getAllByRole('img');
    expect(imgs.length).toBe(2);
    imgs.forEach((img) => {
      expect(img.className).not.toMatch(/\brounded\b/);
      expect(img.className).toMatch(/\bobject-contain\b/);
      expect(img.className).not.toMatch(/\bobject-cover\b/);
      expect(img.className).not.toMatch(/aspect-\[2\/3\]/);
      expect(img.style.aspectRatio).toBe('888 / 1536');
    });
  });
});

