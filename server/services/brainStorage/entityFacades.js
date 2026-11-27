/** Brain entity accessors, paginated projections and dashboard summaries. */
import { safeDate } from '../../lib/fileUtils.js';
import { linkIsRepo, normalizeRepoLinkFields } from '../../lib/repoLinkFields.js';
import { loadMeta } from './logStore.js';
import {
  create, createRecordIndex, getAll, getById, isTombstone, now, query, remove,
  resolveRecordIndex, update, updateMany, updateManyWithBatchLog, updateWith,
} from './recordStore.js';

// =============================================================================
// INBOX LOG OPERATIONS
// =============================================================================

// The inbox is an id-keyed entity store (see BRAIN_ENTITY_TYPES) so it
// federates through the same delta-log + LWW + tombstone pipeline as every other
// brain type. These wrappers keep the historical getInboxLog/createInboxLog/…
// API (capturedAt sort, status counts) on top of the generic entity primitives.

// Cursor pages share one contract: rows sort newest-first (timestamp descending)
// with the id ascending as the tiebreak, and the cursor is the last row's
// `<zero-padded timestamp>_<id>` key. Continuation therefore keeps older rows
// and, at the cursor's own timestamp, only ids that sort AFTER the cursor id --
// comparing the encoded key as a string would pick the smaller ids instead and
// repeat/skip rows whenever a timestamp tie crosses a page boundary. The cursor
// row itself need not still exist. A malformed cursor yields the first page.
const cursorKeyOf = (id, timestampMs) => `${String(timestampMs).padStart(15, '0')}_${id}`;

function rowsAfterCursor(rows, cursor, timestampOf) {
  const match = /^(\d+)_(.*)$/s.exec(cursor);
  if (!match) return rows;
  const cursorMs = Number(match[1]);
  const cursorId = match[2];
  return rows.filter(([id, summary]) => {
    const ms = timestampOf(summary);
    return ms < cursorMs || (ms === cursorMs && id.localeCompare(cursorId) > 0);
  });
}

/**
 * One page of inbox entries (newest-first by capturedAt), optional status/search filters and cursor pagination.
 */
export async function getInboxPage(options = {}) {
  const { status, search, cursor, limit = 50, offset = 0 } = options;
  const boundedLimit = Math.min(Math.max(1, limit), 100);
  const rows = await resolveRecordIndex(summaryIndex, 'inbox', 0);
  const searchLower = search ? search.trim().toLowerCase() : null;

  const matching = rows.filter(([id, summary]) => {
    if (!summary) return false;
    if (status && summary.status !== status) return false;
    if (searchLower) {
      const textMatch = summary.capturedText?.toLowerCase().includes(searchLower);
      const titleMatch = summary.title?.toLowerCase().includes(searchLower);
      if (!textMatch && !titleMatch) return false;
    }
    return true;
  });

  // Bulk captures can share one timestamp. The id tiebreak keeps adjacent
  // cursor/offset pages stable so an entry is never duplicated or skipped.
  matching.sort(([idA, a], [idB, b]) => (b.capturedAtMs - a.capturedAtMs) || idA.localeCompare(idB));
  const total = matching.length;

  let remaining = matching;
  if (cursor) {
    remaining = rowsAfterCursor(matching, cursor, (s) => s.capturedAtMs);
  } else if (offset > 0) {
    remaining = matching.slice(offset);
  }

  const pageRows = remaining.slice(0, boundedLimit);
  const pageIds = pageRows.map(([id]) => id);
  const page = await Promise.all(pageIds.map((id) => getById('inbox', id)));
  const entries = page.filter(Boolean);

  const hasMore = remaining.length > boundedLimit;
  const nextCursor = hasMore && pageRows.length > 0
    ? cursorKeyOf(pageRows[pageRows.length - 1][0], pageRows[pageRows.length - 1][1].capturedAtMs)
    : null;

  return {
    entries,
    items: entries,
    total,
    nextCursor
  };
}

/**
 * Get all inbox log entries (newest-first by capturedAt), optional status filter.
 */
export async function getInboxLog(options = {}) {
  const page = await getInboxPage(options);
  const arr = page.entries;
  arr.total = page.total;
  arr.nextCursor = page.nextCursor;
  arr.items = page.items;
  return arr;
}

/**
 * Get inbox log entry by ID
 */
export async function getInboxLogById(id) {
  return getById('inbox', id);
}

// The inbox's concurrent same-record write paths (a capture's create immediately
// followed by a background-classification update on the same entry, plus the
// boot recovery sweep) are serialized by create/update/remove's own per-id write
// queue — no separate inbox lock is needed.

/**
 * Create inbox log entry. `capturedAt` is the user-facing capture time (kept
 * distinct from the sync `createdAt`/`updatedAt` clocks stamped by create()).
 */
export async function createInboxLog(entry) {
  return create('inbox', { ...entry, capturedAt: entry.capturedAt || now() });
}

/**
 * Update inbox log entry (partial merge — returns null if absent/tombstoned).
 */
export async function updateInboxLog(id, updates) {
  return update('inbox', id, updates);
}

/**
 * Delete inbox log entry (tombstones in place for sync convergence).
 */
export async function deleteInboxLog(id) {
  return remove('inbox', id);
}

/**
 * Get inbox log count by status
 */
export async function getInboxLogCounts() {
  const rows = await resolveRecordIndex(summaryIndex, 'inbox', 0);

  const counts = {
    total: 0,
    classifying: 0,
    filed: 0,
    needs_review: 0,
    corrected: 0,
    done: 0,
    error: 0
  };

  for (const [, summary] of rows) {
    if (!summary) continue;
    counts.total++;
    if (counts[summary.status] !== undefined) {
      counts[summary.status]++;
    }
  }

  return counts;
}

// =============================================================================
// CONVENIENCE EXPORTS FOR ENTITY TYPES
// =============================================================================

// People
export const getPeople = (filters) => filters ? query('people', filters) : getAll('people');
export const getPersonById = (id) => getById('people', id);
export const createPerson = (data) => create('people', data);
export const updatePerson = (id, data) => update('people', id, data);
export const deletePerson = (id) => remove('people', id);

// Projects
export const getProjects = (filters) => filters ? query('projects', filters) : getAll('projects');
export const getProjectById = (id) => getById('projects', id);
export const createProject = (data) => create('projects', data);
export const updateProject = (id, data) => update('projects', id, data);
export const deleteProject = (id) => remove('projects', id);

// Ideas
export const getIdeas = (filters) => filters ? query('ideas', filters) : getAll('ideas');
export const getIdeaById = (id) => getById('ideas', id);
export const createIdea = (data) => create('ideas', data);
export const updateIdea = (id, data) => update('ideas', id, data);
export const deleteIdea = (id) => remove('ideas', id);

// Admin
export const getAdminItems = (filters) => filters ? query('admin', filters) : getAll('admin');
export const getAdminById = (id) => getById('admin', id);
export const createAdminItem = (data) => create('admin', data);
export const updateAdminItem = (id, data) => update('admin', id, data);
export const deleteAdminItem = (id) => remove('admin', id);

// Memories
/**
 * Effective recency timestamp (ms epoch) for ordering a memory entry newest-first.
 *
 * Imported conversations (ChatGPT) carry the original conversation clock in
 * `sourceUpdatedAt` / `sourceCreatedAt`. A ChatGPT export is NOT ordered
 * chronologically, and every entry from one bulk import shares the same
 * `createdAt`/`updatedAt` (the import time) — so sorting on the storage clock
 * leaves imports in arbitrary export order (the user-reported bug). Prefer the
 * source clock when present, falling back to the storage clock for hand-written
 * entries. Returns 0 for a missing/unparseable timestamp so it sorts last.
 */
export const memoryRecencyMs = (record) => {
  for (const candidate of [
    record?.sourceUpdatedAt,
    record?.sourceCreatedAt,
    record?.updatedAt,
    record?.createdAt,
  ]) {
    const t = safeDate(candidate); // epoch ms, or 0 for missing/unparseable
    if (t) return t;
  }
  return 0;
};

export const getMemoryEntries = async () => {
  const entries = await getAll('memories');
  // Decorate-sort-undecorate: compute each record's recency once (a bulk ChatGPT
  // import can be hundreds of entries — recomputing it inside the comparator
  // would parse every timestamp O(n log n) times).
  return entries
    .map((entry) => ({ entry, recency: memoryRecencyMs(entry) }))
    .sort((a, b) => b.recency - a.recency)
    .map(({ entry }) => entry);
};
export const getMemoryEntryById = (id) => getById('memories', id);
export const createMemoryEntry = (data) => create('memories', data);
export const updateMemoryEntry = (id, data) => update('memories', id, data);
export const deleteMemoryEntry = (id) => remove('memories', id);

// Links
//
// EVERY link leaves this module through `readLink`/`readLinks`, which apply
// `normalizeRepoLinkFields` so a record written by an older PortOS (or arriving
// from a peer still on the GitHub-only field names) reads as a repo — see
// lib/repoLinkFields.js. Route through them when adding an accessor; the
// persisted payload itself is never rewritten (the derivation belongs to
// `createLinkFromUrl`, which owns the URL).
const readLink = async (record) => normalizeRepoLinkFields(await record);
const readLinks = async (records) => (await records).map(normalizeRepoLinkFields);
export const getLinks = (filters) => readLinks(filters ? query('links', filters) : getAll('links'));
export const getLinkById = (id) => readLink(getById('links', id));
export const createLink = (data) => readLink(create('links', data));
export const updateLink = (id, data) => readLink(update('links', id, data));
export const updateLinkWith = (id, fn) => readLink(updateWith('links', id, fn));
// Batch reorder: per-id write queues so a multi-chip drag merges each link
// against its freshest persisted record.
export const reorderLinks = (updates) => readLinks(updateMany('links', updates));
export const deleteLink = (id) => remove('links', id);

// ─── Link summary index (issue #3509) ───────────────────────────────────────
// Every ordering, filtering, counting, and membership question the links API
// asks is answerable from four fields. Caching just those in a projection index
// (see createRecordIndex) means `GET /api/brain/links` reads ONLY the
// requested page's record bodies instead of the whole collection — page cost
// goes from O(N) parsed records to O(limit).
//
// `null` marks an id that is not a user-visible link (absent, unparseable, or
// tombstoned) — exactly what `getAll` drops. Tombstones stay in the id listing,
// so this must be a null projection rather than an omitted entry.
const projectLinkSummary = (record) => (record && !isTombstone(record)
  ? {
    // Pre-parsed sort key: `getAll` + `new Date()` in a comparator re-parses the
    // same timestamp O(n log n) times. `safeDate` yields 0 for a missing or
    // unparseable createdAt, so such a link sorts last deterministically
    // instead of poisoning the comparator with NaN.
    createdAtMs: safeDate(record.createdAt),
    // `linkType` is stored RAW so the route's strict `===` comparison keeps its
    // exact semantics. `isRepo` is resolved through `linkIsRepo` instead, so a
    // legacy record still carrying only `isGitHubRepo` filters correctly without
    // the index having to be rebuilt behind the migration.
    linkType: record.linkType,
    isRepo: linkIsRepo(record),
    url: record.url,
  }
  : null);
const linkSummaryIndex = createRecordIndex(projectLinkSummary);

// The Brain header and inbox gates need only these two fields from each
// user-visible record. Keeping that projection beside the link summary index
// lets their frequent count reads reuse the same per-record invalidation
// machinery without parsing full record bodies in steady state.
const projectSummary = (record) => (record && !isTombstone(record)
  ? {
    status: record.status,
    capturedAtMs: safeDate(record.capturedAt),
    capturedText: record.capturedText || record.text || '',
    title: record.title || record.extracted?.title || record.extracted?.name || '',
  }
  : null);
const summaryIndex = createRecordIndex(projectSummary);

export const MEMORY_LIST_CONTENT_CHARS = 300;

/**
 * Compact row projection for memory cards. Transcripts and long notes can reach
 * thousands of characters; the card only renders a short teaser, so clamp the
 * content at the transport boundary to keep list pages bounded. Full records
 * remain available from GET /api/brain/memories/:id.
 */
export function toMemoryListItem(memory) {
  if (!memory) return memory;
  if (typeof memory.content !== 'string') return memory;
  if (memory.content.length <= MEMORY_LIST_CONTENT_CHARS) return memory;
  return {
    ...memory,
    content: memory.content.slice(0, MEMORY_LIST_CONTENT_CHARS),
    contentTruncated: true,
  };
}

const projectEntitySummary = (record) => (record && !isTombstone(record)
  ? {
    status: record.status || null,
    archived: !!record.archived,
    sortKey: memoryRecencyMs(record) || safeDate(record.updatedAt || record.createdAt),
    searchText: [
      record.name,
      record.title,
      record.context,
      typeof record.content === 'string' ? record.content.slice(0, 500) : '',
      record.notes,
      record.oneLiner,
      record.nextAction,
      record.mood,
      ...(Array.isArray(record.tags) ? record.tags : []),
      ...(Array.isArray(record.followUps) ? record.followUps : []),
    ].filter(Boolean).join(' ').toLowerCase(),
  }
  : null);
const entitySummaryIndex = createRecordIndex(projectEntitySummary);

const resolveLinkSummaries = () => resolveRecordIndex(linkSummaryIndex, 'links', 0);

/**
 * One page of links, newest-first by `createdAt`.
 *
 * Filtering, ordering, and the `total` count all come off the cached summary
 * index; only the page's own records are loaded from disk. `linkType` /
 * `isRepo` are optional and compared strictly, matching the filters the route
 * used to apply in memory.
 */
export async function getLinksPage({ linkType, isRepo, limit = 50, offset = 0 } = {}) {
  const rows = await resolveLinkSummaries();
  // The two filters guard differently ON PURPOSE, mirroring the route code this
  // replaced: `linkType` was a truthiness check (no link type is the empty
  // string, so `''` means "don't filter"), while `isRepo` must honour an
  // explicit `false` and so can only be skipped when it is genuinely absent.
  const matching = rows.filter(([, summary]) => summary
    && (!linkType || summary.linkType === linkType)
    && (isRepo === undefined || summary.isRepo === isRepo));

  // Newest-first, with the id as a deterministic tiebreak: a bulk import stamps
  // many links with the SAME createdAt, and an unstable order across two page
  // requests would drop or duplicate records at the slice boundary.
  matching.sort(([idA, a], [idB, b]) => (b.createdAtMs - a.createdAtMs) || idA.localeCompare(idB));

  const total = matching.length;
  const pageIds = matching.slice(offset, offset + limit).map(([id]) => id);
  const page = await readLinks(Promise.all(pageIds.map((id) => getById('links', id))));
  // A record deleted between the index read and the body read comes back null —
  // drop it rather than emitting a hole in the page.
  return { links: page.filter(Boolean), total };
}

/**
 * Ids of the user-visible (non-tombstoned) links, from the same summary index —
 * a membership check that parses no record bodies in steady state.
 */
export async function listLinkIds() {
  const rows = await resolveLinkSummaries();
  return rows.filter(([, summary]) => summary).map(([id]) => id);
}

/**
 * Find link by URL. Resolves the id from the summary index (no bodies) and
 * loads only the one match.
 */
export async function getLinkByUrl(url) {
  const rows = await resolveLinkSummaries();
  const hit = rows.find(([, summary]) => summary && summary.url === url);
  return hit ? readLink(getById('links', hit[0])) : null;
}

/**
 * One page of entity records (people, projects, ideas, admin, memories) with
 * stable cursor pagination, query-wide search, status filter, and compact row
 * projections for memory list items.
 */
export async function getEntityPage(type, options = {}) {
  const {
    status,
    search,
    cursor,
    limit = 25,
    offset = 0,
    includeArchived = false,
  } = options;
  const boundedLimit = Math.min(Math.max(1, limit), 100);
  const rows = await resolveRecordIndex(entitySummaryIndex, type, 0);
  const searchLower = search ? search.trim().toLowerCase() : null;

  const matching = rows.filter(([, summary]) => {
    if (!summary) return false;
    if (!includeArchived && summary.archived) return false;
    if (status && summary.status !== status) return false;
    if (searchLower && !summary.searchText.includes(searchLower)) return false;
    return true;
  });

  // Sort newest-first with id as stable tiebreak
  matching.sort(([idA, a], [idB, b]) => (b.sortKey - a.sortKey) || idA.localeCompare(idB));
  const total = matching.length;

  let remaining = matching;
  if (cursor) {
    remaining = rowsAfterCursor(matching, cursor, (s) => s.sortKey);
  } else if (offset > 0) {
    remaining = matching.slice(offset);
  }

  const pageRows = remaining.slice(0, boundedLimit);
  const pageIds = pageRows.map(([id]) => id);
  const rawPage = await Promise.all(pageIds.map((id) => getById(type, id)));
  let items = rawPage.filter(Boolean);

  if (type === 'memories') {
    items = items.map(toMemoryListItem);
  }

  const hasMore = remaining.length > boundedLimit;
  const nextCursor = hasMore && pageRows.length > 0
    ? cursorKeyOf(pageRows[pageRows.length - 1][0], pageRows[pageRows.length - 1][1].sortKey)
    : null;

  return {
    items,
    total,
    nextCursor,
  };
}

// Buckets (bookmark groups for links)
export const getBuckets = (filters) => filters ? query('buckets', filters) : getAll('buckets');
export const getBucketById = (id) => getById('buckets', id);
export const createBucket = (data) => create('buckets', data);
export const updateBucket = (id, data) => update('buckets', id, data);
// Bucket order changes are one user gesture; persist the independent records
// together and append their federation entries with one sync-log write.
export const reorderBuckets = (updates) => updateManyWithBatchLog('buckets', updates);
export const deleteBucket = (id) => remove('buckets', id);

// Threads (#7664)
//
// A thread is one tracked topic or commitment — an open loop in the bullet
// journal sense, NOT a message thread (messageSync.js owns that word too). The
// accessors are the generic store API under thread-shaped names, exactly like
// the siblings above; the ref registry that gives a thread its links lives in
// lib/threadRefKinds.js + services/threadRefs.js.
export const getThreads = (filters) => filters ? query('threads', filters) : getAll('threads');

// ─── List-row caches (songs, threads) ───────────────────────────────────────
// The Songbook and Threads list views return every record minus one heavy field
// (`content.text`, up to 200k chars; `notes`, up to 20k). Reading and parsing
// whole bodies per request just to drop that field scaled with the repertoire.
// These record indexes hold the already-stripped row, so a warm list reads no
// bodies; freshness rides the same per-record events/`record:changed`/
// `caches:invalidated` wiring as every other index above. Rows are shared:
// callers treat them as read-only.
const projectSongListRow = (record) => {
  if (!record || isTombstone(record)) return null;
  const { content, ...rest } = record;
  return { ...rest, content: { format: content?.format || 'tab' } };
};
const projectThreadListRow = (record) => {
  if (!record || isTombstone(record)) return null;
  const { notes: _notes, ...rest } = record;
  return rest;
};
const songListIndex = createRecordIndex(projectSongListRow);
const threadListIndex = createRecordIndex(projectThreadListRow);

async function resolveListRows(index, type) {
  const rows = await resolveRecordIndex(index, type, 0);
  return rows.flatMap(([id, row]) => (row ? [{ id, ...row }] : []));
}

/** Live songs without `content.text` (`content` is `{ format }`), `listIds()` order. */
export const getSongListRows = () => resolveListRows(songListIndex, 'songs');

/** Live threads without `notes`, `listIds()` order. Use `getThreadById` for the body. */
export const getThreadListRows = () => resolveListRows(threadListIndex, 'threads');
export const getThreadById = (id) => getById('threads', id);
export const createThread = (data) => create('threads', data);
export const updateThread = (id, data) => update('threads', id, data);
export const deleteThread = (id) => remove('threads', id);
/**
 * Get brain data summary (for dashboard)
 */
export async function getSummary() {
  const types = ['people', 'projects', 'ideas', 'admin', 'memories', 'buckets'];
  const [typeRows, linkRows, inboxCounts, meta] = await Promise.all([
    Promise.all(types.map((type) => resolveRecordIndex(summaryIndex, type, 0))),
    resolveLinkSummaries(),
    getInboxLogCounts(),
    loadMeta()
  ]);
  const summaries = Object.fromEntries(types.map((type, i) => [
    type,
    typeRows[i].map(([, summary]) => summary).filter(Boolean),
  ]));
  const links = linkRows.map(([, summary]) => summary).filter(Boolean);

  return {
    counts: {
      people: summaries.people.length,
      projects: summaries.projects.length,
      ideas: summaries.ideas.length,
      admin: summaries.admin.length,
      memories: summaries.memories.length,
      links: links.length,
      buckets: summaries.buckets.length,
      inbox: inboxCounts
    },
    activeProjects: summaries.projects.filter(p => p.status === 'active').length,
    activeIdeas: summaries.ideas.filter(i => !i.status || i.status === 'active').length,
    openAdmin: summaries.admin.filter(a => a.status === 'open').length,
    repos: links.filter(l => l.isRepo).length,
    needsReview: inboxCounts.needs_review,
    lastDailyDigest: meta.lastDailyDigest,
    lastWeeklyReview: meta.lastWeeklyReview
  };
}
