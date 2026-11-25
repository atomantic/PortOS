import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const api = vi.hoisted(() => ({
  deleteDeck: vi.fn(), generateDeckPrompts: vi.fn(), getDeck: vi.fn(), listUniverseSummaries: vi.fn(),
  removeDeckSample: vi.fn(), renderDeckCard: vi.fn(), renderDeckCards: vi.fn(), updateDeck: vi.fn(),
  updateDeckCard: vi.fn(), deckPromptsProgressUrl: vi.fn(() => ''),
}));
vi.mock('../services/apiDecks.js', () => ({
  deleteDeck: api.deleteDeck,
  generateDeckPrompts: api.generateDeckPrompts,
  getDeck: api.getDeck,
  removeDeckSample: api.removeDeckSample,
  renderDeckCard: api.renderDeckCard,
  renderDeckCards: api.renderDeckCards,
  updateDeck: api.updateDeck,
  updateDeckCard: api.updateDeckCard,
  deckPromptsProgressUrl: api.deckPromptsProgressUrl,
}));
vi.mock('../services/apiUniverseBuilder.js', () => ({ listUniverseSummaries: api.listUniverseSummaries }));
vi.mock('../hooks/useDeckRenderTarget', () => ({ default: () => ({}) }));
vi.mock('../hooks/useHydratedPreviewRoute', () => ({ default: () => [null, vi.fn()] }));
vi.mock('../hooks/useSseProgress', () => ({ useSseProgress: () => ({ frames: [] }) }));
vi.mock('../components/decks/DeckRenderControls', () => ({ default: () => null }));
vi.mock('../components/decks/DeckCardGrid', () => ({ default: () => null }));
vi.mock('../components/decks/DeckStylePanel', () => ({ default: () => null }));
vi.mock('../components/decks/DeckCardDrawer', () => ({ default: () => null }));
vi.mock('../components/ui/Toast');

import DeckDetail from './DeckDetail';

describe('Deck detail universe link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getDeck.mockResolvedValue({ id: 'd1', name: 'Test Deck', kind: 'tarot', cards: [], universeId: 'u1' });
    api.listUniverseSummaries.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  });

  it('shows a retry row when the universe summary read fails', async () => {
    render(<MemoryRouter initialEntries={['/decks/d1']}><Routes><Route path="/decks/:id" element={<DeckDetail />} /></Routes></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Test Deck' })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load universes');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});

describe('Deck detail failed read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listUniverseSummaries.mockResolvedValue([]);
  });

  it('offers Retry for a failed read instead of saying the deck was deleted', async () => {
    api.getDeck.mockRejectedValueOnce(Object.assign(new Error('Server unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ id: 'd1', name: 'Test Deck', kind: 'tarot', cards: [] });
    render(<MemoryRouter initialEntries={['/decks/d1']}><Routes><Route path="/decks/:id" element={<DeckDetail />} /></Routes></MemoryRouter>);
    expect(await screen.findByText('Couldn’t load this deck')).toBeInTheDocument();
    expect(screen.queryByText('Deck not found')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Test Deck' })).toBeInTheDocument();
  });
});
