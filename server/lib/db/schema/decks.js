// Decks (#decks): playing-card / tarot deck design projects. A deck row carries
// the style guide + sample references + render pins in `definition`; each card
// is its own row so a completed render attaches to ONE card without a
// read-modify-write of the whole deck. Rendered bytes live in the shared
// gallery (`data/images/`) and are referenced by filename from the card row.
// Machine-local: decks never federate.
export const decksDdl = [
  `CREATE TABLE IF NOT EXISTS decks (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('playing', 'tarot')),
    universe_id TEXT,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS deck_cards (
    id UUID PRIMARY KEY,
    deck_id UUID NOT NULL REFERENCES decks (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    key TEXT NOT NULL,
    definition JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (deck_id, key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deck_cards_deck ON deck_cards (deck_id, position)`,
];
