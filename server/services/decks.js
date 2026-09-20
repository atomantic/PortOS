/**
 * Decks — db-primary card-deck design projects (playing cards and tarot).
 *
 * A deck row holds the style guide (notes + embrace/avoid influences), the
 * shared layout clause and face-orientation rule, sample references (gallery
 * images the vision step analyzed), per-record render/LLM pins and an optional
 * universe link. Each
 * card is its own `deck_cards` row so a completed render attaches to exactly
 * one card, serialized by the completion hook per deck. Rendered bytes stay in
 * the shared gallery (`data/images/`) and are referenced by filename, the same
 * way universe canon entries carry `imageRefs`.
 *
 * Federated (record kind `deck`, sync category `decks`): a deck rides one push
 * carrying its own row plus the FULL card roster, merged whole-record LWW on
 * the deck's `updatedAt`. The install-capability pins (`imageMode` /
 * `imageModelId` / `promptLlm`) and each card's in-flight `render` job state
 * are machine-local and stripped from the wire (`syncWire.js`'s `deck` case) —
 * a peer may not have the pinned provider, and a jobId means nothing there.
 * Rendered gallery bytes flow through the push asset manifest, so a received
 * card's `imageRefs` resolve locally. A deck that references a universe carries
 * only that universe's id — no canon text crosses with it.
 */

import { randomUUID } from 'node:crypto';
import { query, withTransaction, ensureSchema } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { trimTo, isNonBlankStr } from '../lib/textUtils.js';
import { sanitizeLlmRoutePin } from '../lib/llmRoutePin.js';
import { universeVisualStyleTokens } from '../lib/universeVisualStyle.js';
import {
  DECK_CARD_SIZE, DECK_CARD_SIZE_BY_KIND, DEFAULT_DECK_CARD_ORIENTATION, DEFAULT_LAYOUT_PROMPT,
  deckCardOrientation, deckCardRoster, deckCompletion,
} from '../lib/deckTemplates.js';
import { DECK_CARD_IMAGE_REFS_MAX, DECK_SAMPLES_MAX } from '../lib/deckValidation.js';
import { recordRenderPin } from '../lib/renderTargets.js';
import { createRecordWriteQueue } from '../lib/fileWriteQueue.js';
import {
  contentHashForRecord, setSyncBaseHash, deleteSyncBaseHash, flushBaseHashes,
  withBaseHashFlushBatch, maybeJournalBeforeOverwrite,
} from '../lib/conflictJournal.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from './sharing/recordEvents.js';

const notFound = (what = 'Deck') => new ServerError(`${what} not found`, {
  status: 404, code: what === 'Deck' ? 'DECK_NOT_FOUND' : 'DECK_CARD_NOT_FOUND',
});

const isoOrNull = (v) => (v instanceof Date ? v.toISOString() : (v || null));

// The peer-sync record kind for a deck (see the Federation section below).
export const DECK_KIND = 'deck';

// Per-DECK write tail. EVERY writer goes through it — the REST patches, the
// render-completion hook, the delete, the peer merge and the tombstone sweep —
// because the merge's read-modify-write spans two awaits (read local, then
// upsert) and a REST PATCH landing between them would be silently overwritten.
// Serializing only the merge side would leave exactly that gap open. Card
// writes key on their DECK id, not the card id: a card patch also touches the
// deck row, and the merge rewrites the whole roster, so they contend.
// Nothing inside a queued function may call another queued function — the tail
// is not re-entrant and a nested same-key call would deadlock.
const queueRecordWrite = createRecordWriteQueue();

const filenames = (values) => (Array.isArray(values) ? values : []).map((v) => trimTo(v)).filter(Boolean);

// ── Projections ──────────────────────────────────────────────────────────────

const projectDeck = (row) => {
  const d = row.definition && typeof row.definition === 'object' ? row.definition : {};
  const pin = recordRenderPin(d);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    universeId: row.universe_id || null,
    description: trimTo(d.description),
    styleNotes: trimTo(d.styleNotes),
    influences: universeVisualStyleTokens(d),
    layoutPrompt: trimTo(d.layoutPrompt) || DEFAULT_LAYOUT_PROMPT[row.kind] || '',
    cardOrientation: deckCardOrientation({ kind: row.kind, cardOrientation: d.cardOrientation }),
    cardOrientationPrompt: trimTo(d.cardOrientationPrompt) || null,
    samples: Array.isArray(d.samples) ? d.samples : [],
    imageMode: pin.mode,
    imageModelId: pin.modelId,
    cardSize: d.cardSize?.width && d.cardSize?.height ? d.cardSize : { ...(DECK_CARD_SIZE_BY_KIND[row.kind] || DECK_CARD_SIZE) },
    promptLlm: sanitizeLlmRoutePin(d.promptLlm),
    // ISO strings, not the driver's Date objects: these are the LWW clock the
    // sync merge compares and the wire form hashes, and a Date compares as
    // "not a string" (so every remote would win). JSON output is unchanged.
    createdAt: isoOrNull(row.created_at),
    updatedAt: isoOrNull(row.updated_at),
    deleted: row.deleted === true,
    deletedAt: row.deleted === true ? isoOrNull(row.deleted_at) : null,
  };
};

const projectCard = (row) => {
  const d = row.definition && typeof row.definition === 'object' ? row.definition : {};
  return {
    id: row.id,
    deckId: row.deck_id,
    key: row.key,
    position: row.position,
    name: trimTo(d.name),
    group: trimTo(d.group),
    groupLabel: trimTo(d.groupLabel),
    rank: d.rank ?? null,
    motif: trimTo(d.motif) || null,
    prompt: trimTo(d.prompt),
    negativePrompt: trimTo(d.negativePrompt),
    canonRef: d.canonRef && typeof d.canonRef === 'object' ? d.canonRef : null,
    imageRefs: filenames(d.imageRefs),
    primaryImageRef: trimTo(d.primaryImageRef) || null,
    render: d.render && typeof d.render === 'object' ? d.render : null,
    updatedAt: isoOrNull(row.updated_at),
  };
};

// ── Reads ────────────────────────────────────────────────────────────────────

const loadCards = async (client, deckId) => {
  const { rows } = await client.query('SELECT * FROM deck_cards WHERE deck_id = $1 ORDER BY position', [deckId]);
  return rows.map(projectCard);
};

export async function listDecks({ includeDeleted = false } = {}) {
  await ensureSchema();
  const { rows } = await query(
    `SELECT * FROM decks ${includeDeleted ? '' : 'WHERE deleted IS NOT TRUE'} ORDER BY updated_at DESC, id`,
  );
  // Completion reads three card fields; project just those instead of every
  // card's prompt/history so the index page doesn't pull the whole deck.
  // Scoped to the decks actually being returned — a tombstone keeps its roster
  // until the GC sweep, so an unscoped scan drags every pending-deletion deck's
  // cards through this query for a `byDeck` entry nothing ever looks up.
  const { rows: cardRows } = await query(`SELECT deck_id, jsonb_build_object(
      'prompt', left(definition->>'prompt', 1), 'imageRefs', COALESCE(definition->'imageRefs', '[]'::jsonb), 'render', definition->'render'
    ) AS definition FROM deck_cards WHERE deck_id = ANY($1::uuid[])`, [rows.map((r) => r.id)]);
  const byDeck = Map.groupBy(cardRows, (r) => r.deck_id);
  return rows.map((row) => ({
    ...projectDeck(row),
    completion: deckCompletion((byDeck.get(row.id) || []).map((r) => r.definition)),
  }));
}

export async function getDeck(id, { includeDeleted = false } = {}) {
  await ensureSchema();
  const { rows } = await query('SELECT * FROM decks WHERE id = $1', [id]);
  if (!rows[0] || (!includeDeleted && rows[0].deleted === true)) throw notFound();
  const cards = await loadCards({ query }, id);
  return { ...projectDeck(rows[0]), cards, completion: deckCompletion(cards) };
}

// ── Write helpers ────────────────────────────────────────────────────────────

/**
 * Read-mutate-write one deck's definition inside a transaction. `mutate(d, row)`
 * edits the definition copy and may return `{ name, universeId }` column
 * overrides. Resolves with the fresh deck.
 */
async function patchDeck(id, mutate) {
  await ensureSchema();
  await queueRecordWrite(id, () => withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM decks WHERE id = $1', [id]);
    if (!rows[0] || rows[0].deleted === true) throw notFound();
    const d = { ...(rows[0].definition || {}) };
    const columns = (await mutate(d, rows[0])) || {};
    await client.query(
      'UPDATE decks SET name = $2, universe_id = $3, definition = $4, updated_at = NOW() WHERE id = $1',
      [id, columns.name ?? rows[0].name, columns.universeId === undefined ? rows[0].universe_id : columns.universeId, d],
    );
  }));
  emitRecordUpdated(DECK_KIND, id);
  return getDeck(id);
}

/**
 * Read-mutate-write one card's definition. `mutate(d)` edits the copy and
 * returns false to skip the write. Resolves with the projected card, or null
 * when the card is gone / the write was skipped and `missingOk` is set (the
 * completion hook's contract: never throw on a card that vanished).
 *
 * `touch` bumps the DECK's `updatedAt` (the LWW clock the push compares on);
 * `touchCard` bumps the CARD row's. Both default on, and both must be off for
 * a write that only edits machine-local render bookkeeping: the card's
 * `updatedAt` rides the wire and is hashed (only `id`, `deckId` and `render`
 * are stripped — `syncWire.js`), so moving it on a purely local write shifts
 * the deck's content hash and manufactures a phantom conflict on the next
 * push from a peer.
 */
async function patchCard(deckId, cardId, mutate, { missingOk = false, touch = true, touchCard = true } = {}) {
  await ensureSchema();
  return queueRecordWrite(deckId, () => withTransaction(async (client) => {
    const { rows: deckRows } = await client.query('SELECT deleted FROM decks WHERE id = $1', [deckId]);
    if (!deckRows[0] || deckRows[0].deleted === true) {
      if (missingOk) return null;
      throw notFound();
    }
    const { rows } = await client.query('SELECT * FROM deck_cards WHERE deck_id = $1 AND id = $2', [deckId, cardId]);
    if (!rows[0]) {
      if (missingOk) return null;
      throw notFound('Card');
    }
    const d = { ...(rows[0].definition || {}) };
    if (mutate(d) === false) return null;
    const { rows: written } = await client.query(
      `UPDATE deck_cards SET definition = $2${touchCard ? ', updated_at = NOW()' : ''} WHERE id = $1 RETURNING *`,
      [cardId, d],
    );
    if (touch) await client.query('UPDATE decks SET updated_at = NOW() WHERE id = $1', [deckId]);
    return projectCard(written[0]);
  }));
}

// ── Deck CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a deck and mint its full card roster. When a universe is linked and
 * `seedStyleFromUniverse` is on, the universe's influences + style notes seed
 * the deck's style guide (the deck then evolves independently — a sample
 * analysis or manual edit never writes back to the universe).
 */
export async function createDeck({ name, kind, description = '', universeId = null, seedStyleFromUniverse = true } = {}) {
  await ensureSchema();
  let seeded = { styleNotes: '', influences: { embrace: [], avoid: [] } };
  if (universeId) {
    // Lazy: the universe barrel is heavy and only a linked deck needs it.
    const { getUniverse } = await import('./universeBuilder.js');
    const universe = await getUniverse(universeId).catch(() => null);
    if (!universe) {
      throw new ServerError(`Universe not found: ${universeId}`, { status: 400, code: 'DECK_UNIVERSE_NOT_FOUND' });
    }
    if (seedStyleFromUniverse) {
      seeded = { styleNotes: trimTo(universe.styleNotes), influences: universeVisualStyleTokens(universe) };
    }
  }
  const id = randomUUID();
  const definition = {
    description: trimTo(description),
    ...seeded,
    layoutPrompt: DEFAULT_LAYOUT_PROMPT[kind],
    cardOrientation: DEFAULT_DECK_CARD_ORIENTATION[kind] || null,
    samples: [],
    cardSize: { ...(DECK_CARD_SIZE_BY_KIND[kind] || DECK_CARD_SIZE) },
  };
  const roster = deckCardRoster(kind);
  await withTransaction(async (client) => {
    await client.query(
      'INSERT INTO decks (id, name, kind, universe_id, definition) VALUES ($1, $2, $3, $4, $5)',
      [id, trimTo(name), kind, universeId || null, definition],
    );
    await client.query(
      `INSERT INTO deck_cards (id, deck_id, position, key, definition)
       SELECT v.id, $1, v.position, v.key, v.definition
       FROM unnest($2::uuid[], $3::int[], $4::text[], $5::jsonb[]) AS v(id, position, key, definition)`,
      [
        id,
        roster.map(() => randomUUID()),
        roster.map((_, i) => i),
        roster.map((c) => c.key),
        roster.map((c) => ({
          name: c.name, group: c.group, groupLabel: c.groupLabel, rank: c.rank, motif: c.motif,
          prompt: '', negativePrompt: '', imageRefs: [],
        })),
      ],
    );
  });
  console.log(`🃏 deck created "${trimTo(name)}" kind=${kind} cards=${roster.length}${universeId ? ` universe=${universeId}` : ''}`);
  // Announce to the per-record push pipeline AND auto-subscribe every
  // decks-enabled peer, so a brand-new deck (and its later tombstone)
  // propagates without waiting for a manual subscribe. Mirrors the music-video
  // / creative-director `announceNewProject` shape.
  emitRecordUpdated(DECK_KIND, id);
  autoSubscribeRecordToAllPeers(DECK_KIND, id).catch(() => {});
  return getDeck(id);
}

/**
 * Apply the authored style-guide fields a patch carries onto a deck definition
 * copy. Absent keys preserve; a present key applies. Shared by `updateDeck` and
 * the conflict-journal `restoreDeck` (whose restorable set is exactly these) so
 * a restore can't drift from a normal edit. The install-capability pins are NOT
 * here — a restore never carries them (they're stripped from the wire).
 */
function applyDefinitionPatch(d, patch) {
  if (patch.description !== undefined) d.description = trimTo(patch.description);
  if (patch.styleNotes !== undefined) d.styleNotes = trimTo(patch.styleNotes);
  if (patch.influences !== undefined) d.influences = universeVisualStyleTokens({ influences: patch.influences });
  if (patch.layoutPrompt !== undefined) d.layoutPrompt = trimTo(patch.layoutPrompt);
  if (patch.cardOrientation !== undefined) d.cardOrientation = patch.cardOrientation;
  if (patch.cardOrientationPrompt !== undefined) d.cardOrientationPrompt = trimTo(patch.cardOrientationPrompt) || null;
  if (patch.samples !== undefined) d.samples = Array.isArray(patch.samples) ? patch.samples.slice(0, DECK_SAMPLES_MAX) : [];
  if (patch.cardSize !== undefined) d.cardSize = { width: patch.cardSize.width, height: patch.cardSize.height };
}

/**
 * Patch deck-level fields. Absent keys preserve; a present key applies (so
 * `universeId: null` unlinks and `imageMode: null` clears the pin — the
 * absent-vs-empty rule from root AGENTS.md).
 */
export function updateDeck(id, patch = {}) {
  return patchDeck(id, (d) => {
    applyDefinitionPatch(d, patch);
    if (patch.imageMode !== undefined) d.imageMode = patch.imageMode || null;
    if (patch.imageModelId !== undefined) d.imageModelId = patch.imageModelId || null;
    if (patch.promptLlm !== undefined) d.promptLlm = sanitizeLlmRoutePin(patch.promptLlm);
    return {
      ...(patch.name !== undefined ? { name: trimTo(patch.name) } : {}),
      ...(patch.universeId !== undefined ? { universeId: patch.universeId || null } : {}),
    };
  });
}

/**
 * Soft-delete a deck. A hard delete never reaches a peer — the tombstone is
 * what converges a subscribed instance, and the GC sweep hard-removes it once
 * every peer has had the grace window to see it (`pruneTombstonedDecks`).
 * Card rows are kept so a conflict-journal restore can un-tombstone the deck
 * with its roster intact; the sweep's ON DELETE CASCADE clears them for good.
 */
export async function deleteDeck(id) {
  await ensureSchema();
  const rowCount = await queueRecordWrite(id, async () => (await query(
    'UPDATE decks SET deleted = TRUE, deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted IS NOT TRUE',
    [id],
  )).rowCount);
  if (!rowCount) throw notFound();
  console.log(`🃏 deck deleted ${id}`);
  emitRecordDeleted(DECK_KIND, id);
  return { ok: true };
}

// ── Cards ────────────────────────────────────────────────────────────────────

/** Patch one card's authored fields (prompt, negative, name, refs, canon link). */
export async function updateCard(deckId, cardId, patch = {}) {
  const card = await patchCard(deckId, cardId, (d) => {
    if (patch.name !== undefined) d.name = trimTo(patch.name);
    if (patch.prompt !== undefined) { d.prompt = trimTo(patch.prompt); d.promptSource = 'edited'; }
    if (patch.negativePrompt !== undefined) d.negativePrompt = trimTo(patch.negativePrompt);
    if (patch.canonRef !== undefined) d.canonRef = patch.canonRef || null;
    if (patch.imageRefs !== undefined) d.imageRefs = filenames(patch.imageRefs).slice(-DECK_CARD_IMAGE_REFS_MAX);
    if (patch.primaryImageRef !== undefined) d.primaryImageRef = patch.primaryImageRef || null;
    // A primary that no longer exists in the history falls back to the latest.
    if (d.primaryImageRef && !filenames(d.imageRefs).includes(d.primaryImageRef)) d.primaryImageRef = null;
  });
  emitRecordUpdated(DECK_KIND, deckId);
  return card;
}

/**
 * Bulk-apply generated prompts / canon assignments. `entries` is
 * `[{ cardId, prompt?, canonRef? }]`; a card whose id is unknown is skipped
 * (the deck may have been edited between generation and apply).
 */
export async function applyCardGenerations(deckId, entries = []) {
  let applied = 0;
  for (const entry of entries) {
    const card = await patchCard(deckId, entry.cardId, (d) => {
      if (entry.prompt !== undefined) { d.prompt = trimTo(entry.prompt); d.promptSource = 'generated'; }
      if (entry.canonRef !== undefined) d.canonRef = entry.canonRef || null;
    }, { missingOk: true, touch: false });
    if (card) applied += 1;
  }
  if (applied) {
    await queueRecordWrite(deckId, () => query('UPDATE decks SET updated_at = NOW() WHERE id = $1', [deckId]));
    emitRecordUpdated(DECK_KIND, deckId);
  }
  return applied;
}

/**
 * Stamp freshly queued renders onto their cards in one statement:
 * `entries` is `[{ cardId, render }]`. A card the completion hook already
 * filed for the SAME job (a backend that finished before the stamp landed)
 * keeps its completed record — the queued stamp must not regress it.
 *
 * Deliberately leaves `updated_at` alone on both tables: which job a card is
 * waiting on is machine-local bookkeeping the wire strips, so bumping the
 * card's clock would move the deck's sync content hash for a state that means
 * nothing on a peer (#7364).
 */
export async function markCardsRenderQueued(deckId, entries = []) {
  if (!entries.length) return;
  await ensureSchema();
  const stampedAt = new Date().toISOString();
  await queueRecordWrite(deckId, () => query(
    `UPDATE deck_cards c
       SET definition = c.definition || jsonb_build_object('render', v.render)
       FROM unnest($2::uuid[], $3::jsonb[]) AS v(id, render)
       WHERE c.deck_id = $1 AND c.id = v.id
         AND COALESCE(c.definition->'render'->>'jobId', '') <> v.render->>'jobId'`,
    [deckId, entries.map((e) => e.cardId), entries.map((e) => ({ ...e.render, updatedAt: stampedAt }))],
  ));
}

/**
 * Terminal state for a render that never produced a file. Only the job the
 * card is currently waiting on may flip it — a stale failure event for a
 * superseded job must not mark a newer queued render as failed. Like the
 * queued stamp above this edits only the wire-stripped `render` record, so
 * neither clock moves (#7364).
 */
export function markCardRenderTerminal(deckId, cardId, { jobId, status, error = null }) {
  return patchCard(deckId, cardId, (d) => {
    if (!d.render || d.render.jobId !== jobId) return false;
    d.render = { ...d.render, status, error: error || null, updatedAt: new Date().toISOString() };
  }, { missingOk: true, touch: false, touchCard: false });
}

/**
 * Attach a completed render to its card (called by the completion hook):
 * append the gallery filename, promote it to primary, clear the in-flight
 * record. Returns the card, or null when the card no longer exists.
 */
export async function attachCardRender({ deckId, cardId, filename, jobId }) {
  const card = await patchCard(deckId, cardId, (d) => {
    d.imageRefs = [...filenames(d.imageRefs).filter((f) => f !== filename), filename].slice(-DECK_CARD_IMAGE_REFS_MAX);
    d.primaryImageRef = filename;
    d.render = { ...(d.render || {}), jobId, status: 'completed', error: null, filename, updatedAt: new Date().toISOString() };
  }, { missingOk: true });
  // `imageRefs` / `primaryImageRef` are wire-visible, so a completed render is
  // a real content change peers must receive (the in-flight `render` stamps
  // above are stripped from the wire and deliberately announce nothing).
  if (card) emitRecordUpdated(DECK_KIND, deckId);
  return card;
}

// ── Samples (style references) ───────────────────────────────────────────────

/**
 * Persist an analyzed sample; with `adopt`, apply the proposed style guide in
 * the same transaction so the pair can't half-land. Idempotent on sample id.
 */
export function addSample(id, sample, { adopt } = {}) {
  return patchDeck(id, (d) => {
    const samples = (Array.isArray(d.samples) ? d.samples : []).filter((s) => s?.id !== sample.id);
    samples.push({
      id: sample.id,
      title: trimTo(sample.title),
      prompt: trimTo(sample.prompt),
      imageRef: sample.imageRef,
      createdAt: sample.createdAt || new Date().toISOString(),
    });
    if (samples.length > DECK_SAMPLES_MAX) {
      throw new ServerError(`A deck holds at most ${DECK_SAMPLES_MAX} samples`, { status: 400, code: 'DECK_SAMPLES_MAX' });
    }
    d.samples = samples;
    if (adopt) {
      d.styleNotes = trimTo(adopt.styleNotes);
      d.influences = universeVisualStyleTokens(adopt);
      if (trimTo(adopt.layoutPrompt)) d.layoutPrompt = trimTo(adopt.layoutPrompt);
    }
  });
}

export function removeSample(id, sampleId) {
  return patchDeck(id, (d) => {
    d.samples = (Array.isArray(d.samples) ? d.samples : []).filter((s) => s?.id !== sampleId);
  });
}

// ── Federation (record kind `deck`, sync category `decks`) ───────────────────
//
// A deck rides ONE push carrying the deck row plus its full card roster, merged
// whole-record LWW on the deck's `updatedAt`. Cards are addressed by their
// stable roster `key` (not by row id) so two machines that minted the same deck
// kind converge on the same 52/78 slots instead of doubling them. Card ids stay
// machine-local for the same reason: the receiver keeps its own row id for a key
// it already holds, and mints one for a key it doesn't.

/**
 * One deck's sanitized record (tombstone surfaced), or null when unknown. Only
 * a genuine miss answers null — a DB fault must NOT read as "absent," or the
 * merge would treat an existing deck as new and skip the LWW compare entirely.
 */
export async function getDeckForSync(id) {
  return getDeck(id, { includeDeleted: true }).catch((error) => {
    if (error?.code === 'DECK_NOT_FOUND') return null;
    throw error;
  });
}

/** Every LIVE deck as `{ id, updatedAt }` — the full-sync coverage compare set. */
export async function listDecksForSync() {
  await ensureSchema();
  const { rows } = await query('SELECT id, updated_at FROM decks WHERE deleted IS NOT TRUE');
  return rows.map((r) => ({ id: r.id, updatedAt: isoOrNull(r.updated_at) }));
}

/** Deck ids — live only by default, or all (incl. tombstones) for the sweep. */
export async function listDeckIdsForSync({ includeDeleted = false } = {}) {
  await ensureSchema();
  const { rows } = await query(
    `SELECT id FROM decks ${includeDeleted ? '' : 'WHERE deleted IS NOT TRUE'}`,
  );
  return rows.map((r) => r.id);
}

// The wire-form card fields the receiver persists. `id` and `render` are
// machine-local (a row id and an in-flight jobId mean nothing on a peer), so a
// remote card never overwrites either.
const cardDefinitionFromRemote = (card) => ({
  name: trimTo(card?.name),
  group: trimTo(card?.group),
  groupLabel: trimTo(card?.groupLabel),
  rank: card?.rank ?? null,
  motif: trimTo(card?.motif) || null,
  prompt: trimTo(card?.prompt),
  negativePrompt: trimTo(card?.negativePrompt),
  canonRef: card?.canonRef && typeof card.canonRef === 'object' ? card.canonRef : null,
  imageRefs: filenames(card?.imageRefs).slice(-DECK_CARD_IMAGE_REFS_MAX),
  primaryImageRef: trimTo(card?.primaryImageRef) || null,
});

// The deck-level definition fields that travel. The install-capability pins
// (`imageMode` / `imageModelId` / `promptLlm`) are absent from the wire, so the
// receiver's own pins are carried forward from its local copy instead of being
// reset to null by a remote win.
const definitionFromRemote = (remote, local) => ({
  description: trimTo(remote?.description),
  styleNotes: trimTo(remote?.styleNotes),
  influences: universeVisualStyleTokens(remote),
  layoutPrompt: trimTo(remote?.layoutPrompt),
  // A pre-v2 peer has no keys to send. Preserve a receiver's authored choice
  // in that sender-behind case; a current peer's explicit null still clears a
  // prompt override as intended.
  cardOrientation: Object.hasOwn(remote || {}, 'cardOrientation')
    ? deckCardOrientation({ kind: remote?.kind, cardOrientation: remote?.cardOrientation })
    : (local?.cardOrientation || DEFAULT_DECK_CARD_ORIENTATION[remote?.kind] || null),
  cardOrientationPrompt: Object.hasOwn(remote || {}, 'cardOrientationPrompt')
    ? (trimTo(remote?.cardOrientationPrompt) || null)
    : (local?.cardOrientationPrompt || null),
  samples: Array.isArray(remote?.samples) ? remote.samples.slice(0, DECK_SAMPLES_MAX) : [],
  cardSize: remote?.cardSize?.width && remote?.cardSize?.height
    ? { width: remote.cardSize.width, height: remote.cardSize.height }
    : undefined,
  imageMode: local?.imageMode ?? null,
  imageModelId: local?.imageModelId ?? null,
  promptLlm: local?.promptLlm ?? null,
});

// Newest ISO timestamp wins; a tie keeps the local copy (no churn on equal clocks).
const remoteWinsOver = (remoteAt, localAt) => {
  if (!isNonBlankStr(remoteAt)) return false;
  if (!isNonBlankStr(localAt)) return true;
  return new Date(remoteAt).getTime() > new Date(localAt).getTime();
};

/**
 * Apply one remote deck inside a transaction: upsert the deck row (tombstone
 * included) and reconcile its cards by roster `key` — upsert what the remote
 * carries, drop the keys it no longer has. A tombstone carries no cards, so it
 * leaves the local roster alone (a restore then has something to restore to).
 */
async function writeRemoteDeck(id, remote, local) {
  const localDefinition = local ? {
    imageMode: local.imageMode,
    imageModelId: local.imageModelId,
    promptLlm: local.promptLlm,
    cardOrientation: local.cardOrientation,
    cardOrientationPrompt: local.cardOrientationPrompt,
  } : null;
  await withTransaction(async (client) => {
    const definition = definitionFromRemote(remote, localDefinition);
    if (definition.cardSize === undefined) {
      definition.cardSize = { ...(DECK_CARD_SIZE_BY_KIND[remote.kind] || DECK_CARD_SIZE) };
    }
    await client.query(
      `INSERT INTO decks (id, name, kind, universe_id, definition, updated_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, kind = EXCLUDED.kind, universe_id = EXCLUDED.universe_id,
         definition = EXCLUDED.definition, updated_at = EXCLUDED.updated_at,
         deleted = EXCLUDED.deleted, deleted_at = EXCLUDED.deleted_at`,
      [
        id, trimTo(remote.name), remote.kind, remote.universeId || null, definition,
        remote.updatedAt, remote.deleted === true,
        remote.deleted === true ? (remote.deletedAt || new Date().toISOString()) : null,
      ],
    );
    if (remote.deleted === true) return;
    const cards = Array.isArray(remote.cards) ? remote.cards : [];
    if (!cards.length) return;
    await client.query(
      `INSERT INTO deck_cards (id, deck_id, position, key, definition)
       SELECT COALESCE(existing.id, v.new_id), $1, v.position, v.key, v.definition
       FROM unnest($2::uuid[], $3::int[], $4::text[], $5::jsonb[]) AS v(new_id, position, key, definition)
       LEFT JOIN deck_cards existing ON existing.deck_id = $1 AND existing.key = v.key
       ON CONFLICT (deck_id, key) DO UPDATE SET
         position = EXCLUDED.position, definition = EXCLUDED.definition, updated_at = NOW()`,
      [
        id,
        cards.map(() => randomUUID()),
        cards.map((c, i) => (Number.isInteger(c?.position) ? c.position : i)),
        cards.map((c) => String(c.key)),
        cards.map(cardDefinitionFromRemote),
      ],
    );
    await client.query(
      'DELETE FROM deck_cards WHERE deck_id = $1 AND key <> ALL($2::text[])',
      [id, cards.map((c) => String(c.key))],
    );
  });
}

/**
 * Merge an incoming batch of deck records from a peer (LWW, tombstone-aware).
 * Serialized per-id against the REST writers, journals the about-to-be-
 * overwritten local version when the remote wins, and re-stamps the
 * conflict-journal base hash for the record it just wrote.
 */
export async function mergeDecksFromSync(remoteRecords, { source = { via: 'sync', peerId: null } } = {}) {
  if (!Array.isArray(remoteRecords) || !remoteRecords.length) return { applied: false, count: 0 };
  await ensureSchema();
  let changed = 0;
  for (const remote of remoteRecords) {
    const id = remote?.id;
    // `kind` is a CHECK-constrained column — a record naming an unknown deck
    // kind would fail the INSERT, so drop it on the floor like a missing id.
    if (!isNonBlankStr(id) || !isNonBlankStr(remote?.kind) || !DECK_CARD_SIZE_BY_KIND[remote.kind]) continue;
    const applied = await queueRecordWrite(id, async () => {
      const local = await getDeckForSync(id);
      if (local && !remoteWinsOver(remote.updatedAt, local.updatedAt)) return false;
      // An already-tombstoned local deck re-receiving the same tombstone is a
      // no-op — writing it would restart its GC grace period every cycle.
      if (local?.deleted === true && remote.deleted === true) return false;
      if (local) {
        await maybeJournalBeforeOverwrite({ kind: DECK_KIND, id, local, remote, source });
      }
      await writeRemoteDeck(id, remote, local);
      const merged = await getDeckForSync(id);
      if (merged) await setSyncBaseHash(DECK_KIND, id, contentHashForRecord(DECK_KIND, merged));
      return true;
    });
    if (applied) changed += 1;
  }
  await flushBaseHashes();
  if (changed > 0) console.log(`🃏 deck sync: merged ${changed} deck(s)`);
  return changed === 0 ? { applied: false, count: 0 } : { applied: true, count: changed };
}

/**
 * Hard-remove tombstoned decks deleted before `cutoffEpochMs`; evicts each base
 * hash. `cutoffEpochMs` is an ABSOLUTE epoch-ms instant (what `cutoffForKind`
 * produces), not a duration — matching every other `pruneTombstonedX`.
 */
export async function pruneTombstonedDecks(cutoffEpochMs) {
  if (!Number.isFinite(cutoffEpochMs)) return { pruned: 0, ids: [] };
  await ensureSchema();
  const cutoff = new Date(cutoffEpochMs).toISOString();
  const { rows } = await query(
    'SELECT id FROM decks WHERE deleted IS TRUE AND deleted_at IS NOT NULL AND deleted_at < $1',
    [cutoff],
  );
  const ids = [];
  await withBaseHashFlushBatch(async () => {
    for (const row of rows) {
      // Re-check the predicate INSIDE the per-id tail: a merge that rewrote
      // this tombstone with a fresher deletedAt mid-sweep restarted its grace
      // period, and hard-deleting it early would let an offline peer
      // resurrect the record. Cards go with it via ON DELETE CASCADE.
      const pruned = await queueRecordWrite(row.id, async () => {
        const { rowCount } = await query(
          'DELETE FROM decks WHERE id = $1 AND deleted IS TRUE AND deleted_at < $2',
          [row.id, cutoff],
        );
        return rowCount > 0;
      });
      if (!pruned) continue;
      ids.push(row.id);
      await deleteSyncBaseHash(DECK_KIND, row.id).catch(() => {});
    }
  });
  if (ids.length) console.log(`🃏 deck tombstone GC: pruned ${ids.length} deck(s)`);
  return { pruned: ids.length, ids };
}

/**
 * Restore a tombstoned/overwritten deck from a conflict-journal snapshot:
 * apply the restorable fields, un-tombstone, and bump `updatedAt` so the
 * restore wins the next LWW and re-pushes. Returns null for a deck that has
 * already been hard-pruned (→ ERR_TARGET_GONE at the route).
 */
export async function restoreDeck(id, patch = {}) {
  await ensureSchema();
  return queueRecordWrite(id, async () => {
    const { rows } = await query('SELECT * FROM decks WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const d = { ...(rows[0].definition || {}) };
    applyDefinitionPatch(d, patch);
    await query(
      `UPDATE decks SET name = $2, universe_id = $3, definition = $4,
         updated_at = NOW(), deleted = FALSE, deleted_at = NULL WHERE id = $1`,
      [
        id,
        patch.name !== undefined ? trimTo(patch.name) : rows[0].name,
        patch.universeId !== undefined ? (patch.universeId || null) : rows[0].universe_id,
        d,
      ],
    );
    emitRecordUpdated(DECK_KIND, id);
    return getDeck(id);
  });
}
