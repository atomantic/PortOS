/** Deck designer over HTTP and PostgreSQL. Runs only against portos_test. */
import { afterAll, describe, expect, it } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import deckRoutes from './decks.js';
import { attachCardRender, markCardsRenderQueued, markCardRenderTerminal } from '../services/decks.js';
import { cardStatus } from '../lib/deckTemplates.js';

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('routes/decks.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM decks WHERE id = ANY($1::uuid[])', [ids]);
  await close();
});
const app = express();
app.use(express.json());
app.use('/decks', deckRoutes);
app.use(errorMiddleware);
const get = (path = '') => request(app).get(`/decks${path}`);
const post = (path, body) => request(app).post(`/decks${path}`).send(body);
const patch = (path, body) => request(app).patch(`/decks${path}`).send(body);
const del = (path) => request(app).delete(`/decks${path}`);

const create = async (body) => {
  const saved = await post('', body);
  expect(saved.status).toBe(201);
  ids.push(saved.body.id);
  return saved.body;
};

describe.skipIf(!ready)('decks over HTTP and PostgreSQL', () => {
  it('creates a tarot deck with its full roster and default layout, lists it with completion', async () => {
    const deck = await create({ name: 'Example Deck', kind: 'tarot' });
    expect(deck.cards).toHaveLength(79);
    expect(deck.layoutPrompt).toMatch(/tarot card/);
    expect(deck.completion).toMatchObject({ total: 79, prompted: 0, rendered: 0, percent: 0 });
    const fool = deck.cards.find((c) => c.key === 'major-0');
    expect(fool).toMatchObject({ name: '0 · The Fool', imageRefs: [] });
    expect(cardStatus(fool)).toBe('empty');
    const list = await get();
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual(expect.objectContaining({ id: deck.id, kind: 'tarot', completion: expect.objectContaining({ total: 79 }) }));
  });

  it('rejects an unknown kind and a linked universe that does not exist', async () => {
    expect((await post('', { name: 'Bad', kind: 'uno' })).status).toBe(400);
    const missing = await post('', { name: 'Orphan', kind: 'playing', universeId: 'no-such-universe' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('DECK_UNIVERSE_NOT_FOUND');
  });

  it('patches the style guide + pins and per-card prompts, then reflects completion', async () => {
    const deck = await create({ name: 'Style Deck', kind: 'playing' });
    const styled = await patch(`/${deck.id}`, {
      styleNotes: 'Engraved, sepia, celestial.',
      influences: { embrace: ['copperplate engraving', '  aged paper  '], avoid: ['blurry'] },
      layoutPrompt: 'Full playing card',
      imageMode: 'codex',
      imageModelId: 'gpt-image-2',
      promptLlm: { providerId: 'p1', model: 'm1', effort: 'high' },
    });
    expect(styled.status).toBe(200);
    expect(styled.body).toMatchObject({
      styleNotes: 'Engraved, sepia, celestial.',
      influences: { embrace: ['copperplate engraving', 'aged paper'], avoid: ['blurry'] },
      layoutPrompt: 'Full playing card',
      imageMode: 'codex',
      imageModelId: 'gpt-image-2',
      promptLlm: { providerId: 'p1', model: 'm1', effort: 'high' },
    });
    // Clearing the pin: key present with null.
    expect((await patch(`/${deck.id}`, { imageMode: null, imageModelId: null })).body).toMatchObject({ imageMode: null, imageModelId: null });
    expect((await patch(`/${deck.id}`, { bogus: 1 })).status).toBe(400);
    expect((await get('/not-a-uuid')).status).toBe(400);

    const ace = deck.cards.find((c) => c.key === 'spades-A');
    const edited = await patch(`/${deck.id}/cards/${ace.id}`, { prompt: 'one great ornate spade', negativePrompt: 'text' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ key: 'spades-A', prompt: 'one great ornate spade', negativePrompt: 'text' });
    expect(cardStatus(edited.body)).toBe('prompted');
    expect((await get(`/${deck.id}`)).body.completion).toMatchObject({ prompted: 1, rendered: 0 });
    expect((await patch(`/${deck.id}/cards/${randomUUID()}`, { prompt: 'x' })).status).toBe(404);
  });

  it('files a completed render onto the card, ignores a stale terminal event, and lets the drawer curate the history', async () => {
    const deck = await create({ name: 'Render Deck', kind: 'playing' });
    const card = deck.cards.find((c) => c.key === 'hearts-Q');
    await patch(`/${deck.id}/cards/${card.id}`, { prompt: 'a queen' });
    await markCardsRenderQueued(deck.id, [{ cardId: card.id, render: { jobId: 'job-1', status: 'queued', queuedAt: new Date().toISOString() } }]);
    const readCard = async () => (await get(`/${deck.id}`)).body.cards.find((c) => c.id === card.id);
    expect(cardStatus(await readCard())).toBe('queued');

    // A failure event for a superseded job must not flip the card.
    expect(await markCardRenderTerminal(deck.id, card.id, { jobId: 'job-0', status: 'failed' })).toBeNull();
    expect(cardStatus(await readCard())).toBe('queued');

    const attached = await attachCardRender({ deckId: deck.id, cardId: card.id, filename: 'job-1.png', jobId: 'job-1' });
    expect(attached).toMatchObject({ imageRefs: ['job-1.png'], primaryImageRef: 'job-1.png' });
    expect(cardStatus(attached)).toBe('rendered');
    // A queued stamp that lands AFTER the hook filed the same job must not regress it.
    await markCardsRenderQueued(deck.id, [{ cardId: card.id, render: { jobId: 'job-1', status: 'queued' } }]);
    expect(cardStatus(await readCard())).toBe('rendered');
    const again = await attachCardRender({ deckId: deck.id, cardId: card.id, filename: 'job-2.png', jobId: 'job-2' });
    expect(again).toMatchObject({ imageRefs: ['job-1.png', 'job-2.png'], primaryImageRef: 'job-2.png' });
    expect((await get(`/${deck.id}`)).body.completion).toMatchObject({ rendered: 1, inFlight: 0 });

    // Drawer: pick the older render as primary, then drop it — primary falls back.
    expect((await patch(`/${deck.id}/cards/${card.id}`, { primaryImageRef: 'job-1.png' })).body.primaryImageRef).toBe('job-1.png');
    const curated = await patch(`/${deck.id}/cards/${card.id}`, { imageRefs: ['job-2.png'] });
    expect(curated.body).toMatchObject({ imageRefs: ['job-2.png'], primaryImageRef: null });
    expect(cardStatus(curated.body)).toBe('rendered');
    // A card that vanished returns null rather than throwing from the hook.
    expect(await attachCardRender({ deckId: deck.id, cardId: randomUUID(), filename: 'x.png', jobId: 'j' })).toBeNull();
  });

  it('adds a sample with an adopted style guide in one write, removes it, and cascades on delete', async () => {
    const deck = await create({ name: 'Sample Deck', kind: 'tarot' });
    const sample = { id: 'deck-sample-1', title: 'Poster', prompt: 'a lighthouse poster', imageRef: 'upload-1.png' };
    const adopted = await post(`/${deck.id}/samples`, {
      sample,
      adopt: { styleNotes: 'From the poster.', influences: { embrace: ['art deco'], avoid: [] }, layoutPrompt: 'Framed' },
    });
    expect(adopted.status).toBe(200);
    expect(adopted.body).toMatchObject({ styleNotes: 'From the poster.', influences: { embrace: ['art deco'], avoid: [] }, layoutPrompt: 'Framed' });
    expect(adopted.body.samples).toHaveLength(1);
    expect(adopted.body.samples[0]).toMatchObject({ id: 'deck-sample-1', imageRef: 'upload-1.png' });
    // Idempotent on id — a re-sent add doesn't duplicate.
    expect((await post(`/${deck.id}/samples`, { sample })).body.samples).toHaveLength(1);
    expect((await del(`/${deck.id}/samples/deck-sample-1`)).body.samples).toHaveLength(0);

    // A delete tombstones the deck so the deletion can reach subscribed peers
    // (#decks federation). It reads as gone, and a second delete 404s — but the
    // card rows survive until the tombstone GC hard-removes the deck, which is
    // what lets a conflict-journal restore bring the roster back. The cascade
    // itself is covered by `services/decksSync.db.test.js`.
    expect((await del(`/${deck.id}`)).status).toBe(200);
    expect((await get(`/${deck.id}`)).status).toBe(404);
    expect((await get('')).body.some((d) => d.id === deck.id)).toBe(false);
    const { rows } = await query('SELECT deleted, deleted_at FROM decks WHERE id = $1', [deck.id]);
    expect(rows[0]).toMatchObject({ deleted: true });
    expect(rows[0].deleted_at).toBeTruthy();
    expect((await del(`/${deck.id}`)).status).toBe(404);
  });
});
