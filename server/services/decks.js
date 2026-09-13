/**
 * Decks — db-primary card-deck design projects (playing cards and tarot).
 *
 * A deck row holds the style guide (notes + embrace/avoid influences), the
 * shared layout clause, sample references (gallery images the vision step
 * analyzed), per-record render/LLM pins and an optional universe link. Each
 * card is its own `deck_cards` row so a completed render attaches to exactly
 * one card, serialized by the completion hook per deck. Rendered bytes stay in
 * the shared gallery (`data/images/`) and are referenced by filename, the same
 * way universe canon entries carry `imageRefs`.
 *
 * Machine-local: decks never federate (root AGENTS.md privacy rule) — a deck
 * that references a universe carries only that universe's id.
 */

import { randomUUID } from 'node:crypto';
import { query, withTransaction, ensureSchema } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { trimTo } from '../lib/textUtils.js';
import { sanitizeLlmRoutePin } from '../lib/llmRoutePin.js';
import { universeVisualStyleTokens } from '../lib/universeVisualStyle.js';
import { DECK_CARD_SIZE, DECK_CARD_SIZE_BY_KIND, DEFAULT_LAYOUT_PROMPT, deckCardRoster, deckCompletion } from '../lib/deckTemplates.js';
import { DECK_CARD_IMAGE_REFS_MAX, DECK_SAMPLES_MAX } from '../lib/deckValidation.js';
import { recordRenderPin } from '../lib/renderTargets.js';

const notFound = (what = 'Deck') => new ServerError(`${what} not found`, {
  status: 404, code: what === 'Deck' ? 'DECK_NOT_FOUND' : 'DECK_CARD_NOT_FOUND',
});

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
    samples: Array.isArray(d.samples) ? d.samples : [],
    imageMode: pin.mode,
    imageModelId: pin.modelId,
    cardSize: d.cardSize?.width && d.cardSize?.height ? d.cardSize : { ...(DECK_CARD_SIZE_BY_KIND[row.kind] || DECK_CARD_SIZE) },
    promptLlm: sanitizeLlmRoutePin(d.promptLlm),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    updatedAt: row.updated_at,
  };
};

// ── Reads ────────────────────────────────────────────────────────────────────

const loadCards = async (client, deckId) => {
  const { rows } = await client.query('SELECT * FROM deck_cards WHERE deck_id = $1 ORDER BY position', [deckId]);
  return rows.map(projectCard);
};

export async function listDecks() {
  await ensureSchema();
  const { rows } = await query('SELECT * FROM decks ORDER BY updated_at DESC, id');
  // Completion reads three card fields; project just those instead of every
  // card's prompt/history so the index page doesn't pull the whole deck.
  const { rows: cardRows } = await query(`SELECT deck_id, jsonb_build_object(
      'prompt', left(definition->>'prompt', 1), 'imageRefs', COALESCE(definition->'imageRefs', '[]'::jsonb), 'render', definition->'render'
    ) AS definition FROM deck_cards`);
  const byDeck = Map.groupBy(cardRows, (r) => r.deck_id);
  return rows.map((row) => ({
    ...projectDeck(row),
    completion: deckCompletion((byDeck.get(row.id) || []).map((r) => r.definition)),
  }));
}

export async function getDeck(id) {
  await ensureSchema();
  const { rows } = await query('SELECT * FROM decks WHERE id = $1', [id]);
  if (!rows[0]) throw notFound();
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
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM decks WHERE id = $1', [id]);
    if (!rows[0]) throw notFound();
    const d = { ...(rows[0].definition || {}) };
    const columns = (await mutate(d, rows[0])) || {};
    await client.query(
      'UPDATE decks SET name = $2, universe_id = $3, definition = $4, updated_at = NOW() WHERE id = $1',
      [id, columns.name ?? rows[0].name, columns.universeId === undefined ? rows[0].universe_id : columns.universeId, d],
    );
  });
  return getDeck(id);
}

/**
 * Read-mutate-write one card's definition. `mutate(d)` edits the copy and
 * returns false to skip the write. Resolves with the projected card, or null
 * when the card is gone / the write was skipped and `missingOk` is set (the
 * completion hook's contract: never throw on a card that vanished).
 */
async function patchCard(deckId, cardId, mutate, { missingOk = false, touch = true } = {}) {
  await ensureSchema();
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM deck_cards WHERE deck_id = $1 AND id = $2', [deckId, cardId]);
    if (!rows[0]) {
      if (missingOk) return null;
      throw notFound('Card');
    }
    const d = { ...(rows[0].definition || {}) };
    if (mutate(d) === false) return null;
    const { rows: written } = await client.query(
      'UPDATE deck_cards SET definition = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [cardId, d],
    );
    if (touch) await client.query('UPDATE decks SET updated_at = NOW() WHERE id = $1', [deckId]);
    return projectCard(written[0]);
  });
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
  return getDeck(id);
}

/**
 * Patch deck-level fields. Absent keys preserve; a present key applies (so
 * `universeId: null` unlinks and `imageMode: null` clears the pin — the
 * absent-vs-empty rule from root AGENTS.md).
 */
export function updateDeck(id, patch = {}) {
  return patchDeck(id, (d) => {
    if (patch.description !== undefined) d.description = trimTo(patch.description);
    if (patch.styleNotes !== undefined) d.styleNotes = trimTo(patch.styleNotes);
    if (patch.influences !== undefined) d.influences = universeVisualStyleTokens({ influences: patch.influences });
    if (patch.layoutPrompt !== undefined) d.layoutPrompt = trimTo(patch.layoutPrompt);
    if (patch.imageMode !== undefined) d.imageMode = patch.imageMode || null;
    if (patch.imageModelId !== undefined) d.imageModelId = patch.imageModelId || null;
    if (patch.cardSize !== undefined) d.cardSize = { width: patch.cardSize.width, height: patch.cardSize.height };
    if (patch.promptLlm !== undefined) d.promptLlm = sanitizeLlmRoutePin(patch.promptLlm);
    return {
      ...(patch.name !== undefined ? { name: trimTo(patch.name) } : {}),
      ...(patch.universeId !== undefined ? { universeId: patch.universeId || null } : {}),
    };
  });
}

export async function deleteDeck(id) {
  await ensureSchema();
  const { rowCount } = await query('DELETE FROM decks WHERE id = $1', [id]);
  if (!rowCount) throw notFound();
  console.log(`🃏 deck deleted ${id}`);
  return { ok: true };
}

// ── Cards ────────────────────────────────────────────────────────────────────

/** Patch one card's authored fields (prompt, negative, name, refs, canon link). */
export function updateCard(deckId, cardId, patch = {}) {
  return patchCard(deckId, cardId, (d) => {
    if (patch.name !== undefined) d.name = trimTo(patch.name);
    if (patch.prompt !== undefined) { d.prompt = trimTo(patch.prompt); d.promptSource = 'edited'; }
    if (patch.negativePrompt !== undefined) d.negativePrompt = trimTo(patch.negativePrompt);
    if (patch.canonRef !== undefined) d.canonRef = patch.canonRef || null;
    if (patch.imageRefs !== undefined) d.imageRefs = filenames(patch.imageRefs).slice(-DECK_CARD_IMAGE_REFS_MAX);
    if (patch.primaryImageRef !== undefined) d.primaryImageRef = patch.primaryImageRef || null;
    // A primary that no longer exists in the history falls back to the latest.
    if (d.primaryImageRef && !filenames(d.imageRefs).includes(d.primaryImageRef)) d.primaryImageRef = null;
  });
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
  if (applied) await query('UPDATE decks SET updated_at = NOW() WHERE id = $1', [deckId]);
  return applied;
}

/**
 * Stamp freshly queued renders onto their cards in one statement:
 * `entries` is `[{ cardId, render }]`. A card the completion hook already
 * filed for the SAME job (a backend that finished before the stamp landed)
 * keeps its completed record — the queued stamp must not regress it.
 */
export async function markCardsRenderQueued(deckId, entries = []) {
  if (!entries.length) return;
  await ensureSchema();
  const stampedAt = new Date().toISOString();
  await query(
    `UPDATE deck_cards c
       SET definition = c.definition || jsonb_build_object('render', v.render), updated_at = NOW()
       FROM unnest($2::uuid[], $3::jsonb[]) AS v(id, render)
       WHERE c.deck_id = $1 AND c.id = v.id
         AND COALESCE(c.definition->'render'->>'jobId', '') <> v.render->>'jobId'`,
    [deckId, entries.map((e) => e.cardId), entries.map((e) => ({ ...e.render, updatedAt: stampedAt }))],
  );
}

/**
 * Terminal state for a render that never produced a file. Only the job the
 * card is currently waiting on may flip it — a stale failure event for a
 * superseded job must not mark a newer queued render as failed.
 */
export function markCardRenderTerminal(deckId, cardId, { jobId, status, error = null }) {
  return patchCard(deckId, cardId, (d) => {
    if (!d.render || d.render.jobId !== jobId) return false;
    d.render = { ...d.render, status, error: error || null, updatedAt: new Date().toISOString() };
  }, { missingOk: true, touch: false });
}

/**
 * Attach a completed render to its card (called by the completion hook):
 * append the gallery filename, promote it to primary, clear the in-flight
 * record. Returns the card, or null when the card no longer exists.
 */
export function attachCardRender({ deckId, cardId, filename, jobId }) {
  return patchCard(deckId, cardId, (d) => {
    d.imageRefs = [...filenames(d.imageRefs).filter((f) => f !== filename), filename].slice(-DECK_CARD_IMAGE_REFS_MAX);
    d.primaryImageRef = filename;
    d.render = { ...(d.render || {}), jobId, status: 'completed', error: null, filename, updatedAt: new Date().toISOString() };
  }, { missingOk: true });
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
