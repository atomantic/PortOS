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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { mockNoPeers, mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
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
vi.mock('./instances.js', async (importOriginal) => {
  const actual = await importOriginal();
  return mockNoPeers(actual, { getInstanceId: () => Promise.resolve(TEST_INSTANCE_ID) });
});

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
if (!dbReady) console.log(`⏭️ memoryDB.db.test: skipping suite — ${skipReason || 'no database'}`);

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

describe.skipIf(!dbReady)('memoryDB CRUD (#3447)', () => {
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

    expect(await memoryDB.linkMemories(a.id, b.id)).toEqual({ success: true, sourceId: a.id, targetId: b.id });
    expect((await memoryDB.getMemory(a.id)).relatedMemories).toEqual([b.id]);
    expect((await memoryDB.getMemory(b.id)).relatedMemories).toEqual([a.id]);

    const missing = await memoryDB.linkMemories(a.id, '00000000-0000-4000-8000-00000000dead');
    expect(missing).toEqual({ success: false, error: 'Memory not found' });
  });

  it('soft-deletes by default and hard-deletes on request', async () => {
    const soft = await memoryDB.createMemory({ type: 'fact', content: 'Soft delete me.' });
    await memoryDB.deleteMemory(soft.id);
    expect(await statusOf(soft.id)).toBe('archived');

    const hard = await memoryDB.createMemory({ type: 'fact', content: 'Hard delete me.' });
    await memoryDB.deleteMemory(hard.id, true);
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
    // Rejection is a hard delete, not an archive.
    expect(await memoryDB.peekMemory(doomed.id)).toBeNull();

    expect(await memoryDB.approveMemory('00000000-0000-4000-8000-00000000dead')).toEqual({ success: false, error: 'Memory not found' });
    expect(await memoryDB.rejectMemory('00000000-0000-4000-8000-00000000dead')).toEqual({ success: false, error: 'Memory not found' });
  });
});

// ---------------------------------------------------------------------------
// Listing / filtering
// ---------------------------------------------------------------------------

describe.skipIf(!dbReady)('memoryDB listing filters (#3447)', () => {
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

describe.skipIf(!dbReady)('memoryDB search (#3447)', () => {
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

describe.skipIf(!dbReady)('memoryDB consolidateMemories (#3447)', () => {
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
    // A memory with no near neighbour is never part of a cluster.
    expect(await statusOf(lone.id)).toBe('active');

    // Idempotent: the survivor no longer has an active duplicate to merge with.
    expect(await memoryDB.consolidateMemories(0.9)).toEqual({ merged: 0, clusters: 0 });
  });
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

describe.skipIf(!dbReady)('memoryDB applyDecay boundaries (#3447)', () => {
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

describe.skipIf(!dbReady)('memoryDB getGraphData (#3447)', () => {
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
