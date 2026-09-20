import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import DeckDetail from './DeckDetail';

// The deck page shows each card's SUBJECT prompt in its editor, but a render
// was sent the composed prompt (deck style clause + layout + subject). The
// lightbox must show what was actually sent, which only the image sidecar
// records — hydrated lazily for the OPEN card, so a 78-card deck costs no
// lookup at all until the user opens one.
const getDeck = vi.fn();
const getGalleryImages = vi.fn();
const getVideoHistoryItem = vi.fn();
let previewProps = null;

vi.mock('../services/api', () => ({
  deleteDeck: vi.fn(),
  generateDeckPrompts: vi.fn(),
  getDeck: (...a) => getDeck(...a),
  listUniverseSummaries: vi.fn(async () => []),
  removeDeckSample: vi.fn(),
  renderDeckCard: vi.fn(),
  renderDeckCards: vi.fn(),
  updateDeck: vi.fn(),
  updateDeckCard: vi.fn(),
}));
vi.mock('../services/apiImageVideo', () => ({
  getGalleryImages: (...a) => getGalleryImages(...a),
  getVideoHistoryItem: (...a) => getVideoHistoryItem(...a),
}));
vi.mock('../components/media/MediaPreview', () => ({
  default: (props) => { previewProps = props; return null; },
}));
// The render bar and the card grid each own their own suite; both pull live
// settings/socket state that says nothing about which prompt the lightbox gets.
vi.mock('../components/decks/DeckRenderControls', () => ({ default: () => null }));
vi.mock('../components/decks/DeckCardGrid', () => ({ default: () => null }));
vi.mock('../hooks/useDeckRenderTarget', () => ({
  default: () => ({ summary: 'Local · flux2 · 1096×1536', blocked: false, mode: 'local', options: [] }),
}));

const COMPOSED = 'copperplate engraving. Full tarot card, framed border. One-way card face: all rank, suit and title markings share one upright reading direction; the top-left and bottom-right indices face the same way, with no 180-degree rotation or inverted duplicate. The Fool: a youth at a cliff edge';

const deck = {
  id: 'd1',
  name: 'Test Deck',
  kind: 'tarot',
  universeId: null,
  layoutPrompt: 'Full tarot card, framed border',
  influences: { embrace: ['copperplate engraving'], avoid: ['blurry'] },
  cardSize: { width: 1096, height: 1536 },
  samples: [],
  cards: [{
    id: 'c1', key: 'major-0', name: 'The Fool', group: 'major', groupLabel: 'Major Arcana',
    prompt: 'a youth at a cliff edge', negativePrompt: '', imageRefs: ['fool.png'],
    primaryImageRef: 'fool.png', render: null, canonRef: null,
  }],
};

const renderPage = (search = '') => render(
  <MemoryRouter initialEntries={[`/decks/d1${search}`]}>
    <Routes><Route path="/decks/:id" element={<DeckDetail />} /></Routes>
  </MemoryRouter>,
);

describe('DeckDetail preview items', () => {
  beforeEach(() => {
    previewProps = null;
    getDeck.mockReset().mockResolvedValue(deck);
    getGalleryImages.mockReset();
    getVideoHistoryItem.mockReset();
  });

  it('reads no sidecars until a card is actually opened', async () => {
    getGalleryImages.mockResolvedValue([]);
    renderPage();
    // The list itself is enough to render the grid — hydration is the
    // lightbox's concern, so loading the deck must cost zero lookups.
    await waitFor(() => expect(previewProps?.items?.length).toBe(1));
    expect(getGalleryImages).not.toHaveBeenCalled();
  });

  it('shows the prompt the renderer was actually sent, not the card subject alone', async () => {
    getGalleryImages.mockResolvedValue([{
      filename: 'fool.png',
      prompt: `${COMPOSED}, hand-inked`,
      negativePrompt: 'blurry, extra fingers',
      modelId: 'flux2-klein-9b',
      seed: 42,
    }]);
    renderPage('?preview=fool.png');
    await waitFor(() => expect(getGalleryImages).toHaveBeenCalledWith(['fool.png'], { silent: true }));
    await waitFor(() => {
      expect(previewProps?.preview?.prompt).toBe(`${COMPOSED}, hand-inked`);
      expect(previewProps?.preview?.negativePrompt).toBe('blurry, extra fingers');
      expect(previewProps?.preview?.seed).toBe(42);
    });
  });

  it('keeps the open card addressable by its list key so prev/next still match', async () => {
    getGalleryImages.mockResolvedValue([{ filename: 'fool.png', prompt: 'whatever was sent' }]);
    renderPage('?preview=fool.png');
    await waitFor(() => expect(previewProps?.preview?.prompt).toBe('whatever was sent'));
    expect(previewProps.preview.key).toBe(previewProps.items[0].key);
  });

  it('composes the prompt locally when the render has no sidecar', async () => {
    // A legacy or peer-synced render has no sidecar, and nothing does before
    // the lookup lands. The composed prompt is derivable right here — falling
    // back to the card's subject line would re-show the wording that was
    // never sent.
    getGalleryImages.mockResolvedValue([]);
    renderPage('?preview=fool.png');
    await waitFor(() => expect(getGalleryImages).toHaveBeenCalled());
    await waitFor(() => {
      expect(previewProps?.preview?.prompt).toBe(COMPOSED);
      expect(previewProps?.preview?.negativePrompt).toBe('upside-down index, rotated bottom-right rank, inverted duplicate, mirrored lettering, blurry');
    });
  });
});
