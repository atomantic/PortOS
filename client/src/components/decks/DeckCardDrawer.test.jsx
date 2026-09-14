import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import DeckCardDrawer from './DeckCardDrawer';

const deck = {
  id: 'd1',
  kind: 'tarot',
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
});
