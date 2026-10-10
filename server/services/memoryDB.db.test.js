/**
 * Postgres-backed tests for the PRODUCTION memory backend (#3447).
 *
 * `memoryDB.js` is what `memoryBackend.js` selects for every real install; its
 * file-backed sibling `memory.js` (covered by `memory.test.js`) is a dev/test
 * escape hatch only. Until this suite existed, the only "memory" coverage was
 * for the path nobody actually runs.
 *
 * Covered here: createMemory/peek/get CRUD round-trip (including the pgvector
 * embedding round-trip and the dimension-mismatch guard), the filter/pagination
 * surface, searchMemories + hybridSearchMemories (vector, FTS and fused paths,
 * plus zero-result queries), consolidateMemories merge semantics, applyDecay
 * boundary behavior, and getGraphData's node/edge shape.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`, never
 * the real `portos` DB (the db.js runner guard + the suite skip below enforce
 * this).
 *
 * Unlike most `*.db.test.js` suites — which keep assertions relative because the
 * DB is shared — several functions under test are inherently TABLE-GLOBAL
 * (`consolidateMemories`, `applyDecay`, `getGraphData` and `getStats` all scan
 * every row). There is no per-row scoping to assert against, so each block
 * clears `memories` and seeds its own fixtures. `vitest.config.db.js` sets
 * `fileParallelism: false`, so no other suite is running while this one owns the
 * table, and the run targets a throwaway database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import pg from 'pg';
import { checkHealth, ensureSchema, close, query, withTransaction } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { mockNoPeers, mockTestIdentity, mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { DEFAULT_MEMORY_CONFIG } from './memoryConfig.js';

// Keep every filesystem side effect this module graph can reach (notifications
// pruning on approve/reject, the instance registry) inside a temp dir.
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-memorydb-' });
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// createMemory stamps origin_instance_id from the federation identity. Pin it so
// the provenance assertion doesn't depend on whether this checkout has ever
// booted (a fresh worktree has no instance file and would get the 'unknown'
// sentinel).
const TEST_INSTANCE_ID = '00000000-0000-4000-8000-0000000c0ffe';
vi.mock('./instances.js', async (importOriginal) => mockNoPeers(await importOriginal()));
vi.mock('./instanceIdentity.js', () =>
  mockTestIdentity({ getInstanceId: () => Promise.resolve(TEST_INSTANCE_ID) }));

const memoryDB = await import('./memoryDB.js');

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const recheck = await checkHealth().catch(() => ({ hasSchema: false }));
    if (recheck.hasSchema) dbReady = true;
    else skipReason = 'memory schema not present';
  }
}
const runDb = requireDbOrSkip('services/memoryDB.db.test', dbReady, skipReason);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DIM = DEFAULT_MEMORY_CONFIG.embeddingDimension;

/** Unit vector along one axis — two different axes are exactly orthogonal (cosine similarity 0). */
const axis = (i) => {
  const v = new Array(DIM).fill(0);
  v[i] = 1;
  return v;
};

/** `axis(i)` nudged toward axis `j`; cosine similarity to `axis(i)` is 1/sqrt(1 + tilt²). */
const tilted = (i, j, tilt) => {
  const v = axis(i);
  v[j] = tilt;
  return v;
};

const VEC_A = axis(0);
const VEC_NEAR_A = tilted(0, 1, 0.1); // ≈ 0.995 similar to VEC_A
const VEC_FAR = axis(300);            // orthogonal to VEC_A / VEC_NEAR_A
const VEC_UNSEEN = axis(500);         // orthogonal to every seeded embedding
const VEC_HALFWAY = tilted(0, 1, 2);  // ≈ 0.447 to VEC_A, ≈ 0.534 to VEC_NEAR_A

const resetMemories = () => query('DELETE FROM memories');

const backdate = (id, days) => query(
  `UPDATE memories SET created_at = NOW() - ($1::double precision * INTERVAL '1 day'), last_accessed = NULL WHERE id = $2`,
  [days, id],
);

const statusOf = async (id) => (await memoryDB.peekMemory(id))?.status ?? null;
const importanceOf = async (id) => (await memoryDB.peekMemory(id))?.importance ?? null;

afterAll(async () => {
  if (dbReady) {
    await resetMemories().catch(() => {});
    await close();
  }
  cleanup();
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe.skipIf(!runDb)('memoryDB CRUD (#3447)', () => {
  beforeAll(async () => {
    if (!dbReady) return;
    await resetMemories();
  });

  it('round-trips a memory through create → peek, including the pgvector embedding', async () => {
    const created = await memoryDB.createMemory({
      type: 'fact',
      content: 'Quasar catalogue entries index distant luminous objects.',
      category: 'science',
      tags: ['astronomy', 'reference'],
      confidence: 0.9,
      importance: 0.7,
      sourceTaskId: 'task-1',
      sourceAgentId: 'agent-1',
      sourceAppId: 'brain',
    }, VEC_A);

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.type).toBe('fact');
    expect(created.category).toBe('science');
    expect(created.tags).toEqual(['astronomy', 'reference']);
    expect(created.confidence).toBeCloseTo(0.9, 6);
    expect(created.importance).toBeCloseTo(0.7, 6);
    expect(created.status).toBe('active');
    expect(created.accessCount).toBe(0);
    expect(created.embeddingModel).toBe(DEFAULT_MEMORY_CONFIG.embeddingModel);
    // Federation provenance is stamped at insert time.
    expect(created.originInstanceId).toBe(TEST_INSTANCE_ID);

    // The embedding survives the pgvector column, not just the in-memory echo
    // createMemory attaches to its return value.
    const fetched = await memoryDB.peekMemory(created.id);
    expect(fetched.embedding).toHaveLength(DIM);
    expect(fetched.embedding[0]).toBeCloseTo(1, 6);
    expect(fetched.embedding[1]).toBeCloseTo(0, 6);
    expect(fetched.sourceTaskId).toBe('task-1');
    expect(fetched.sourceAgentId).toBe('agent-1');
    expect(fetched.sourceAppId).toBe('brain');
    // peek is a pure read — it must not bump access stats.
    expect(fetched.accessCount).toBe(0);
    expect(fetched.lastAccessed).toBeNull();
  });

  it('generates a truncated summary when none is supplied, and honors an explicit one', async () => {
    const long = 'x'.repeat(400);
    const auto = await memoryDB.createMemory({ type: 'fact', content: long });
    expect(auto.summary).toHaveLength(150);
    expect(auto.summary.endsWith('...')).toBe(true);

    const explicit = await memoryDB.createMemory({ type: 'fact', content: long, summary: 'Hand written' });
    expect(explicit.summary).toBe('Hand written');
  });

  it('stores NULL instead of throwing when the embedding dimension does not match the column', async () => {
    // A user-configured embedding model with the wrong dimension must not abort
    // the insert (which would break a whole bridge resync) — the record lands
    // un-embedded and shows up in the "embed missing" backfill set.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const created = await memoryDB.createMemory({ type: 'fact', content: 'Wrong-dimension embedding.' }, [0.1, 0.2, 0.3]);
    warn.mockRestore();

    expect(created.embedding).toBeNull();
    expect(created.embeddingModel).toBeNull();

    const missing = await memoryDB.getMemoryIdsMissingEmbedding();
    expect(missing).toBeInstanceOf(Set);
    expect(missing.has(created.id)).toBe(true);
  });

  it('backfills an embedding onto an existing memory, and applies the same dimension guard', async () => {
    const mem = await memoryDB.createMemory({ type: 'fact', content: 'Awaiting an embedding.' });
    expect((await memoryDB.getMemoryIdsMissingEmbedding()).has(mem.id)).toBe(true);

    const embedded = await memoryDB.updateMemoryEmbedding(mem.id, VEC_A);
    expect(embedded.embedding).toHaveLength(DIM);
    expect(embedded.embeddingModel).toBe(DEFAULT_MEMORY_CONFIG.embeddingModel);
    expect((await memoryDB.getMemoryIdsMissingEmbedding()).has(mem.id)).toBe(false);

    // A wrong-dimension re-embed clears the column rather than throwing — the
    // record goes back to being a backfill candidate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cleared = await memoryDB.updateMemoryEmbedding(mem.id, [0.1, 0.2, 0.3]);
    warn.mockRestore();
    expect(cleared.embedding).toBeNull();
    expect(cleared.embeddingModel).toBeNull();
    expect((await memoryDB.getMemoryIdsMissingEmbedding()).has(mem.id)).toBe(true);

    expect(await memoryDB.updateMemoryEmbedding('00000000-0000-4000-8000-00000000dead', VEC_A)).toBeNull();
  });

  it('getMemory bumps access stats and resolves linked memories', async () => {
    const target = await memoryDB.createMemory({ type: 'fact', content: 'Link target.' });
    const source = await memoryDB.createMemory({
      type: 'fact',
      content: 'Link source.',
      relatedMemories: [target.id],
    });
    expect(source.relatedMemories).toEqual([target.id]);

    const read = await memoryDB.getMemory(source.id);
    expect(read.accessCount).toBe(1);
    expect(read.lastAccessed).not.toBeNull();
    expect(read.relatedMemories).toEqual([target.id]);

    // The bump is persisted, not just reported.
    const again = await memoryDB.peekMemory(source.id);
    expect(again.accessCount).toBe(1);

    expect(await memoryDB.getMemory('00000000-0000-4000-8000-00000000dead')).toBeNull();
  });

  it('regenerates the summary when content changes without an explicit summary', async () => {
    const mem = await memoryDB.createMemory({ type: 'fact', content: 'Original content.', summary: 'Original summary' });

    const contentOnly = await memoryDB.updateMemory(mem.id, { content: 'Replacement content.' });
    expect(contentOnly.content).toBe('Replacement content.');
    expect(contentOnly.summary).toBe('Replacement content.');

    const bothFields = await memoryDB.updateMemory(mem.id, { content: 'Third content.', summary: 'Pinned summary' });
    expect(bothFields.summary).toBe('Pinned summary');

    expect(await memoryDB.updateMemory('00000000-0000-4000-8000-00000000dead', { content: 'nope' })).toBeNull();
  });

  it('replaces the link set on a relatedMemories update', async () => {
    const [a, b, c] = await Promise.all([
      memoryDB.createMemory({ type: 'fact', content: 'Link A.' }),
      memoryDB.createMemory({ type: 'fact', content: 'Link B.' }),
      memoryDB.createMemory({ type: 'fact', content: 'Link C.' }),
    ]);

    await memoryDB.updateMemory(a.id, { relatedMemories: [b.id, c.id] });
    expect((await memoryDB.getMemory(a.id)).relatedMemories.sort()).toEqual([b.id, c.id].sort());

    // A replacement drops the links that are no longer listed.
    await memoryDB.updateMemory(a.id, { relatedMemories: [c.id] });
    expect((await memoryDB.getMemory(a.id)).relatedMemories).toEqual([c.id]);

    await memoryDB.updateMemory(a.id, { relatedMemories: [] });
    expect((await memoryDB.getMemory(a.id)).relatedMemories).toEqual([]);
  });

  it('links two memories bidirectionally and refuses an unknown id', async () => {
    const [a, b] = await Promise.all([
      memoryDB.createMemory({ type: 'fact', content: 'Bidirectional A.' }),
      memoryDB.createMemory({ type: 'fact', content: 'Bidirectional B.' }),
    ]);

    expect(await memoryDB.linkMemories(a.id, b.id)).toEqual({
      success: true, sourceId: a.id, targetId: b.id, linkType: 'related', linkId: expect.any(String)
    });
    expect((await memoryDB.getMemory(a.id)).relatedMemories).toEqual([b.id]);
    expect((await memoryDB.getMemory(b.id)).relatedMemories).toEqual([a.id]);

    const missing = await memoryDB.linkMemories(a.id, '00000000-0000-4000-8000-00000000dead');
    expect(missing).toEqual({ success: false, error: 'Memory not found' });
  });

  it('stores a directed typed link as one row, reads it back with its type from both ends, and keeps untyped links symmetric', async () => {
    const [older, newer] = await Promise.all([
      memoryDB.createMemory({ type: 'decision', content: 'Typed link older decision.' }),
      memoryDB.createMemory({ type: 'decision', content: 'Typed link newer decision.' }),
    ]);

    const typed = await memoryDB.linkMemories(newer.id, older.id, { linkType: 'supersedes', note: 'replaces it', createdBy: 'task-1' });
    expect(typed).toMatchObject({ success: true, linkType: 'supersedes', linkId: expect.any(String) });
    // Directed: exactly one row, no reverse.
    const rows = await query('SELECT source_id, target_id, link_type FROM memory_links WHERE source_id = ANY($1)', [[older.id, newer.id]]);
    expect(rows.rows).toEqual([{ source_id: newer.id, target_id: older.id, link_type: 'supersedes' }]);

    const fromNewer = (await memoryDB.getRelatedMemories(newer.id)).find((r) => r.id === older.id);
    expect(fromNewer).toMatchObject({ linkType: 'supersedes', direction: 'outgoing', note: 'replaces it', createdBy: 'task-1', linkId: typed.linkId });
    const fromOlder = (await memoryDB.getRelatedMemories(older.id)).find((r) => r.id === newer.id);
    expect(fromOlder).toMatchObject({ linkType: 'supersedes', direction: 'incoming' });

    // The same pair may carry a second, different relationship; the legacy call is still a symmetric pair.
    await memoryDB.linkMemories(newer.id, older.id);
    const pair = await query('SELECT source_id, link_type FROM memory_links WHERE source_id = ANY($1) ORDER BY link_type, source_id', [[older.id, newer.id]]);
    expect(pair.rows.filter((r) => r.link_type === 'related')).toHaveLength(2);
    expect(pair.rows.filter((r) => r.link_type === 'supersedes')).toHaveLength(1);

    const graph = await memoryDB.getGraphData();
    const edges = graph.edges.filter((e) => [e.source, e.target].includes(older.id) && [e.source, e.target].includes(newer.id) && e.type === 'linked');
    expect(edges.map((e) => e.linkType).sort()).toEqual(['related', 'supersedes']);
    expect(edges.find((e) => e.linkType === 'supersedes')).toMatchObject({ source: newer.id, target: older.id });
  });

  it('archives and purges', async () => {
    const soft = await memoryDB.createMemory({ type: 'fact', content: 'Soft delete me.' });
    await memoryDB.archiveMemory(soft.id);
    expect(await statusOf(soft.id)).toBe('archived');

    const hard = await memoryDB.createMemory({ type: 'fact', content: 'Hard delete me.' });
    await memoryDB.purgeMemory(hard.id);
    expect(await memoryDB.peekMemory(hard.id)).toBeNull();
  });

  it('approves and rejects pending memories, and rejects the transition from any other status', async () => {
    const pending = await memoryDB.createMemory({ type: 'fact', content: 'Awaiting review.', status: 'pending_approval' });
    const approved = await memoryDB.approveMemory(pending.id);
    expect(approved.success).toBe(true);
    expect(approved.memory.status).toBe('active');
    expect(await statusOf(pending.id)).toBe('active');

    // Already active — not a pending record anymore.
    expect(await memoryDB.approveMemory(pending.id)).toEqual({ success: false, error: 'Memory is not pending approval' });

    const doomed = await memoryDB.createMemory({ type: 'fact', content: 'Reject me.', status: 'pending_approval' });
    expect(await memoryDB.rejectMemory(doomed.id)).toEqual({ success: true, id: doomed.id });
    // Rejection preserves the record and reason for inspection.
    expect(await memoryDB.peekMemory(doomed.id)).toMatchObject({ status: 'archived', archiveReason: 'Rejected' });

    expect(await memoryDB.approveMemory('00000000-0000-4000-8000-00000000dead')).toEqual({ success: false, error: 'Memory not found' });
    expect(await memoryDB.rejectMemory('00000000-0000-4000-8000-00000000dead')).toEqual({ success: false, error: 'Memory not found' });
  });
});

// ---------------------------------------------------------------------------
// Listing / filtering
// ---------------------------------------------------------------------------

describe.skipIf(!runDb)('memoryDB listing filters (#3447)', () => {
  let brainFact;
  let studioPreference;
  let archivedFact;

  beforeAll(async () => {
    if (!dbReady) return;
    await resetMemories();
    brainFact = await memoryDB.createMemory({
      type: 'fact', content: 'Brain fact.', category: 'science',
      tags: ['astronomy'], importance: 0.9, sourceAgentId: 'persistent-mind', sourceAppId: 'brain',
    });
    studioPreference = await memoryDB.createMemory({
      type: 'preference', content: 'Studio preference.', category: 'style',
      tags: ['art'], importance: 0.4, sourceAppId: 'studio',
    });
    archivedFact = await memoryDB.createMemory({
      type: 'fact', content: 'Archived fact.', category: 'science', status: 'archived',
    });
  });

  it('defaults to active-only and returns lightweight metadata rows', async () => {
    const { total, memories } = await memoryDB.getMemories();
    expect(total).toBe(2);
    expect(memories.map((m) => m.id).sort()).toEqual([brainFact.id, studioPreference.id].sort());
    // rowToMeta is deliberately narrow — no content/embedding on list rows.
    expect(Object.keys(memories[0]).sort()).toEqual(
      ['category', 'createdAt', 'id', 'importance', 'sourceAgentId', 'sourceAppId', 'status', 'summary', 'tags', 'type'],
    );
  });

  it('filters by status, type, category, tags and app', async () => {
    expect((await memoryDB.getMemories({ status: 'archived' })).memories.map((m) => m.id)).toEqual([archivedFact.id]);
    expect((await memoryDB.getMemories({ types: ['preference'] })).memories.map((m) => m.id)).toEqual([studioPreference.id]);
    expect((await memoryDB.getMemories({ categories: ['science'] })).memories.map((m) => m.id)).toEqual([brainFact.id]);
    expect((await memoryDB.getMemories({ tags: ['art'] })).memories.map((m) => m.id)).toEqual([studioPreference.id]);
    expect((await memoryDB.getMemories({ appId: 'brain' })).memories.map((m) => m.id)).toEqual([brainFact.id]);
    expect((await memoryDB.getMemories({ appId: '__not_brain' })).memories.map((m) => m.id)).toEqual([studioPreference.id]);
    expect((await memoryDB.getMemories({ sourceAgentId: 'persistent-mind' })).memories.map((m) => m.id)).toEqual([brainFact.id]);
  });

  it('sorts and paginates while reporting the unpaginated total', async () => {
    const page = await memoryDB.getMemories({ sortBy: 'importance', sortOrder: 'desc', limit: 1 });
    expect(page.total).toBe(2);
    expect(page.memories).toHaveLength(1);
    expect(page.memories[0].id).toBe(brainFact.id);

    const next = await memoryDB.getMemories({ sortBy: 'importance', sortOrder: 'desc', limit: 1, offset: 1 });
    expect(next.memories[0].id).toBe(studioPreference.id);
  });

  it('countMemories applies the same filters without fetching rows', async () => {
    expect(await memoryDB.countMemories()).toBe(2);
    expect(await memoryDB.countMemories({ types: ['fact'] })).toBe(1);
    expect(await memoryDB.countMemories({ status: 'archived' })).toBe(1);
  });

  it('reports aggregate stats, categories, tags and the timeline', async () => {
    const stats = await memoryDB.getStats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.archived).toBe(1);
    expect(stats.byType).toEqual({ fact: 2, preference: 1 });
    expect(stats.byCategory).toEqual({ science: 2, style: 1 });

    expect(await memoryDB.getCategories()).toEqual(
      expect.arrayContaining([{ name: 'science', count: 1 }, { name: 'style', count: 1 }]),
    );
    expect(await memoryDB.getTags()).toEqual(
      expect.arrayContaining([{ name: 'astronomy', count: 1 }, { name: 'art', count: 1 }]),
    );

    const timeline = await memoryDB.getTimeline();
    const day = new Date().toISOString().split('T')[0];
    expect(timeline[day].map((m) => m.id).sort()).toEqual([brainFact.id, studioPreference.id].sort());

    expect(await memoryDB.rebuildBM25Index()).toEqual({ rebuilt: true, documents: 2 });
    expect(await memoryDB.getBM25Stats()).toEqual({ documentCount: 2, backend: 'postgresql-tsvector' });
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe.skipIf(!runDb)('memoryDB search (#3447)', () => {
  let quasar;      // VEC_A,      app 'brain'
  let zebrafish;   // VEC_NEAR_A, app 'studio'
  let pantry;      // VEC_FAR,    no app

  beforeAll(async () => {
    if (!dbReady) return;
    await resetMemories();
    quasar = await memoryDB.createMemory({
      type: 'fact', content: 'Quasar catalogue entries index distant luminous objects.',
      category: 'science', tags: ['astronomy'], importance: 0.8, sourceAppId: 'brain',
    }, VEC_A);
    zebrafish = await memoryDB.createMemory({
      type: 'preference', content: 'Zebrafish imagery is preferred for generated cover art.',
      category: 'style', tags: ['art'], importance: 0.6, sourceAppId: 'studio',
    }, VEC_NEAR_A);
    pantry = await memoryDB.createMemory({
      type: 'fact', content: 'Kitchen inventory notes for pantry restocking.',
      category: 'other', tags: ['home'], importance: 0.4,
    }, VEC_FAR);
    // Embedded but archived — must never surface in either search path.
    await memoryDB.createMemory({
      type: 'fact', content: 'Archived quasar duplicate.', status: 'archived',
    }, VEC_A);
  });

  it('ranks by pgvector cosine similarity above the relevance floor', async () => {
    const { total, memories } = await memoryDB.searchMemories(VEC_A);
    expect(total).toBe(2);
    expect(memories.map((m) => m.id)).toEqual([quasar.id, zebrafish.id]);
    expect(memories[0].similarity).toBeCloseTo(1, 5);
    expect(memories[1].similarity).toBeCloseTo(0.995, 3);
    // The orthogonal record is below the 0.7 default floor, and the archived one
    // is excluded by status regardless of its (identical) embedding.
    expect(memories.some((m) => m.id === pantry.id)).toBe(false);
  });

  it('applies type / tag / app filters on top of the vector floor', async () => {
    expect((await memoryDB.searchMemories(VEC_A, { types: ['preference'] })).memories.map((m) => m.id)).toEqual([zebrafish.id]);
    expect((await memoryDB.searchMemories(VEC_A, { categories: ['science'] })).memories.map((m) => m.id)).toEqual([quasar.id]);
    expect((await memoryDB.searchMemories(VEC_A, { tags: ['art'] })).memories.map((m) => m.id)).toEqual([zebrafish.id]);
    expect((await memoryDB.searchMemories(VEC_A, { appId: 'brain' })).memories.map((m) => m.id)).toEqual([quasar.id]);
    expect((await memoryDB.searchMemories(VEC_A, { appId: '__not_brain' })).memories.map((m) => m.id)).toEqual([zebrafish.id]);
    expect((await memoryDB.searchMemories(VEC_A, { limit: 1 })).memories).toHaveLength(1);
  });

  it('distinguishes a searched-and-empty result from a search that never ran', async () => {
    // "Never ran": no query embedding, so the function short-circuits before it
    // touches Postgres. The caller learns nothing about the corpus.
    const notFetched = await memoryDB.searchMemories(null);
    expect(notFetched).toEqual({ total: 0, memories: [] });

    // "Ran and matched nothing": VEC_HALFWAY sits at ~0.45/~0.53 similarity to
    // the two embedded actives — a real query, every candidate rejected by the
    // 0.7 floor. The result is an empty result SET (an array), not a nullish
    // "unknown", so a caller can cache it as a known-empty answer.
    const searchedEmpty = await memoryDB.searchMemories(VEC_HALFWAY);
    expect(searchedEmpty.memories).toBeInstanceOf(Array);
    expect(searchedEmpty).toEqual({ total: 0, memories: [] });

    // Control proving the empty above was the floor rejecting real candidates
    // rather than an unreachable index: same query, lower floor, rows come back.
    const lowered = await memoryDB.searchMemories(VEC_HALFWAY, { minRelevance: 0.4 });
    expect(lowered.memories.map((m) => m.id)).toEqual([zebrafish.id, quasar.id]);
  });

  it('fuses full-text and vector rankings, labelling each result with its method', async () => {
    const { total, memories } = await memoryDB.hybridSearchMemories('quasar', VEC_A);
    expect(total).toBe(2);

    const byId = Object.fromEntries(memories.map((m) => [m.id, m]));
    expect(byId[quasar.id].searchMethod).toBe('hybrid');
    expect(byId[quasar.id].ftsRank).toBe(1);
    expect(byId[quasar.id].vectorRank).toBe(1);
    expect(byId[zebrafish.id].searchMethod).toBe('vector');
    expect(byId[zebrafish.id].ftsRank).toBeNull();
    expect(byId[zebrafish.id].vectorRank).toBe(2);

    // RRF puts the doubly-ranked record first.
    expect(memories[0].id).toBe(quasar.id);
    expect(memories[0].rrfScore).toBeGreaterThan(memories[1].rrfScore);
  });

  it('degrades to a single ranker when only text or only an embedding is available', async () => {
    const textOnly = await memoryDB.hybridSearchMemories('zebrafish', null);
    expect(textOnly.memories.map((m) => m.id)).toEqual([zebrafish.id]);
    expect(textOnly.memories[0].searchMethod).toBe('fts');
    expect(textOnly.memories[0].vectorRank).toBeNull();

    const vectorOnly = await memoryDB.hybridSearchMemories(null, VEC_A);
    expect(vectorOnly.memories.map((m) => m.id).sort()).toEqual([quasar.id, zebrafish.id].sort());
    expect(vectorOnly.memories.every((m) => m.searchMethod === 'vector')).toBe(true);

    // App filters apply to both rankers.
    const scoped = await memoryDB.hybridSearchMemories('quasar', VEC_A, { appId: '__not_brain' });
    expect(scoped.memories.map((m) => m.id)).toEqual([zebrafish.id]);
  });

  it('distinguishes a hybrid search with nothing to search on from one that matched nothing', async () => {
    // Neither ranker has an input — no query is issued at all.
    expect(await memoryDB.hybridSearchMemories(null, null)).toEqual({ total: 0, memories: [] });

    // Both rankers ran against the corpus and agreed on nothing: an unseen word
    // and an embedding orthogonal to every stored vector.
    const searchedEmpty = await memoryDB.hybridSearchMemories('xylophonic', VEC_UNSEEN);
    expect(searchedEmpty.memories).toBeInstanceOf(Array);
    expect(searchedEmpty).toEqual({ total: 0, memories: [] });

    // Control: the same corpus does answer a term it actually contains.
    expect((await memoryDB.hybridSearchMemories('pantry', VEC_UNSEEN)).memories.map((m) => m.id)).toEqual([pantry.id]);
  });

  it('surfaces explicit links first, then embedding neighbours, for a single memory', async () => {
    await memoryDB.linkMemories(quasar.id, pantry.id);
    const related = await memoryDB.getRelatedMemories(quasar.id);

    const linked = related.find((r) => r.id === pantry.id);
    expect(linked.relationship).toBe('linked');
    expect(linked.similarity).toBe(1.0);

    const similar = related.find((r) => r.id === zebrafish.id);
    expect(similar.relationship).toBe('similar');
    expect(similar.similarity).toBeCloseTo(0.995, 3);

    // A record that isn't in the table has no relations (and doesn't throw).
    expect(await memoryDB.getRelatedMemories('00000000-0000-4000-8000-00000000dead')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

describe.skipIf(!runDb)('memoryDB consolidateMemories (#3447)', () => {
  let keeper;   // importance 0.9, VEC_A
  let duplicate; // importance 0.3, VEC_NEAR_A (≈0.995 similar to keeper)
  let lone;      // importance 0.5, orthogonal

  beforeAll(async () => {
    if (!dbReady) return;
    await resetMemories();
    keeper = await memoryDB.createMemory({ type: 'fact', content: 'Canonical statement.', importance: 0.9 }, VEC_A);
    duplicate = await memoryDB.createMemory({ type: 'fact', content: 'Canonical statement, restated.', importance: 0.3 }, VEC_NEAR_A);
    lone = await memoryDB.createMemory({ type: 'fact', content: 'Nothing like the others.', importance: 0.5 }, VEC_FAR);
  });

  it('reports clusters without mutating anything on a dry run', async () => {
    const report = await memoryDB.consolidateMemories(0.9, true);
    expect(report.dryRun).toBe(true);
    expect(report.clustersFound).toBe(1);
    expect(report.memoriesAffected).toBe(2);
    expect(report.clusters[0].map((c) => c.id).sort()).toEqual([keeper.id, duplicate.id].sort());
    expect(report.clusters[0].every((c) => typeof c.summary === 'string')).toBe(true);

    // Dry run must leave every record active.
    expect(await statusOf(keeper.id)).toBe('active');
    expect(await statusOf(duplicate.id)).toBe('active');
  });

  it('finds nothing when the threshold is above the pair similarity', async () => {
    // The pair sits at ≈0.995; 0.999 excludes it.
    expect(await memoryDB.consolidateMemories(0.999, true)).toMatchObject({ clustersFound: 0, memoriesAffected: 0 });
    expect(await memoryDB.consolidateMemories(0.999)).toEqual({ merged: 0, clusters: 0 });
  });

  it('archives every cluster member except the highest-importance one', async () => {
    expect(await memoryDB.consolidateMemories(0.9)).toEqual({ merged: 1, clusters: 1 });

    expect(await statusOf(keeper.id)).toBe('active');
    expect(await statusOf(duplicate.id)).toBe('archived');
    expect((await memoryDB.getMemory(duplicate.id)).supersededBy).toEqual([keeper.id]);
    expect((await memoryDB.peekMemory(duplicate.id)).archiveReason).toBe('Consolidated duplicate');
    const links = await query("SELECT source_id, target_id FROM memory_links WHERE link_type = 'supersedes'");
    expect(links.rows).toEqual([{ source_id: keeper.id, target_id: duplicate.id }]);

    // A memory with no near neighbour is never part of a cluster.
    expect(await statusOf(lone.id)).toBe('active');

    // Idempotent: the survivor no longer has an active duplicate to merge with.
    expect(await memoryDB.consolidateMemories(0.9)).toEqual({ merged: 0, clusters: 0 });
  });
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

describe.skipIf(!runDb)('memoryDB applyDecay boundaries (#3447)', () => {
  it('keeps protected identity and important records through consolidation, decay, and expiration', async () => {
    await resetMemories();
    const input = { type: 'fact', content: 'Stable identity.', importance: 0.1, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const core = await memoryDB.createMemory({ ...input, tags: ['mind:core-identity'] }, axis(0));
    const important = await memoryDB.createMemory({ ...input, tags: ['mind:important'] }, axis(0));
    const ordinary = await memoryDB.createMemory({ ...input, tags: [] }, axis(0));
    for (const memory of [core, important, ordinary]) await backdate(memory.id, 400);
    await memoryDB.consolidateMemories(0.9);
    await memoryDB.applyDecay(0.01);
    await memoryDB.clearExpired();
    expect(await statusOf(core.id)).toBe('active');
    expect(await statusOf(important.id)).toBe('active');
    expect(await statusOf(ordinary.id)).not.toBe('active');
    expect((await memoryDB.peekMemory(core.id)).tags).toEqual(['mind:core-identity']);
  });

  it('is a no-op at decayRate 0 for memories past the recency-bonus window', async () => {
    await resetMemories();
    // The recency bonus is GREATEST(0, 0.1 - daysSinceAccess * 0.001) — zero once
    // a memory is 100+ days untouched. With decayRate 0 the age term drops out
    // too, so the computed importance equals the stored one and NOTHING is
    // written: the "change exceeds 0.01" guard is the only thing that can fire.
    const a = await memoryDB.createMemory({ type: 'fact', content: 'Old but important.', importance: 0.5 });
    const b = await memoryDB.createMemory({ type: 'fact', content: 'Old and middling.', importance: 0.3 });
    await backdate(a.id, 400);
    await backdate(b.id, 400);

    expect(await memoryDB.applyDecay(0)).toEqual({ updated: 0 });
    expect(await importanceOf(a.id)).toBeCloseTo(0.5, 6);
    expect(await importanceOf(b.id)).toBeCloseTo(0.3, 6);
    expect(await statusOf(a.id)).toBe('active');
  });

  it('archives only decayed-below-0.15 memories older than 30 days, and floors importance at 0.1', async () => {
    await resetMemories();
    // 400 days at rate 0.01 → 0.15 * (1 - 0.01*sqrt(400)) = 0.12 → below the
    // 0.15 archive cut-off and past the 30-day gate.
    const oldLow = await memoryDB.createMemory({ type: 'fact', content: 'Old and faded.', importance: 0.15 });
    // 3000 days would compute 0.11 * 0.4523 ≈ 0.0498 — the GREATEST(0.1, …)
    // floor clamps it to exactly 0.1.
    const ancient = await memoryDB.createMemory({ type: 'fact', content: 'Ancient and faded.', importance: 0.11 });
    // 20 days: its computed importance (≈0.128) is under the archive cut-off,
    // but the 30-day gate keeps it active. This is the boundary that stops decay
    // from evicting brand-new low-importance memories.
    const youngLow = await memoryDB.createMemory({ type: 'fact', content: 'New and unimportant.', importance: 0.05 });
    // Already archived — decay only ever touches active rows.
    const alreadyArchived = await memoryDB.createMemory({ type: 'fact', content: 'Out of scope.', importance: 0.9, status: 'archived' });

    await backdate(oldLow.id, 400);
    await backdate(ancient.id, 3000);
    await backdate(youngLow.id, 20);
    await backdate(alreadyArchived.id, 400);

    // 2 archived + 1 decayed-in-place.
    expect(await memoryDB.applyDecay(0.01)).toEqual({ updated: 3 });

    expect(await statusOf(oldLow.id)).toBe('archived');
    expect(await importanceOf(oldLow.id)).toBeCloseTo(0.12, 4);

    expect(await statusOf(ancient.id)).toBe('archived');
    expect(await importanceOf(ancient.id)).toBeCloseTo(0.1, 6);

    expect(await statusOf(youngLow.id)).toBe('active');
    expect(await importanceOf(youngLow.id)).toBeCloseTo(0.12776, 3);

    expect(await statusOf(alreadyArchived.id)).toBe('archived');
    expect(await importanceOf(alreadyArchived.id)).toBeCloseTo(0.9, 6);
  });

  it('expires memories whose expiresAt has passed, leaving future and unset ones alone', async () => {
    await resetMemories();
    const past = await memoryDB.createMemory({
      type: 'fact', content: 'Short lived.', expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const future = await memoryDB.createMemory({
      type: 'fact', content: 'Still valid.', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const never = await memoryDB.createMemory({ type: 'fact', content: 'No expiry.' });

    expect(await memoryDB.clearExpired()).toEqual({ cleared: 1 });
    expect(await statusOf(past.id)).toBe('expired');
    expect(await statusOf(future.id)).toBe('active');
    expect(await statusOf(never.id)).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

describe.skipIf(!runDb)('memoryDB getGraphData (#3447)', () => {
  let hub;      // VEC_A
  let spoke;    // VEC_FAR, explicitly linked to hub
  let neighbour; // VEC_NEAR_A, similar to hub by embedding only

  beforeAll(async () => {
    if (!dbReady) return;
    await resetMemories();
    hub = await memoryDB.createMemory({ type: 'fact', content: 'Hub note.', category: 'science', importance: 0.8 }, VEC_A);
    spoke = await memoryDB.createMemory({ type: 'task', content: 'Spoke note.', category: 'work', importance: 0.5 }, VEC_FAR);
    neighbour = await memoryDB.createMemory({ type: 'fact', content: 'Neighbour note.', category: 'science', importance: 0.6 }, VEC_NEAR_A);
    await memoryDB.createMemory({ type: 'fact', content: 'Archived note.', status: 'archived' }, VEC_A);
    await memoryDB.linkMemories(hub.id, spoke.id);
  });

  it('returns active nodes with a fixed shape and excludes archived records', async () => {
    const { nodes } = await memoryDB.getGraphData();
    expect(nodes.map((n) => n.id).sort()).toEqual([hub.id, spoke.id, neighbour.id].sort());
    expect(Object.keys(nodes[0]).sort()).toEqual(['category', 'id', 'importance', 'summary', 'type']);

    const hubNode = nodes.find((n) => n.id === hub.id);
    expect(hubNode).toEqual({ id: hub.id, type: 'fact', category: 'science', summary: 'Hub note.', importance: 0.8 });
  });

  it('emits one edge per pair — a bidirectional link collapses, and similarity edges do not duplicate it', async () => {
    const { edges } = await memoryDB.getGraphData();
    expect(edges).toHaveLength(2);

    const key = (e) => [e.source, e.target].sort().join('-');
    const byPair = Object.fromEntries(edges.map((e) => [key(e), e]));

    const linked = byPair[[hub.id, spoke.id].sort().join('-')];
    expect(linked.type).toBe('linked');
    expect(linked.weight).toBe(1.0);

    // hub↔neighbour is ≈0.995 similar — above the 0.8 similarity-edge cut-off.
    const similar = byPair[[hub.id, neighbour.id].sort().join('-')];
    expect(similar.type).toBe('similar');
    expect(similar.weight).toBeCloseTo(0.995, 3);

    // spoke is orthogonal to both, so it gets no similarity edge on top of its
    // explicit link.
    expect(byPair[[spoke.id, neighbour.id].sort().join('-')]).toBeUndefined();
  });
});

// Observe real graph statements on their pool connection; do not replace SQL
// results. This also checks settings immediately after COMMIT/ROLLBACK, before
// that same connection is released.
function observeGraph({ afterNodes, failSimilarity = false, explain = false } = {}) {
  const original = pg.Client.prototype.query;
  const observation = { statements: [], settings: null, restored: null, directed: [], plan: null };
  let graphClient;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (...args) {
    const sql = args[0];
    if (typeof sql === 'string' && sql.startsWith('SET TRANSACTION ISOLATION LEVEL')) graphClient = this;
    if (this !== graphClient || typeof sql !== 'string') return original.apply(this, args);
    observation.statements.push(sql);
    return (async () => {
      if (sql.includes('CROSS JOIN LATERAL')) {
        observation.settings = (await original.call(this, `SELECT
          current_setting('work_mem') AS work_mem,
          current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS read_only`)).rows[0];
        if (failSimilarity) await original.call(this, 'SELECT 1 / 0');
        // The real statement and parameters, planned inside the same snapshot.
        if (explain) observation.plan = (await original.call(this, 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, args[1])).rows[0]['QUERY PLAN'][0].Plan;
      }
      const result = await original.apply(this, args);
      if (sql.includes('SELECT id, type, category, summary, importance')) await afterNodes?.();
      if (sql.includes('CROSS JOIN LATERAL')) observation.directed = result.rows;
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        observation.restored = (await original.call(this, `SELECT
          current_setting('work_mem') AS work_mem,
          current_setting('transaction_isolation') AS isolation,
          current_setting('transaction_read_only') AS read_only`)).rows[0];
      }
      return result;
    })();
  });
  return { observation, restore: () => spy.mockRestore() };
}

// The pre-optimization query is the compatibility oracle, including its
// intentionally unspecified choice among equal-distance cutoff candidates.
const legacyGraphSimilarity = `
  SELECT a.id AS source_id, b.id AS target_id,
         1 - (a.embedding <=> b.embedding) AS similarity
  FROM memories a
  CROSS JOIN LATERAL (
    SELECT id, embedding FROM memories
    WHERE id != a.id AND embedding IS NOT NULL AND status = 'active'
    ORDER BY embedding <=> a.embedding LIMIT 3
  ) b
  WHERE a.embedding IS NOT NULL AND a.status = 'active'
    AND 1 - (a.embedding <=> b.embedding) >= 0.8
`;

const sortedDirected = rows => [...rows].sort((a, b) =>
  a.source_id.localeCompare(b.source_id) || a.target_id.localeCompare(b.target_id));

const undirected = rows => {
  const edges = new Map();
  for (const row of rows) {
    edges.set([row.source_id, row.target_id].sort().join('/'), row.similarity);
  }
  return [...edges].sort(([a], [b]) => a.localeCompare(b));
};

async function seedGraphVectors(count, runQuery = query) {
  // Synthetic full-dimensional float32 vectors; no live records. The row
  // offset breaks the modulo formula's 997-row repetition (and cutoff ties).
  await runQuery(`
    INSERT INTO memories (id, type, content, summary, embedding)
    SELECT md5(i::text)::uuid, 'fact', 'Synthetic graph fixture', 'Synthetic graph fixture',
      ARRAY(SELECT ((i * 17 + j * 31) % 997)::real / 997 + i::real / 10000
            FROM generate_series(1, $2::int) j)::vector
    FROM generate_series(1, $1::int) i
  `, [count, DIM]);
}

describe.skipIf(!runDb)('memoryDB bounded graph snapshot (#9526)', () => {
  beforeEach(resetMemories);

  it('returns an empty graph, and retains null-vector nodes without similarity edges', async () => {
    expect(await memoryDB.getGraphData()).toEqual({ nodes: [], edges: [] });
    const note = await memoryDB.createMemory({ type: 'fact', content: 'No embedding.' });
    const graph = await memoryDB.getGraphData();
    expect(graph.nodes.map(n => n.id)).toEqual([note.id]);
    expect(graph.edges).toEqual([]);
  });

  it('preserves exact vector values, top-three weights, threshold and explicit-link precedence', async () => {
    await seedGraphVectors(12);
    const nullNode = await memoryDB.createMemory({ type: 'fact', content: 'No vector.' });
    const archived = await memoryDB.createMemory({ type: 'fact', content: 'Archived.', status: 'archived' }, VEC_A);
    const distant = await memoryDB.createMemory({ type: 'fact', content: 'Orthogonal.' }, VEC_UNSEEN);
    // The oracle must use the old exact scan, not an approximate HNSW plan
    // selected from statistics/dead index entries left by another DB test.
    const legacy = await withTransaction(async client => {
      await client.query('SET LOCAL enable_indexscan = off');
      return (await client.query(legacyGraphSimilarity)).rows;
    });
    expect(legacy.length).toBeGreaterThan(3);
    expect(legacy.some(r => [nullNode.id, archived.id, distant.id].includes(r.target_id))).toBe(false);
    const { source_id: source, target_id: target } = legacy[0];
    await memoryDB.linkMemories(source, target);
    await memoryDB.linkMemories(source, archived.id);
    const roundTrip = await query(`SELECT bool_and(embedding = embedding::real[]::vector) AS identical
      FROM memories WHERE embedding IS NOT NULL`);
    expect(roundTrip.rows[0].identical).toBe(true);
    const probe = observeGraph();
    try {
      const graph = await memoryDB.getGraphData();
      expect(sortedDirected(probe.observation.directed)).toEqual(sortedDirected(legacy));
      expect(graph.nodes).toHaveLength(14);
      expect(graph.nodes.some(n => n.id === archived.id)).toBe(false);
      expect(graph.nodes.every(n => Object.keys(n).sort().join() === 'category,id,importance,summary,type')).toBe(true);
      const expected = new Map(undirected(legacy));
      expected.set([source, target].sort().join('/'), 1);
      expect(graph.edges).toHaveLength(expected.size);
      for (const edge of graph.edges) {
        expect(edge.source).not.toBe(edge.target);
        const key = [edge.source, edge.target].sort().join('/');
        expect(edge.weight).toBe(expected.get(key));
        expect(edge.type).toBe(key === [source, target].sort().join('/') ? 'linked' : 'similar');
      }
    } finally {
      probe.restore();
    }
  });

  it.each([2048, 2049])('returns all %i active nodes and valid tied top-three neighbors', async count => {
    // Count ALL active nodes, including null vectors. Only six embeddings keep
    // this admission-boundary regression cheap while exercising cutoff ties.
    await query(`INSERT INTO memories (id, type, content, summary, embedding)
      SELECT md5(i::text)::uuid, 'fact', 'Boundary fixture', 'Boundary fixture',
        CASE WHEN i <= 6 THEN $2::vector ELSE NULL END
      FROM generate_series(1, $1::int) i`, [count, JSON.stringify(VEC_A)]);
    await query('ANALYZE memories');
    const probe = observeGraph();
    try {
      const graph = await memoryDB.getGraphData();
      expect(graph.nodes).toHaveLength(count);
      expect(probe.observation.statements.some(sql => sql.includes('AS MATERIALIZED'))).toBe(count === 2048);
      expect(probe.observation.statements.some(sql => sql.includes('SET LOCAL work_mem'))).toBe(count === 2048);
      expect(probe.observation.directed).toHaveLength(18);
      const bySource = Map.groupBy(probe.observation.directed, row => row.source_id);
      expect(bySource.size).toBe(6);
      for (const [source, neighbors] of bySource) {
        expect(new Set(neighbors.map(n => n.target_id)).size).toBe(3);
        expect(neighbors.every(n => n.target_id !== source && n.similarity === 1)).toBe(true);
      }
      expect(graph.edges).toHaveLength(undirected(probe.observation.directed).length);
      expect(graph.edges.every(e => e.type === 'similar' && e.weight === 1)).toBe(true);
    } finally {
      probe.restore();
    }
  });

  it('keeps concurrent inserts outside the admitted snapshot and restores connection settings', async () => {
    await query(`INSERT INTO memories (id, type, content, summary, embedding)
      SELECT md5(i::text)::uuid, 'fact', 'Snapshot fixture', 'Snapshot fixture',
        CASE WHEN i = 1 THEN $1::vector ELSE NULL END
      FROM generate_series(1, 2048) i`, [JSON.stringify(VEC_A)]);
    const before = (await query(`SELECT current_setting('work_mem') AS work_mem,
      current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only`)).rows[0];
    let inserted;
    const probe = observeGraph({ afterNodes: async () => {
      inserted = await memoryDB.createMemory({ type: 'fact', content: 'Concurrent insert.' }, VEC_A);
      const first = (await query('SELECT id FROM memories WHERE id != $1 LIMIT 1', [inserted.id])).rows[0];
      await memoryDB.linkMemories(first.id, inserted.id);
    } });
    try {
      const graph = await memoryDB.getGraphData();
      expect(graph.nodes).toHaveLength(2048);
      expect(graph.edges).toEqual([]);
      expect(probe.observation.settings).toEqual({ work_mem: '32MB', isolation: 'repeatable read', read_only: 'on' });
      expect(probe.observation.restored).toEqual(before);
      expect((await query("SELECT count(*)::int AS count FROM memories WHERE status = 'active'")).rows[0].count).toBe(2049);
    } finally {
      probe.restore();
    }
    expect((await memoryDB.getGraphData()).nodes).toHaveLength(2049);
  });

  it('rolls back a failed similarity statement and restores settings before releasing its connection', async () => {
    const before = (await query(`SELECT current_setting('work_mem') AS work_mem,
      current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only`)).rows[0];
    const probe = observeGraph({ failSimilarity: true });
    try {
      await expect(memoryDB.getGraphData()).rejects.toThrow('division by zero');
      expect(probe.observation.statements).toContain('ROLLBACK');
      expect(probe.observation.restored).toEqual(before);
    } finally {
      probe.restore();
    }
    expect(await memoryDB.getGraphData()).toEqual({ nodes: [], edges: [] });
  });

  // Explicit opt-in experiment: no machine-dependent timing assertions.
  it.skipIf(!process.env.MEMORY_GRAPH_BENCHMARK)('compares stored-vector EXPLAIN plans at 512 and 1024 rows', async () => {
    const probe = observeGraph();
    let optimized;
    try {
      await memoryDB.getGraphData();
      optimized = probe.observation.statements.find(sql => sql.includes('CROSS JOIN LATERAL'));
    } finally {
      probe.restore();
    }
    for (const count of [512, 1024]) {
      await withTransaction(async client => {
        // Match the issue's controlled exact-scan fixture. The production table
        // has an HNSW index whose approximate plan can mask the storage cost.
        await client.query(`CREATE TEMP TABLE memories (
          id uuid, type text, content text, summary text,
          embedding vector(${DIM}), status text DEFAULT 'active'
        ) ON COMMIT DROP`);
        await seedGraphVectors(count, client.query.bind(client));
        await client.query('ANALYZE memories');
        await client.query("SET LOCAL work_mem = '32MB'");
        const cutoffs = await client.query(`
          WITH active_embeddings AS MATERIALIZED (
            SELECT id, embedding::real[]::vector AS embedding FROM memories
          )
          SELECT count(*)::int AS ties FROM active_embeddings a
          CROSS JOIN LATERAL (
            SELECT array_agg(distance ORDER BY distance) AS distances FROM (
              SELECT embedding <=> a.embedding AS distance FROM active_embeddings
              WHERE id != a.id ORDER BY distance LIMIT 4
            ) nearest
          ) b WHERE b.distances[3] = b.distances[4]
        `);
        expect(cutoffs.rows[0].ties).toBe(0);
        const oldRows = (await client.query(legacyGraphSimilarity)).rows;
        const newRows = (await client.query(optimized)).rows;
        expect(sortedDirected(newRows)).toEqual(sortedDirected(oldRows));
        for (const [strategy, sql] of [['legacy', legacyGraphSimilarity], ['unpacked', optimized]]) {
          const result = await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql);
          const plan = result.rows[0]['QUERY PLAN'][0];
          const root = plan.Plan;
          if (strategy === 'unpacked') {
            expect(root['Temp Read Blocks']).toBe(0);
            expect(root['Temp Written Blocks']).toBe(0);
          }
          console.log(`Graph fixture rows=${count} strategy=${strategy} ms=${plan['Execution Time']} sharedHits=${root['Shared Hit Blocks']} localHits=${root['Local Hit Blocks']} tempRead=${root['Temp Read Blocks']} tempWritten=${root['Temp Written Blocks']} directed=${newRows.length}`);
        }
      });
    }
  }, 60000);
});

// #10953: Brain graph reads pass the memory ids bridged to visible Brain nodes.
// Scoped output must equal the full graph filtered to those endpoints.
const planNodes = (node) => [node, ...(node.Plans ?? []).flatMap(planNodes)];
const graphKey = (e) => `${[e.source, e.target].sort().join('/')}:${e.type}:${e.linkType ?? ''}:${e.weight}`;
const filteredGraph = (graph, scope) => ({
  nodes: graph.nodes.filter(n => scope.has(n.id)).map(n => n.id).sort(),
  edges: graph.edges.filter(e => scope.has(e.source) && scope.has(e.target)).map(graphKey).sort(),
});
const graphShape = (graph) => ({ nodes: graph.nodes.map(n => n.id).sort(), edges: graph.edges.map(graphKey).sort() });

describe.skipIf(!runDb)('memoryDB scoped graph sources (#10953)', () => {
  beforeEach(resetMemories);

  it('keeps an out-of-scope neighbour in its global top-three slot, link precedence and archived rules', async () => {
    // m1's global top three are m2, m3, m5 (m3/m5 out of scope); in-scope m4 is
    // fourth, and m4's own top three are m6–m8. Restricting candidates before
    // LIMIT 3 would promote m4 and invent an m1–m4 edge.
    const vec = (x, y = 0, z = 0) => { const v = axis(0); v[1] = x; v[2] = y; v[3] = z; return v; };
    const make = (name, embedding, status) => memoryDB.createMemory({ type: 'fact', content: `Scope ${name}.`, status }, embedding);
    const m1 = await make('m1', vec(0));
    const m2 = await make('m2', vec(0.1));
    const m3 = await make('m3', vec(0.15));
    const m5 = await make('m5', vec(0, 0.2));
    const m4 = await make('m4', vec(0, 0, 0.45));
    const m6 = await make('m6', vec(0, 0, 0.5));
    await make('m7', vec(0, 0, 0.55));
    await make('m8', vec(0, 0, 0.6));
    const gone = await make('archived', vec(0.05), 'archived');
    const unembedded = await memoryDB.createMemory({ type: 'fact', content: 'Scope no vector.' });
    await memoryDB.linkMemories(m1.id, m2.id);                                // precedence over similar
    await memoryDB.linkMemories(m4.id, m2.id, { linkType: 'supersedes' });   // directed orientation
    await memoryDB.linkMemories(m4.id, unembedded.id);                       // in-scope null vector
    await memoryDB.linkMemories(m4.id, m6.id);                               // out-of-scope endpoint
    await memoryDB.linkMemories(m1.id, gone.id);                             // archived endpoint

    const scope = new Set([m1.id, m2.id, m4.id, unembedded.id, gone.id]);
    const full = await memoryDB.getGraphData();
    const scoped = await memoryDB.getGraphData({ sourceIds: [...scope, 'not-a-uuid'] });
    expect(graphShape(scoped)).toEqual(filteredGraph(full, scope));
    expect(scoped.nodes.some(n => n.id === gone.id)).toBe(false);

    const pair = (a, b) => scoped.edges.filter(e => [e.source, e.target].sort().join('/') === [a.id, b.id].sort().join('/'));
    expect(pair(m1, m2)).toEqual([expect.objectContaining({ type: 'linked', linkType: 'related' })]);
    expect(pair(m1, m4)).toEqual([]);
    expect(pair(m2, m4).find(e => e.linkType === 'supersedes')).toMatchObject({ source: m4.id, target: m2.id });
    expect(pair(m4, unembedded)).toHaveLength(1);
    expect(full.edges.some(e => [e.source, e.target].includes(m3.id) || [e.source, e.target].includes(m5.id))).toBe(true);

    // Empty scope never reaches the database; absent scope is the full graph.
    const probe = observeGraph();
    try {
      expect(await memoryDB.getGraphData({ sourceIds: [] })).toEqual({ nodes: [], edges: [] });
      expect(await memoryDB.getGraphData({ sourceIds: ['not-a-uuid'] })).toEqual({ nodes: [], edges: [] });
      expect(probe.observation.statements).toEqual([]);
    } finally {
      probe.restore();
    }
    expect(graphShape(await memoryDB.getGraphData({}))).toEqual(graphShape(full));
    await expect(memoryDB.getGraphData({ sourceIds: 'nope' })).rejects.toThrow(TypeError);
  });

  it('plans fewer outer similarity loops with unchanged relevant rows and no spill', async () => {
    await seedGraphVectors(40);
    const scopeIds = (await query('SELECT md5(i::text)::uuid::text AS id FROM generate_series(1, 10) i')).rows.map(r => r.id);
    const scope = new Set(scopeIds);
    const legacy = await withTransaction(async client => {
      await client.query('SET LOCAL enable_indexscan = off');
      return (await client.query(legacyGraphSimilarity)).rows;
    });

    const run = async (options) => {
      const probe = observeGraph({ explain: true });
      try {
        const graph = await memoryDB.getGraphData(options);
        return { graph, ...probe.observation };
      } finally {
        probe.restore();
      }
    };
    const full = await run();
    const scoped = await run({ sourceIds: scopeIds });

    const lateralLoops = (plan) => planNodes(plan).find(n => n['Node Type'] === 'Limit')['Actual Loops'];
    expect(lateralLoops(full.plan)).toBe(40);
    expect(lateralLoops(scoped.plan)).toBe(scope.size);
    for (const plan of [full.plan, scoped.plan]) {
      expect(plan['Temp Written Blocks']).toBe(0);
      expect(plan['Temp Read Blocks']).toBe(0);
    }
    expect(scoped.settings).toEqual({ work_mem: '32MB', isolation: 'repeatable read', read_only: 'on' });

    const relevant = rows => sortedDirected(rows.filter(r => scope.has(r.source_id) && scope.has(r.target_id)));
    expect(relevant(legacy).length).toBeGreaterThan(0);
    expect(sortedDirected(scoped.directed)).toEqual(relevant(legacy));
    expect(graphShape(scoped.graph)).toEqual(filteredGraph(full.graph, scope));
  });

  it.each([2048, 2049])('admits a scoped read by the whole active count (%i nodes)', async count => {
    await query(`INSERT INTO memories (id, type, content, summary, embedding)
      SELECT md5(i::text)::uuid, 'fact', 'Boundary fixture', 'Boundary fixture',
        CASE WHEN i <= 6 THEN $2::vector ELSE NULL END
      FROM generate_series(1, $1::int) i`, [count, JSON.stringify(VEC_A)]);
    await query('ANALYZE memories');
    // Every embedded node plus two null-vector nodes: all ties stay in scope.
    const scopeIds = (await query('SELECT md5(i::text)::uuid::text AS id FROM generate_series(1, 8) i')).rows.map(r => r.id);
    const probe = observeGraph();
    try {
      const graph = await memoryDB.getGraphData({ sourceIds: scopeIds });
      expect(graph.nodes.map(n => n.id).sort()).toEqual([...scopeIds].sort());
      expect(probe.observation.statements.some(sql => sql.includes('AS MATERIALIZED'))).toBe(count === 2048);
      expect(probe.observation.directed).toHaveLength(18);
      expect(graph.edges).toHaveLength(undirected(probe.observation.directed).length);
      expect(graph.edges.every(e => e.type === 'similar' && e.weight === 1)).toBe(true);
    } finally {
      probe.restore();
    }
  });
});

describe.skipIf(!runDb)('memory history and stale-write contract (#10494)', () => {
  beforeEach(resetMemories);

  it('retains exact earlier texts, permits deliberate clears and ignores operational updates', async () => {
    const first = await memoryDB.createMemory({ type: 'fact', content: 'First text', summary: 'First', tags: ['a'] }, VEC_A);
    expect(first.version).toBe(1);
    const second = await memoryDB.updateMemory(first.id, {
      content: 'Second text', summary: '', expectedVersion: 1, changeReason: 'Correction', changedBy: 'test-agent'
    });
    expect(second).toMatchObject({ version: 2, summary: '' });
    const third = await memoryDB.updateMemory(first.id, { type: 'decision', category: 'workflow', tags: ['b'], expectedVersion: 2 });
    expect(third.version).toBe(3);
    expect(await memoryDB.getMemoryVersion(first.id, 1)).toMatchObject({
      content: 'First text', summary: 'First', type: 'fact', tags: ['a'], changedBy: 'test-agent', changeReason: 'Correction'
    });
    expect(await memoryDB.getMemoryVersion(first.id, 2)).toMatchObject({ content: 'Second text', summary: '', tags: ['a'] });
    expect(await memoryDB.getMemoryVersion(first.id, 3)).toMatchObject({ content: 'Second text', type: 'decision' });
    expect(await memoryDB.getMemoryVersion(first.id, 99)).toBeNull();
    await memoryDB.getMemory(first.id);
    await memoryDB.updateMemoryEmbedding(first.id, VEC_FAR);
    await memoryDB.updateMemory(first.id, { importance: 0.7, content: 'Second text', summary: '', tags: ['b'] });
    await memoryDB.applyDecay();
    expect((await memoryDB.peekMemory(first.id)).version).toBe(3);
    expect((await memoryDB.getMemoryVersions(first.id)).map(row => row.version)).toEqual([2, 1]);
    expect((await memoryDB.getMemoryVersions(first.id, { limit: 1, offset: 1 })).map(row => row.version)).toEqual([1]);
  });

  it('serializes competing guarded writers and rolls back history with failed link edits', async () => {
    const first = await memoryDB.createMemory({ type: 'fact', content: 'Original' });
    const results = await Promise.allSettled([
      memoryDB.updateMemory(first.id, { content: 'Edit A', expectedVersion: 1 }),
      memoryDB.updateMemory(first.id, { content: 'Edit B', expectedVersion: 1 })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason).toMatchObject({ status: 409 });
    expect((await memoryDB.peekMemory(first.id)).version).toBe(2);
    await expect(memoryDB.updateMemory(first.id, {
      content: 'Must roll back', relatedMemories: ['00000000-0000-4000-8000-00000000dead']
    })).rejects.toThrow();
    expect((await memoryDB.peekMemory(first.id)).version).toBe(2);
    expect(await memoryDB.getMemoryVersions(first.id)).toHaveLength(1);
    await memoryDB.purgeMemory(first.id);
    expect(await memoryDB.getMemoryVersions(first.id)).toEqual([]);
  });

  it('archives with replacement atomically and legacy relation edits preserve supersedes', async () => {
    const old = await memoryDB.createMemory({ type: 'fact', content: 'Old' });
    const replacement = await memoryDB.createMemory({ type: 'fact', content: 'New' });
    await expect(memoryDB.archiveMemory(old.id, { supersededBy: '00000000-0000-4000-8000-00000000dead' })).rejects.toMatchObject({ status: 404 });
    expect(await statusOf(old.id)).toBe('active');
    await memoryDB.archiveMemory(old.id, { reason: 'Corrected', supersededBy: replacement.id });
    await memoryDB.updateMemory(replacement.id, { relatedMemories: [] });
    expect(await memoryDB.getMemory(old.id)).toMatchObject({ status: 'archived', archiveReason: 'Corrected', supersededBy: [replacement.id] });
    expect(await memoryDB.getMemoryVersions(old.id)).toEqual([]);
  });

  it('upgrades idempotently without rewriting existing content or manufacturing history', async () => {
    const original = await memoryDB.createMemory({ type: 'fact', content: 'Keep me' });
    const { up } = await import('../scripts/db-migrations/014-memory-version-history.js');
    await withTransaction(up);
    await withTransaction(up);
    expect(await memoryDB.peekMemory(original.id)).toMatchObject({ content: 'Keep me', version: 1 });
    expect(await memoryDB.getMemoryVersions(original.id)).toEqual([]);
  });
});


describe.skipIf(!runDb)('durable brain memory identity (#11007)', () => {
  beforeEach(async () => {
    await query('DELETE FROM brain_memory_links');
    await resetMemories();
  });

  const data = { type: 'fact', content: 'Example brain project', sourceAppId: 'brain', category: 'project' };

  it('retries after a lost map save and serializes overlapping first writes', async () => {
    // There is deliberately no file save between these independent calls.
    const results = await Promise.all([
      memoryDB.upsertBrainMemory('projects:example', data, VEC_A),
      memoryDB.upsertBrainMemory('projects:example', data, VEC_A),
    ]);
    expect(results[0].id).toBe(results[1].id);
    const retry = await memoryDB.upsertBrainMemory('projects:example', { ...data, content: 'Updated example' });
    expect(retry.id).toBe(results[0].id);
    expect((await memoryDB.getMemories({ appId: 'brain' })).total).toBe(1);
    expect(await memoryDB.getBrainMemoryLinks()).toEqual({ 'projects:example': retry.id });
    expect((await memoryDB.getMemoryVersions(retry.id)).length).toBe(1);
  });

  it('reuses a legacy row, ignores a stale cache, and heals a purged target', async () => {
    const legacy = await memoryDB.createMemory(data, VEC_A);
    await expect(memoryDB.getBrainMemoryLinks({}, { recover: true }))
      .rejects.toThrow('no durable links exist yet');
    expect(await memoryDB.getBrainMemoryLinks({ 'projects:example': legacy.id }, { readOnly: true })).toEqual({
      'projects:example': legacy.id,
    });
    expect((await query('SELECT * FROM brain_memory_links')).rows).toEqual([]);
    expect(await memoryDB.getBrainMemoryLinks({ 'projects:example': legacy.id })).toEqual({
      'projects:example': legacy.id,
    });
    const saved = await memoryDB.upsertBrainMemory('projects:example', data);
    expect(saved.id).toBe(legacy.id);
    await memoryDB.purgeMemory(saved.id);
    expect(await memoryDB.getBrainMemoryLinks({ 'projects:example': saved.id })).toEqual({});
    const healed = await memoryDB.upsertBrainMemory('projects:example', data, VEC_A, saved.id);
    expect(healed.id).not.toBe(saved.id);
    expect(await memoryDB.getBrainMemoryLinks({ 'projects:example': saved.id })).toEqual({
      'projects:example': healed.id,
    });
    expect((await memoryDB.getMemories({ appId: 'brain' })).total).toBe(1);
  });

  it('rolls back the reserved link when the memory insert fails', async () => {
    await expect(memoryDB.upsertBrainMemory('projects:example', { ...data, type: 'invalid-type-exceeding-column-length' }))
      .rejects.toThrow();
    expect((await query('SELECT * FROM brain_memory_links')).rows).toEqual([]);
    expect((await memoryDB.getMemories({ appId: 'brain' })).total).toBe(0);
  });

  afterAll(async () => { await query('DELETE FROM brain_memory_links'); });
});
