import { describe, it, expect } from 'vitest';
import {
  CARD_STATUS, DECK_BACK_KEY, DECK_KIND, cardStatus, composeCardRenderPrompt, deckCardRoster, deckCompletion,
} from './deckTemplates.js';

describe('deckCardRoster', () => {
  it('mints a full playing deck (52 faces + 2 jokers + back) with unique keys', () => {
    const roster = deckCardRoster(DECK_KIND.PLAYING);
    expect(roster).toHaveLength(55);
    expect(new Set(roster.map((c) => c.key)).size).toBe(55);
    expect(roster.find((c) => c.key === 'hearts-Q')).toMatchObject({ name: 'Queen of Hearts', group: 'hearts', rank: 'Q' });
    expect(roster.at(-1).key).toBe(DECK_BACK_KEY);
  });

  it('mints a full tarot deck (22 major + 56 minor + back) with motifs on the majors', () => {
    const roster = deckCardRoster(DECK_KIND.TAROT);
    expect(roster).toHaveLength(79);
    expect(new Set(roster.map((c) => c.key)).size).toBe(79);
    expect(roster.filter((c) => c.group === 'major')).toHaveLength(22);
    expect(roster.find((c) => c.key === 'major-16')).toMatchObject({ name: 'XVI · The Tower', rank: 'XVI' });
    expect(roster.find((c) => c.key === 'major-16').motif).toMatch(/lightning/);
    expect(roster.find((c) => c.key === 'cups-knight')).toMatchObject({ name: 'Knight of Cups', group: 'cups' });
  });

  it('rejects an unknown kind', () => {
    expect(() => deckCardRoster('uno')).toThrow(/Unknown deck kind/);
  });
});

describe('composeCardRenderPrompt', () => {
  const deck = {
    influences: { embrace: ['copperplate engraving', ' aged paper '], avoid: ['blurry'] },
    layoutPrompt: 'Full tarot card, framed border',
  };

  it('leads with the style tokens, then the layout, then the titled subject; negatives merge card-first', () => {
    const out = composeCardRenderPrompt(deck, { name: 'XVII · The Star', prompt: 'a kneeling figure pouring water', negativePrompt: 'text' });
    expect(out.prompt).toBe('copperplate engraving, aged paper. Full tarot card, framed border. XVII · The Star: a kneeling figure pouring water');
    expect(out.negativePrompt).toBe('text, blurry');
  });

  it('degrades cleanly when the deck has no style guide yet', () => {
    const out = composeCardRenderPrompt({}, { name: 'Ace of Spades', prompt: 'one large ornate spade' });
    expect(out.prompt).toBe('Ace of Spades: one large ornate spade');
    expect(out.negativePrompt).toBe('');
    expect(out.parts).toEqual({ style: '', layout: '', subject: 'Ace of Spades: one large ornate spade', cardNegative: '', styleNegative: '' });
  });

  it('reports each contribution unjoined so the editor can attribute it', () => {
    const out = composeCardRenderPrompt(deck, { name: 'XVII · The Star', prompt: 'a kneeling figure', negativePrompt: 'text' });
    expect(out.parts).toEqual({
      style: 'copperplate engraving, aged paper',
      layout: 'Full tarot card, framed border',
      subject: 'XVII · The Star: a kneeling figure',
      cardNegative: 'text',
      styleNegative: 'blurry',
    });
  });
});

describe('cardStatus + deckCompletion', () => {
  it('derives the render state from the persisted render record and image refs', () => {
    expect(cardStatus({ prompt: '' })).toBe(CARD_STATUS.EMPTY);
    expect(cardStatus({ prompt: 'x' })).toBe(CARD_STATUS.PROMPTED);
    expect(cardStatus({ prompt: 'x', render: { status: 'queued' } })).toBe(CARD_STATUS.QUEUED);
    expect(cardStatus({ prompt: 'x', render: { status: 'running' } })).toBe(CARD_STATUS.RUNNING);
    // A prior image survives a later failed re-render — the card is still rendered.
    expect(cardStatus({ prompt: 'x', imageRefs: ['a.png'], render: { status: 'failed' } })).toBe(CARD_STATUS.RENDERED);
    expect(cardStatus({ prompt: 'x', imageRefs: [], render: { status: 'canceled' } })).toBe(CARD_STATUS.FAILED);
  });

  it('counts rendered / prompted / in-flight / failed and a whole-deck percent', () => {
    const counts = deckCompletion([
      { prompt: 'a', imageRefs: ['1.png'] },
      { prompt: 'b', render: { status: 'running' } },
      { prompt: 'c', render: { status: 'failed' } },
      { prompt: '' },
    ]);
    expect(counts).toEqual({ total: 4, prompted: 3, rendered: 1, inFlight: 1, failed: 1, percent: 25 });
    expect(deckCompletion([]).percent).toBe(0);
  });
});
