/**
 * Decks — the pure, dependency-free half of the card-deck designer.
 *
 * Owns the deck alphabet (`playing` | `tarot`), the card roster each kind
 * mints on creation, the layout clause each kind renders with, the render
 * prompt composition (deck style → layout → card subject), and the completion
 * math the index page and the detail header both show. Keeping this leaf
 * import-free lets `client/src/lib/decks.js` re-export it verbatim, so the
 * client never carries a second copy of the roster or the completion rule.
 *
 * Zod schemas for the routes live in `deckValidation.js`; DB access lives in
 * `services/decks.js`.
 */

import { composeStyledPrompt } from './composeStyledPrompt.js';
import { buildVisualStyleClause, universeVisualStyleTokens } from './universeVisualStyle.js';

export const DECK_KIND = Object.freeze({ PLAYING: 'playing', TAROT: 'tarot' });
export const DECK_KINDS = Object.freeze(Object.values(DECK_KIND));

export const DECK_KIND_LABELS = Object.freeze({
  [DECK_KIND.PLAYING]: 'Playing cards',
  [DECK_KIND.TAROT]: 'Tarot',
});

// Fallback portrait size for an unrecognized deck kind (2:3, matching the
// universe canon thumbnail convention `EntryThumbSlot` was built around).
// Real decks use `DECK_CARD_SIZE_BY_KIND` below instead.
export const DECK_CARD_SIZE = Object.freeze({ width: 1024, height: 1536 });

// Per-kind default card size, at each kind's true physical trim ratio rather
// than the generic 2:3 fallback above — poker cards are 2.5"×3.5" (5:7),
// tarot cards are 2.75"×4.75" (11:19). Both hold the same 1536 long edge as
// the generic default so render cost/detail stays comparable; `EntryThumbSlot`
// renders with `object-cover`, so the modest difference from 2:3 crops fine
// rather than distorting. A deck's own `cardSize` (persisted per-deck, see
// `services/decks.js`) always wins — this is only the value new decks mint.
export const DECK_CARD_SIZE_BY_KIND = Object.freeze({
  [DECK_KIND.PLAYING]: Object.freeze({ width: 1096, height: 1536 }),
  [DECK_KIND.TAROT]: Object.freeze({ width: 888, height: 1536 }),
});

// The one card every deck has that is not a face: the shared back design.
export const DECK_BACK_KEY = 'back';

// Card render states derived from the persisted render record + image refs.
export const CARD_STATUS = Object.freeze({
  EMPTY: 'empty', // no prompt yet
  PROMPTED: 'prompted', // prompt authored, nothing rendered
  QUEUED: 'queued',
  RUNNING: 'running',
  RENDERED: 'rendered',
  FAILED: 'failed',
});

// Per-kind layout clause. Every card of a deck shares it (editable on the deck)
// so the whole set reads as ONE physical object — same border, same index
// treatment — while the card prompt carries only the subject.
export const DEFAULT_LAYOUT_PROMPT = Object.freeze({
  [DECK_KIND.PLAYING]: 'Complete playing-card face, 2:3 portrait, ornate decorative border, the rank and suit index drawn in the top-left and bottom-right corners, symmetrical composition',
  [DECK_KIND.TAROT]: 'Complete tarot card, 2:3 portrait, decorative framed border, the card title lettered in a banner along the bottom edge, symbolic centered composition',
});

const PLAYING_SUITS = Object.freeze([
  { key: 'spades', name: 'Spades', symbol: '♠' },
  { key: 'hearts', name: 'Hearts', symbol: '♥' },
  { key: 'diamonds', name: 'Diamonds', symbol: '♦' },
  { key: 'clubs', name: 'Clubs', symbol: '♣' },
]);
const PLAYING_RANKS = Object.freeze([
  { key: 'A', name: 'Ace' }, { key: '2', name: 'Two' }, { key: '3', name: 'Three' },
  { key: '4', name: 'Four' }, { key: '5', name: 'Five' }, { key: '6', name: 'Six' },
  { key: '7', name: 'Seven' }, { key: '8', name: 'Eight' }, { key: '9', name: 'Nine' },
  { key: '10', name: 'Ten' }, { key: 'J', name: 'Jack' }, { key: 'Q', name: 'Queen' },
  { key: 'K', name: 'King' },
]);

// Major arcana with the traditional motif each card carries — the prompt
// generator gets these as grounding so a deck stays recognizable as tarot even
// when a universe's cast is placed on the cards.
const MAJOR_ARCANA = Object.freeze([
  ['The Fool', 'a carefree traveler stepping toward a cliff edge, a small dog at their heels, a white rose in hand'],
  ['The Magician', 'a figure at a table bearing a cup, a sword, a wand and a coin, one hand raised to the sky, one pointing to the earth'],
  ['The High Priestess', 'a seated veiled figure between two pillars, a crescent moon at their feet, a scroll in their lap'],
  ['The Empress', 'a crowned figure enthroned in a lush field of grain and flowing water, a shield bearing a symbol of love'],
  ['The Emperor', 'a stern crowned ruler on a stone throne carved with rams, a scepter in hand, mountains behind'],
  ['The Hierophant', 'a robed teacher between two pillars, hand raised in blessing, two acolytes kneeling, crossed keys below'],
  ['The Lovers', 'two figures beneath a radiant winged presence, a tree of flame and a tree of fruit, a mountain between'],
  ['The Chariot', 'an armored figure standing in a chariot drawn by two sphinxes, one black and one white, a starry canopy above'],
  ['Strength', 'a calm figure gently closing the jaws of a lion, an infinity sign above their head, a garland of flowers'],
  ['The Hermit', 'a cloaked elder on a mountain peak holding a lantern with a six-pointed star, leaning on a staff'],
  ['Wheel of Fortune', 'a great wheel inscribed with symbols, a sphinx atop it, creatures reading books in the four corners'],
  ['Justice', 'a crowned figure enthroned holding an upright sword and a set of balanced scales, between two pillars'],
  ['The Hanged Man', 'a serene figure suspended upside down by one foot from a living tree, a halo of light around the head'],
  ['Death', 'an armored skeletal rider on a pale horse carrying a black banner with a white rose, a sunrise between two towers'],
  ['Temperance', 'a winged figure with one foot in water and one on land, pouring water between two cups, a path to a distant crown of light'],
  ['The Devil', 'a horned figure on a black pedestal, two chained figures below, an inverted five-pointed star, a raised torch'],
  ['The Tower', 'a tower on a crag struck by lightning, its crown toppling, two figures falling, flames from the windows'],
  ['The Star', 'a kneeling figure pouring water from two vessels onto land and pool beneath one great star and seven smaller stars'],
  ['The Moon', 'a full moon over a path between two towers, a dog and a wolf howling, a crayfish emerging from a pool'],
  ['The Sun', 'a radiant sun above a joyful child on a white horse, sunflowers over a garden wall, a red banner'],
  ['Judgement', 'a winged herald sounding a trumpet from the clouds while figures rise from open graves below, mountains behind'],
  ['The World', 'a dancing figure wreathed in a laurel oval holding two wands, the four living creatures in the corners'],
]);

const TAROT_SUITS = Object.freeze([
  { key: 'wands', name: 'Wands' },
  { key: 'cups', name: 'Cups' },
  { key: 'swords', name: 'Swords' },
  { key: 'pentacles', name: 'Pentacles' },
]);
const TAROT_RANKS = Object.freeze([
  { key: 'ace', name: 'Ace' }, { key: '2', name: 'Two' }, { key: '3', name: 'Three' },
  { key: '4', name: 'Four' }, { key: '5', name: 'Five' }, { key: '6', name: 'Six' },
  { key: '7', name: 'Seven' }, { key: '8', name: 'Eight' }, { key: '9', name: 'Nine' },
  { key: '10', name: 'Ten' }, { key: 'page', name: 'Page' }, { key: 'knight', name: 'Knight' },
  { key: 'queen', name: 'Queen' }, { key: 'king', name: 'King' },
]);

const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI'];

const backCard = () => ({
  key: DECK_BACK_KEY,
  name: 'Card back',
  group: 'back',
  groupLabel: 'Back',
  rank: null,
  motif: 'the shared reverse-side pattern every card in the deck carries — a repeating symmetrical emblem, no figures, no text',
});

function playingRoster() {
  const cards = [];
  for (const suit of PLAYING_SUITS) {
    for (const rank of PLAYING_RANKS) {
      cards.push({
        key: `${suit.key}-${rank.key}`,
        name: `${rank.name} of ${suit.name}`,
        group: suit.key,
        groupLabel: suit.name,
        rank: rank.key,
        motif: null,
      });
    }
  }
  cards.push({ key: 'joker-1', name: 'Joker (red)', group: 'jokers', groupLabel: 'Jokers', rank: 'joker', motif: 'a jester figure in the deck\'s world' });
  cards.push({ key: 'joker-2', name: 'Joker (black)', group: 'jokers', groupLabel: 'Jokers', rank: 'joker', motif: 'a second, contrasting jester figure' });
  cards.push(backCard());
  return cards;
}

function tarotRoster() {
  const cards = MAJOR_ARCANA.map(([name, motif], i) => ({
    key: `major-${i}`,
    name: `${ROMAN[i]} · ${name}`,
    group: 'major',
    groupLabel: 'Major Arcana',
    rank: ROMAN[i],
    motif,
  }));
  for (const suit of TAROT_SUITS) {
    for (const rank of TAROT_RANKS) {
      cards.push({
        key: `${suit.key}-${rank.key}`,
        name: `${rank.name} of ${suit.name}`,
        group: suit.key,
        groupLabel: suit.name,
        rank: rank.key,
        motif: null,
      });
    }
  }
  cards.push(backCard());
  return cards;
}

/**
 * The card roster a deck of `kind` mints on creation, in display order. Each
 * entry is `{ key, name, group, groupLabel, rank, motif }` — `key` is the
 * stable per-deck slot identity (`hearts-Q`, `major-17`, `back`).
 */
export function deckCardRoster(kind) {
  if (kind === DECK_KIND.PLAYING) return playingRoster();
  if (kind === DECK_KIND.TAROT) return tarotRoster();
  throw new Error(`Unknown deck kind: ${kind}`);
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Compose the prompt one card renders with. Order is deliberate: the deck's
 * embrace influences lead (diffusion models weight early tokens heaviest),
 * then the shared layout clause, then the card's own subject. The avoid list
 * becomes the negative prompt, after any per-card negative.
 */
export function composeCardRenderPrompt(deck, card) {
  // A deck carries the same `influences` shape a universe does, so the
  // universe's visual-style projection is the one definition of "what the
  // embrace/avoid lists contribute to an image prompt".
  const embrace = buildVisualStyleClause(deck);
  const avoid = universeVisualStyleTokens(deck).avoid.join(', ');
  const layout = trimmed(deck?.layoutPrompt);
  const subject = [trimmed(card?.name), trimmed(card?.prompt)].filter(Boolean).join(': ');
  const body = [layout, subject].filter(Boolean).join('. ');
  return composeStyledPrompt(body, trimmed(card?.negativePrompt), { prompt: embrace, negativePrompt: avoid });
}

const IN_FLIGHT_RENDER = new Set(['queued', 'running']);

/** The media-job id a card is currently waiting on, or null. */
export const cardInFlightJobId = (card) => (
  IN_FLIGHT_RENDER.has(card?.render?.status) && card.render.jobId ? card.render.jobId : null
);

/** Derived render state for one card row. */
export function cardStatus(card) {
  const render = card?.render || null;
  if (render?.status === 'queued') return CARD_STATUS.QUEUED;
  if (render?.status === 'running') return CARD_STATUS.RUNNING;
  if (Array.isArray(card?.imageRefs) && card.imageRefs.length) return CARD_STATUS.RENDERED;
  if (render?.status === 'failed' || render?.status === 'canceled') return CARD_STATUS.FAILED;
  return trimmed(card?.prompt) ? CARD_STATUS.PROMPTED : CARD_STATUS.EMPTY;
}

/** Completion counters for a deck's card list. */
export function deckCompletion(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const counts = { total: list.length, prompted: 0, rendered: 0, inFlight: 0, failed: 0 };
  for (const card of list) {
    if (trimmed(card?.prompt)) counts.prompted += 1;
    const status = cardStatus(card);
    if (status === CARD_STATUS.RENDERED) counts.rendered += 1;
    else if (status === CARD_STATUS.QUEUED || status === CARD_STATUS.RUNNING) counts.inFlight += 1;
    else if (status === CARD_STATUS.FAILED) counts.failed += 1;
  }
  counts.percent = counts.total ? Math.round((counts.rendered / counts.total) * 100) : 0;
  return counts;
}
