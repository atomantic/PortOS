import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import DeckDetail from './DeckDetail';
import { MockEventSource } from '../test/mockEventSource';

const api = vi.hoisted(() => ({ getDeck: vi.fn(), generateDeckPrompts: vi.fn() }));

vi.mock('../services/api', () => ({
  deleteDeck: vi.fn(),
  deckPromptsProgressUrl: (id) => `/api/decks/${encodeURIComponent(id)}/generate-prompts/progress`,
  generateDeckPrompts: (...args) => api.generateDeckPrompts(...args),
  getDeck: (...args) => api.getDeck(...args),
  listUniverseSummaries: vi.fn().mockResolvedValue([]),
  removeDeckSample: vi.fn(),
  renderDeckCard: vi.fn(),
  renderDeckCards: vi.fn(),
  updateDeck: vi.fn(),
  updateDeckCard: vi.fn(),
}));
vi.mock('../services/apiImageVideo', () => ({ getGalleryImages: vi.fn(), getVideoHistoryItem: vi.fn() }));
vi.mock('../components/media/MediaPreview', () => ({ default: () => null }));
vi.mock('../components/decks/DeckRenderControls', () => ({
  default: ({ onGeneratePrompts, generatingStatus }) => (
    <div>
      <button type="button" onClick={() => onGeneratePrompts({ overwrite: false })}>Generate prompts</button>
      {generatingStatus ? <div role="status">{generatingStatus}</div> : null}
    </div>
  ),
}));
vi.mock('../components/decks/DeckCardGrid', () => ({ default: () => null }));
vi.mock('../components/decks/DeckCardDrawer', () => ({ default: () => null }));
vi.mock('../components/decks/DeckStylePanel', () => ({ default: () => null }));
vi.mock('../hooks/useDeckRenderTarget', () => ({ default: () => ({ summary: '', blocked: false }) }));

const deck = {
  id: 'deck-example',
  name: 'Example Deck',
  kind: 'playing',
  universeId: null,
  influences: { embrace: [], avoid: [] },
  cardSize: { width: 1096, height: 1536 },
  samples: [],
  cards: [{
    id: 'card-example', key: 'hearts-ace', name: 'Ace of Hearts', group: 'suit', groupLabel: 'Hearts',
    prompt: '', negativePrompt: '', imageRefs: [], primaryImageRef: null, render: null, canonRef: null,
  }],
};

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const renderPage = async () => {
  render(
    <MemoryRouter initialEntries={['/decks/deck-example']}>
      <Routes><Route path="/decks/:id" element={<DeckDetail />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Generate prompts' })).toBeInTheDocument());
};

const emit = async (source, frame) => act(async () => { source.emit(frame); });

beforeEach(() => {
  MockEventSource.reset();
  global.EventSource = MockEventSource;
  api.getDeck.mockReset().mockResolvedValue(deck);
  api.generateDeckPrompts.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  delete global.EventSource;
});

describe('DeckDetail prompt progress', () => {
  it('refreshes chunks on each later run', async () => {
    const firstRun = deferred();
    const secondRun = deferred();
    api.generateDeckPrompts.mockReturnValueOnce(firstRun.promise).mockReturnValueOnce(secondRun.promise);
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Generate prompts' }));
    expect(MockEventSource.instances).toHaveLength(1);
    expect(api.generateDeckPrompts).toHaveBeenCalledTimes(1);

    const firstSource = MockEventSource.instances[0];
    await act(async () => { firstSource.onopen?.(); });
    expect(api.generateDeckPrompts).toHaveBeenCalledTimes(1);
    await emit(firstSource, { type: 'start', requested: 24, chunks: 2 });
    await emit(firstSource, { type: 'batch-start', written: 0, requested: 24, chunk: 1, chunks: 2 });
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for the AI · 0 of 24 prompts saved · batch 1 of 2');
    await emit(firstSource, { type: 'activity', written: 0, requested: 24, chunk: 1, chunks: 2 });
    expect(screen.getByRole('status')).toHaveTextContent('AI is responding · 0 of 24 prompts saved · batch 1 of 2');
    await emit(firstSource, { type: 'chunk', written: 16, cardsWritten: 16, requested: 24, chunk: 1, chunks: 2 });
    expect(screen.getByRole('status')).toHaveTextContent('Saved 16 prompts · 16 of 24 · batch 1 of 2');
    await waitFor(() => expect(api.getDeck).toHaveBeenCalledTimes(2));
    await emit(firstSource, { type: 'batch-start', written: 16, requested: 24, chunk: 2, chunks: 2 });
    await emit(firstSource, { type: 'chunk', written: 24, cardsWritten: 8, requested: 24, chunk: 2, chunks: 2 });
    await waitFor(() => expect(api.getDeck).toHaveBeenCalledTimes(3));
    await emit(firstSource, { type: 'complete', written: 24, requested: 24 });
    await act(async () => { firstRun.resolve({ deck, written: 24, cast: 0 }); });

    fireEvent.click(screen.getByRole('button', { name: 'Generate prompts' }));
    expect(MockEventSource.instances).toHaveLength(2);
    const secondSource = MockEventSource.instances[1];
    await act(async () => { secondSource.onopen?.(); });
    expect(api.generateDeckPrompts).toHaveBeenCalledTimes(2);
    await emit(secondSource, { type: 'start', requested: 12, chunks: 1 });
    await emit(secondSource, { type: 'batch-start', written: 0, requested: 12, chunk: 1, chunks: 1 });
    await emit(secondSource, { type: 'chunk', written: 12, cardsWritten: 12, requested: 12, chunk: 1, chunks: 1 });
    await waitFor(() => expect(api.getDeck).toHaveBeenCalledTimes(4));
    await emit(secondSource, { type: 'complete', written: 12, requested: 12 });
    await act(async () => { secondRun.resolve({ deck, written: 12, cast: 0 }); });
  });

  it('continues generation when EventSource is unavailable', async () => {
    const run = deferred();
    api.generateDeckPrompts.mockReturnValue(run.promise);
    await renderPage();

    delete global.EventSource;
    fireEvent.click(screen.getByRole('button', { name: 'Generate prompts' }));
    expect(api.generateDeckPrompts).toHaveBeenCalledTimes(1);
    await act(async () => { run.resolve({ deck, written: 1, cast: 0 }); });
  });
});
