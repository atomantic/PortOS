// Decks — the deck alphabet, card status/completion rules and render-prompt
// composition, re-exported from the server's pure leaf so the client never
// carries a second copy of the roster or the completion math.
export {
  CARD_STATUS,
  DECK_BACK_KEY,
  DECK_CARD_SIZE,
  DECK_KIND,
  DECK_KINDS,
  DECK_KIND_LABELS,
  DEFAULT_LAYOUT_PROMPT,
  cardInFlightJobId,
  cardStatus,
  composeCardRenderPrompt,
  deckCompletion,
} from '../../../server/lib/deckTemplates.js';
