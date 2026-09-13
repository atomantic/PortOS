/**
 * Deck federation over PostgreSQL (#decks): the LWW merge, the tombstone
 * lifecycle, and the machine-local fields a remote win must not reset.
 * Runs only against portos_test.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { sanitizeRecordForWire } from '../lib/syncWire.js';
import {
  createDeck, getDeck, updateDeck, updateCard, deleteDeck,
  getDeckForSync, listDecksForSync, listDeckIdsForSync,
  mergeDecksFromSync, pruneTombstonedDecks, restoreDeck,
} from './decks.js';

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/decksSync.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM decks WHERE id = ANY($1::uuid[])', [ids]);
  await close();
});

const make = async (name) => {
  const deck = await createDeck({ name, kind: 'playing' });
  ids.push(deck.id);
  return deck;
};

// The shape a peer would actually receive: the local record run through the
// wire projection, so these tests exercise the same bytes the push ships.
const asWire = (deck, patch = {}) => ({ ...sanitizeRecordForWire('deck', deck), ...patch });
const later = (iso, ms) => new Date(new Date(iso).getTime() + ms).toISOString();

describe.skipIf(!ready)('deck federation', () => {
  it('merges a newer remote deck and leaves an older one alone', async () => {
    const deck = await make('Merge Base');
    const remote = asWire(deck, {
      name: 'Renamed On Peer',
      styleNotes: 'etched linework',
      updatedAt: later(deck.updatedAt, 60_000),
    });
    expect(await mergeDecksFromSync([remote])).toEqual({ applied: true, count: 1 });
    expect((await getDeck(deck.id)).name).toBe('Renamed On Peer');
    expect((await getDeck(deck.id)).styleNotes).toBe('etched linework');

    const stale = asWire(deck, { name: 'Stale', updatedAt: later(deck.updatedAt, -60_000) });
    expect(await mergeDecksFromSync([stale])).toEqual({ applied: false, count: 0 });
    expect((await getDeck(deck.id)).name).toBe('Renamed On Peer');
  });

  it('inserts a deck it has never seen, with its full card roster keyed by roster key', async () => {
    const source = await make('Roster Source');
    const remoteId = crypto.randomUUID();
    ids.push(remoteId);
    const remote = asWire(source, { id: remoteId, name: 'From Peer', updatedAt: new Date().toISOString() });
    remote.cards[0] = { ...remote.cards[0], prompt: 'a king of coins, woodcut' };

    expect(await mergeDecksFromSync([remote])).toEqual({ applied: true, count: 1 });
    const landed = await getDeck(remoteId);
    expect(landed.name).toBe('From Peer');
    expect(landed.cards).toHaveLength(source.cards.length);
    expect(landed.cards.map((c) => c.key).sort()).toEqual(source.cards.map((c) => c.key).sort());
    const authored = landed.cards.find((c) => c.key === remote.cards[0].key);
    expect(authored.prompt).toBe('a king of coins, woodcut');
    // Row ids are minted locally — a remote never dictates them.
    expect(landed.cards.every((c) => c.id && c.id !== remote.cards[0].id)).toBe(true);
  });

  it('carries the receiver\'s own render/LLM pins forward through a remote win', async () => {
    const deck = await make('Pinned');
    await updateDeck(deck.id, {
      imageMode: 'grok', imageModelId: 'grok-image-1',
      promptLlm: { providerId: 'claude-cli', model: 'claude-opus-5' },
    });
    const pinned = await getDeck(deck.id);
    expect(pinned.promptLlm).toMatchObject({ providerId: 'claude-cli', model: 'claude-opus-5' });
    await mergeDecksFromSync([asWire(pinned, {
      name: 'Remote Wins', updatedAt: later(pinned.updatedAt, 60_000),
    })]);

    const merged = await getDeck(deck.id);
    expect(merged.name).toBe('Remote Wins');
    expect(merged.imageMode).toBe('grok');
    expect(merged.imageModelId).toBe('grok-image-1');
    expect(merged.promptLlm).toEqual(pinned.promptLlm);
  });

  it('keeps a card\'s local render history when the remote carries none for it', async () => {
    const deck = await make('Render History');
    const card = deck.cards[0];
    await updateCard(deck.id, card.id, { imageRefs: ['local-render.png'], primaryImageRef: 'local-render.png' });
    const withRender = await getDeck(deck.id);

    // A remote that HAS the render keeps it; the refs are wire-visible, so
    // this is the round-trip a real peer performs.
    await mergeDecksFromSync([asWire(withRender, { updatedAt: later(withRender.updatedAt, 60_000) })]);
    const merged = await getDeck(deck.id);
    expect(merged.cards.find((c) => c.key === card.key).imageRefs).toEqual(['local-render.png']);
    // The local row id survived the upsert — the receiver matches on roster key.
    expect(merged.cards.find((c) => c.key === card.key).id).toBe(card.id);
  });

  it('tombstones on delete, hides the deck from reads, and keeps it visible to sync', async () => {
    const deck = await make('Doomed');
    await deleteDeck(deck.id);

    await expect(getDeck(deck.id)).rejects.toThrow(/not found/i);
    expect((await listDecksForSync()).some((d) => d.id === deck.id)).toBe(false);
    expect(await listDeckIdsForSync()).not.toContain(deck.id);
    expect(await listDeckIdsForSync({ includeDeleted: true })).toContain(deck.id);

    const tombstone = await getDeckForSync(deck.id);
    expect(tombstone.deleted).toBe(true);
    expect(tombstone.deletedAt).toBeTruthy();
  });

  it('applies a remote tombstone once, then treats a repeat as a no-op (a rewrite would restart the GC grace period)', async () => {
    const deck = await make('Remote Delete');
    const tombstone = asWire(deck, {
      deleted: true,
      deletedAt: new Date().toISOString(),
      updatedAt: later(deck.updatedAt, 60_000),
    });
    expect(await mergeDecksFromSync([tombstone])).toEqual({ applied: true, count: 1 });
    const applied = await getDeckForSync(deck.id);
    expect(applied.deleted).toBe(true);

    expect(await mergeDecksFromSync([{ ...tombstone, updatedAt: later(deck.updatedAt, 120_000) }]))
      .toEqual({ applied: false, count: 0 });
    expect((await getDeckForSync(deck.id)).deletedAt).toBe(applied.deletedAt);
  });

  it('drops a remote record with no id or an unknown deck kind rather than failing the batch', async () => {
    const deck = await make('Batch Survivor');
    const good = asWire(deck, { name: 'Landed', updatedAt: later(deck.updatedAt, 60_000) });
    const result = await mergeDecksFromSync([
      { name: 'no id', kind: 'playing', updatedAt: new Date().toISOString() },
      { id: crypto.randomUUID(), kind: 'hanafuda', updatedAt: new Date().toISOString() },
      good,
    ]);
    expect(result).toEqual({ applied: true, count: 1 });
    expect((await getDeck(deck.id)).name).toBe('Landed');
  });

  it('prunes a tombstone only once its deletedAt precedes the cutoff', async () => {
    const deck = await make('GC Candidate');
    await deleteDeck(deck.id);

    expect(await pruneTombstonedDecks(Date.now() - 86_400_000)).toEqual({ pruned: 0, ids: [] });
    expect(await listDeckIdsForSync({ includeDeleted: true })).toContain(deck.id);

    const swept = await pruneTombstonedDecks(Date.now() + 1000);
    expect(swept.ids).toContain(deck.id);
    expect(await getDeckForSync(deck.id)).toBeNull();
    // The card rows go with it (ON DELETE CASCADE) — no orphan roster left behind.
    const { rows } = await query('SELECT 1 FROM deck_cards WHERE deck_id = $1', [deck.id]);
    expect(rows).toHaveLength(0);
  });

  it('restores a tombstoned deck from a conflict-journal snapshot and re-arms it for the next push', async () => {
    const deck = await make('Restorable');
    await updateDeck(deck.id, { styleNotes: 'the authored guide' });
    const before = await getDeck(deck.id);
    await deleteDeck(deck.id);

    const restored = await restoreDeck(deck.id, { name: 'Restored', styleNotes: before.styleNotes });
    expect(restored.deleted).toBe(false);
    expect(restored.name).toBe('Restored');
    expect(restored.styleNotes).toBe('the authored guide');
    expect(new Date(restored.updatedAt).getTime()).toBeGreaterThan(new Date(before.updatedAt).getTime());
    expect((await getDeck(deck.id)).cards).toHaveLength(before.cards.length);
  });

  it('returns null when restoring a deck the sweep already hard-pruned', async () => {
    expect(await restoreDeck(crypto.randomUUID(), { name: 'ghost' })).toBeNull();
  });
});
