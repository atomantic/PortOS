/**
 * Decks — the pure, dependency-free half of the card-deck designer.
 *
 * Owns the deck alphabet (`playing` | `tarot`), the card roster each kind
 * mints on creation, the layout clause and face-orientation prompt each kind
 * renders with, the render prompt composition (deck style → layout → face
 * orientation → card subject), and the completion math the index page and the
 * detail header both show. Keeping this leaf
 * import-free lets `client/src/lib/decks.js` re-export it verbatim, so the
 * client never carries a second copy of the roster or the completion rule.
 *
 * Zod schemas for the routes live in `deckValidation.js`; DB access lives in
 * `services/decks.js`.
 */

import { aspectRatioPhrase } from './aspectRatio.js';
import { composeStyledPrompt } from './composeStyledPrompt.js';
import { buildVisualStyleClause, universeVisualStyleTokens } from './universeVisualStyle.js';

export const DECK_KIND = Object.freeze({ PLAYING: 'playing', TAROT: 'tarot' });
export const DECK_KINDS = Object.freeze(Object.values(DECK_KIND));

export const DECK_KIND_LABELS = Object.freeze({
  [DECK_KIND.PLAYING]: 'Playing cards',
  [DECK_KIND.TAROT]: 'Tarot',
});

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// Face orientation is a deck-wide property because every card in a physical
// deck must agree on how its indices read. Playing cards default to the
// conventional two-way face; tarot defaults to one-way because its title and
// illustration are normally read from one direction.
export const DECK_CARD_ORIENTATION = Object.freeze({
  STANDARD: 'standard',
  ONE_WAY: 'one-way',
});
export const DECK_CARD_ORIENTATIONS = Object.freeze(Object.values(DECK_CARD_ORIENTATION));
export const DECK_CARD_ORIENTATION_LABELS = Object.freeze({
  [DECK_CARD_ORIENTATION.STANDARD]: 'Standard two-way (mirrored indices)',
  [DECK_CARD_ORIENTATION.ONE_WAY]: 'One-way (upright indices)',
});
export const DEFAULT_DECK_CARD_ORIENTATION = Object.freeze({
  [DECK_KIND.PLAYING]: DECK_CARD_ORIENTATION.STANDARD,
  [DECK_KIND.TAROT]: DECK_CARD_ORIENTATION.ONE_WAY,
});

// These are intentionally explicit rather than relying on a model to infer
// what "symmetrical" means. In particular, a bottom-right upright 6 is easily
// read as a 9 after the physical card is turned around.
const BUILT_IN_CARD_ORIENTATION_PROMPTS = Object.freeze({
  [DECK_CARD_ORIENTATION.STANDARD]: 'Standard two-way playing-card face, vertically mirrored: the top-left rank and suit index is upright, while the matching bottom-right index is an exact 180-degree rotation and reads upside down from the top edge; the two indices must be the same glyph and rank, so a six remains a six and never becomes a nine',
  [DECK_CARD_ORIENTATION.ONE_WAY]: 'One-way card face: all rank, suit and title markings share one upright reading direction; the top-left and bottom-right indices face the same way, with no 180-degree rotation or inverted duplicate',
});
const BUILT_IN_CARD_ORIENTATION_NEGATIVES = Object.freeze({
  [DECK_CARD_ORIENTATION.STANDARD]: 'upright duplicate bottom-right index, mismatched rank indices, six rendered as nine, incorrect glyph rotation',
  [DECK_CARD_ORIENTATION.ONE_WAY]: 'upside-down index, rotated bottom-right rank, inverted duplicate, mirrored lettering',
});

/** The effective face orientation, or null for a non-deck-shaped prompt input. */
export function deckCardOrientation(deck) {
  if (DECK_CARD_ORIENTATIONS.includes(deck?.cardOrientation)) return deck.cardOrientation;
  return DEFAULT_DECK_CARD_ORIENTATION[deck?.kind] || null;
}

/** The built-in orientation prompt, ignoring a deck's authored override. */
export function defaultDeckCardOrientationPrompt(deck) {
  const orientation = deckCardOrientation(deck);
  return orientation ? BUILT_IN_CARD_ORIENTATION_PROMPTS[orientation] : '';
}

/** The effective orientation prompt: an authored override or the safe default. */
export function deckCardOrientationPrompt(deck) {
  const override = trimmed(deck?.cardOrientationPrompt);
  return override || defaultDeckCardOrientationPrompt(deck);
}

/** The matching built-in negative guard; custom positive prompts own their negatives. */
export function deckCardOrientationNegativePrompt(deck) {
  if (trimmed(deck?.cardOrientationPrompt)) return '';
  const orientation = deckCardOrientation(deck);
  return orientation ? BUILT_IN_CARD_ORIENTATION_NEGATIVES[orientation] : '';
}

// Fallback portrait size for an unrecognized deck kind (2:3, matching the
// universe canon thumbnail convention `EntryThumbSlot` was built around).
// Real decks use `DECK_CARD_SIZE_BY_KIND` below instead.
export const DECK_CARD_SIZE = Object.freeze({ width: 1024, height: 1536 });

// Per-edge bounds for a deck's card size. `deckValidation.js` builds its zod
// `cardSizeSchema` from these and the client's size inputs clamp to them, so
// the form can't submit a value the PATCH would 400 on and neither side holds
// its own copy of the numbers.
export const DECK_CARD_SIZE_MIN = 256;
export const DECK_CARD_SIZE_MAX = 4096;

// Per-kind default card size, at each kind's true physical trim ratio rather
// than the generic 2:3 fallback above — poker cards are 2.5"×3.5" (5:7),
// tarot cards are 2.75"×4.75" (11:19). Both hold the same 1536 long edge as
// the generic default so render cost/detail stays comparable. Thumbnails size
// their slot to this ratio and contain the image (`deckCardSize` /
// `deckCardAspectStyle`) so the rank, index, title banner and decorative
// border stay in frame — a 2:3 `object-cover` box crops playing cards on the
// sides and tarot cards top/bottom. A deck's own `cardSize` (persisted
// per-deck, see `services/decks.js`) always wins — this is only the value
// new decks mint.
export const DECK_CARD_SIZE_BY_KIND = Object.freeze({
  [DECK_KIND.PLAYING]: Object.freeze({ width: 1096, height: 1536 }),
  [DECK_KIND.TAROT]: Object.freeze({ width: 888, height: 1536 }),
});

const isPositiveEdge = (value) => Number.isFinite(value) && value > 0;

/**
 * The canvas a deck's cards actually render at: the persisted `cardSize` when
 * both edges are positive, otherwise that kind's trim, otherwise the 2:3
 * fallback. One read so the grid, drawer, sample thumbs and render-target
 * summary cannot disagree about the box.
 */
export function deckCardSize(deck) {
  const width = Number(deck?.cardSize?.width);
  const height = Number(deck?.cardSize?.height);
  if (isPositiveEdge(width) && isPositiveEdge(height)) return { width, height };
  return { ...(DECK_CARD_SIZE_BY_KIND[deck?.kind] || DECK_CARD_SIZE) };
}

/** Inline `style.aspectRatio` for a card thumbnail, derived from `deckCardSize`. */
export function deckCardAspectStyle(deck) {
  const { width, height } = deckCardSize(deck);
  return { aspectRatio: `${width} / ${height}` };
}

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
//
// The framing phrase is DERIVED from the kind's canvas, never written beside
// it: these clauses kept telling the model "2:3 portrait" after the per-kind
// sizes moved to each card's true trim (5:7 and 11:19), so the prompt and the
// canvas disagreed about the shape being drawn. Deriving means changing a
// canvas changes the sentence, and the two cannot drift apart again.
const layoutClauseFor = {
  [DECK_KIND.PLAYING]: (framing) => `Complete playing-card face, ${framing}, ornate decorative border, the rank and suit index placed in the top-left and bottom-right corners, symmetrical composition`,
  [DECK_KIND.TAROT]: (framing) => `Complete tarot card, ${framing}, decorative framed border, the card title lettered in a banner along the bottom edge, symbolic centered composition`,
};

export const DEFAULT_LAYOUT_PROMPT = Object.freeze(Object.fromEntries(
  DECK_KINDS.map((kind) => {
    // Loud at import rather than silent at render: a kind with no clause used to
    // resolve to `undefined` here and reach `services/decks.js`, whose
    // `|| ''` fallback would mint every card of that deck with NO shared layout
    // at all — a whole deck rendered wrong before anyone noticed the gap.
    const clause = layoutClauseFor[kind];
    if (!clause) throw new Error(`Deck kind ${kind} has no DEFAULT_LAYOUT_PROMPT clause`);
    const size = DECK_CARD_SIZE_BY_KIND[kind] || DECK_CARD_SIZE;
    return [kind, clause(aspectRatioPhrase(size.width, size.height))];
  }),
));

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

const PLAYING_SUIT_SHAPES = Object.freeze({
  spades: Object.freeze({ color: 'black', noun: 'spade', shape: 'pointed leaf with a narrow stem' }),
  hearts: Object.freeze({ color: 'red', noun: 'heart', shape: 'two rounded lobes and a pointed bottom' }),
  diamonds: Object.freeze({ color: 'red', noun: 'diamond', shape: 'pointed lozenge' }),
  clubs: Object.freeze({ color: 'black', noun: 'club', shape: 'three rounded lobes and a short stem' }),
});

/**
 * The fixed visual identity a playing-card render must preserve. The stable
 * roster key is authoritative, so this also repairs renders from older saved
 * subject prompts that named the card without spelling out its suit or count.
 */
export function deckCardIdentityPrompt(deck, card) {
  if (deck?.kind !== DECK_KIND.PLAYING) return '';
  const match = /^(spades|hearts|diamonds|clubs)-(A|[2-9]|10|J|Q|K)$/.exec(String(card?.key || ''));
  if (!match) return '';

  const [, suitKey, rankKey] = match;
  const suit = PLAYING_SUITS.find((entry) => entry.key === suitKey);
  const rank = PLAYING_RANKS.find((entry) => entry.key === rankKey);
  if (!suit || !rank) return '';

  const pip = PLAYING_SUIT_SHAPES[suitKey];
  const cardName = `${rank.name} of ${suit.name}`;
  const cornerIndex = `Both corner indices show the exact rank ${rankKey} beside one matching ${suit.symbol} suit mark.`;
  if (rankKey === 'A') {
    return `Fixed identity: ${cardName}. Show one large ornate ${pip.color} ${pip.noun} emblem (${suit.symbol}), shaped as a ${pip.shape}, in the center; do not repeat it as a pip field. ${cornerIndex} Show no other suit.`;
  }
  if (/^\d+$/.test(rankKey)) {
    return `Fixed identity: ${cardName}. Show exactly ${rankKey} separate ${pip.color} ${pip.noun}-shaped pips in the central field, each a ${pip.shape}; count them literally, with none missing or added. ${cornerIndex} Show no other suit or pip count.`;
  }
  return `Fixed identity: ${cardName}. Show one full ${rank.name.toLowerCase()} figure as the central subject, with ${pip.color} ${pip.noun} emblems shaped as a ${pip.shape}. ${cornerIndex} Do not replace the face rank with a numbered pip field or show another suit.`;
}

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

/**
 * Compose the prompt one card renders with. Order is deliberate: the deck's
 * embrace influences lead (diffusion models weight early tokens heaviest),
 * then the shared layout clause, then the card's own subject. The avoid list
 * becomes the negative prompt, after any per-card negative.
 *
 * `parts` carries the same clauses unjoined, so the card editor can show
 * which contribution came from the deck (style, layout, avoid list) and which
 * from the card itself — a composed blob alone leaves the user unable to tell
 * why a render picked up wording they never typed.
 */
export function composeCardRenderPrompt(deck, card) {
  // A deck carries the same `influences` shape a universe does, so the
  // universe's visual-style projection is the one definition of "what the
  // embrace/avoid lists contribute to an image prompt".
  const style = buildVisualStyleClause(deck);
  const avoid = universeVisualStyleTokens(deck).avoid.join(', ');
  const layout = trimmed(deck?.layoutPrompt);
  const orientation = deckCardOrientationPrompt(deck);
  const orientationNegative = deckCardOrientationNegativePrompt(deck);
  const identity = deckCardIdentityPrompt(deck, card);
  const subject = identity
    ? [identity, trimmed(card?.prompt)].filter(Boolean).join(' ')
    : [trimmed(card?.name), trimmed(card?.prompt)].filter(Boolean).join(': ');
  const body = [layout, orientation, subject].filter(Boolean).join('. ');
  const identityNegative = identity ? 'wrong card rank, wrong card suit, incorrect pip count, missing pips, extra pips' : '';
  const cardNegative = [trimmed(card?.negativePrompt), orientationNegative, identityNegative].filter(Boolean).join(', ');
  const composed = composeStyledPrompt(body, cardNegative, { prompt: style, negativePrompt: avoid });
  return { ...composed, parts: { style, layout, orientation, subject } };
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
