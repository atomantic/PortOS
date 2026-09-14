import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import DeckDetail from './DeckDetail';

// The deck page shows each card's SUBJECT prompt in its editor, but a render
// was sent the composed prompt (deck style clause + layout + subject). The
// lightbox must show what was actually sent, which only the image sidecar
// records — hence the gallery hydration this suite pins.
const getDeck = vi.fn();
const getGalleryImages = vi.fn();
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
vi.mock('../services/apiImageVideo', () => ({ getGalleryImages: (...a) => getGalleryImages(...a) }));
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

const renderPage = () => render(
  <MemoryRouter initialEntries={['/decks/d1']}>
    <Routes><Route path="/decks/:id" element={<DeckDetail />} /></Routes>
  </MemoryRouter>,
);

describe('DeckDetail preview items', () => {
  beforeEach(() => {
    previewProps = null;
    getDeck.mockReset().mockResolvedValue(deck);
    getGalleryImages.mockReset();
  });

  it('shows the prompt the renderer was actually sent, not the card subject alone', async () => {
    getGalleryImages.mockResolvedValue([{
      filename: 'fool.png',
      prompt: 'copperplate engraving. Full tarot card, framed border. The Fool: a youth at a cliff edge',
      negativePrompt: 'blurry',
      modelId: 'flux2-klein-9b',
      seed: 42,
    }]);
    renderPage();
    await waitFor(() => expect(getGalleryImages).toHaveBeenCalledWith(['fool.png'], { silent: true }));
    await waitFor(() => {
      const item = previewProps?.items?.find((i) => i.filename === 'fool.png');
      expect(item?.prompt).toBe('copperplate engraving. Full tarot card, framed border. The Fool: a youth at a cliff edge');
      expect(item?.negativePrompt).toBe('blurry');
      expect(item?.seed).toBe(42);
    });
  });

  it('composes the prompt locally when the render has no sidecar', async () => {
    // A legacy or peer-synced render has no sidecar, and nothing does before
    // the lookup lands. The composed prompt is derivable right here — falling
    // back to the card's subject line would re-show the wording that was
    // never sent.
    getGalleryImages.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      const item = previewProps?.items?.find((i) => i.filename === 'fool.png');
      expect(item?.prompt).toBe('copperplate engraving. Full tarot card, framed border. The Fool: a youth at a cliff edge');
      expect(item?.negativePrompt).toBe('blurry');
    });
  });
});
