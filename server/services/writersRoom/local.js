/**
 * Writers Room — storage orchestration for folders, works, drafts, and exercises.
 *
 * Metadata (folders, work manifests, decomposed draft versions, exercises) is
 * persisted via the storage dispatcher (./store.js): PostgreSQL on a normal
 * install (#1017), or the legacy on-disk JSON layout under data/writers-room/
 * on the dev/test file escape hatch. The draft PROSE BODIES always stay on disk
 * as .md files (file-primary) regardless of backend — this module owns those:
 *   works/<workId>/drafts/<draftVersionId>.md
 *
 * A work manifest holds work metadata + the active-draft pointer + the version
 * history (drafts[]); store.js decomposes drafts[] into draft-version rows on
 * the PG backend and reassembles them on read, so this module's public API and
 * the manifest shape are unchanged. See docs/features/writers-room.md.
 */

import { randomUUID, createHash } from 'crypto';
import { readFile, rm } from 'fs/promises';
import { atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { countWords } from '../../lib/textUtils.js';
import { WORK_KINDS, WORK_STATUSES } from '../../lib/writersRoomPresets.js';
import { sanitizeVoiceExemplars, renderVoiceExemplars } from '../../lib/styleGuide.js';
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import { nowIso, badRequest, notFound, wrWorkDir, wrDraftPath } from './_shared.js';
import { writersRoomStore } from './store.js';
import { WRITERS_ROOM_WORK_KIND, WRITERS_ROOM_FOLDER_KIND, WRITERS_ROOM_EXERCISE_KIND } from './syncLogic.js';

const store = () => writersRoomStore();

// ---------- text analysis ----------

// `countWords` now lives in lib/textUtils.js (the canonical home it shares with
// issueLength.js). Re-exported here so existing importers of this module keep
// working unchanged. (The editorial checks keep their own copies on purpose:
// checkInfra.js uses a different alphabetic-only tokenizer, and
// letteringDensity.js is held byte-for-byte in sync with its client mirror.)
export { countWords };

export function contentHash(text) {
  return createHash('sha256').update(text || '').digest('hex');
}

/**
 * Build a segment index over Markdown-flavored prose.
 *
 * Splits on # / ## / ### headings (### collapses to scene; the outline panel
 * doesn't visually distinguish a separate "beat" tier in Phase 1). Anything
 * before the first heading becomes a "preamble" segment. No headings → one
 * "(untitled)" segment covers the whole body. Empty/missing text → empty
 * array (so a brand-new draft doesn't show a phantom segment in the outline).
 * The index powers the outline panel today and will anchor stale-analysis
 * detection in later phases.
 */
function segId(seq) {
  return `seg-${String(seq).padStart(3, '0')}`;
}

export function buildSegmentIndex(text) {
  // Whitespace-only counts as empty too — otherwise '   ' would emit a
  // phantom "(untitled)" segment in the outline panel of a brand-new draft
  // where the user has only hit space/enter a couple times.
  if (!text || !String(text).trim()) return [];
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const matches = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ index: m.index, hashes: m[1], heading: m[2].trim() });
  }
  let seq = 0;
  if (matches.length === 0) {
    return [{ id: segId(++seq), kind: 'paragraph', heading: '(untitled)', start: 0, end: text.length, wordCount: countWords(text) }];
  }
  const segments = [];
  if (matches[0].index > 0 && text.slice(0, matches[0].index).trim().length > 0) {
    segments.push({
      id: segId(++seq), kind: 'paragraph', heading: '(preamble)',
      start: 0, end: matches[0].index, wordCount: countWords(text.slice(0, matches[0].index)),
    });
  }
  matches.forEach((match, i) => {
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    segments.push({
      id: segId(++seq),
      kind: match.hashes.length === 1 ? 'chapter' : 'scene',
      heading: match.heading,
      start,
      end,
      wordCount: countWords(text.slice(start, end)),
    });
  });
  return segments;
}

// ---------- folder CRUD ----------

export async function listFolders() {
  return store().listFolders();
}

export async function createFolder({ name, parentId = null, sortOrder = 0 }) {
  if (!name || !name.trim()) throw badRequest('Folder name required');
  const folders = await store().listFolders();
  if (parentId && !folders.find((f) => f.id === parentId)) throw notFound('Parent folder');
  const folder = {
    id: `wr-folder-${randomUUID()}`,
    parentId,
    name: name.trim(),
    sortOrder,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await store().writeFolder(folder);
  // Auto-subscribe every writersRoomFolders-enabled peer so brand-new folders
  // (and their later tombstones) propagate without waiting for a reconnect (#1645).
  autoSubscribeRecordToAllPeers(WRITERS_ROOM_FOLDER_KIND, folder.id).catch(() => {});
  return folder;
}

export async function deleteFolder(id) {
  const folders = await store().listFolders();
  if (!folders.find((f) => f.id === id)) throw notFound('Folder');
  const works = await listWorks();
  if (works.some((w) => w.folderId === id)) {
    throw badRequest('Folder is not empty — move or delete its works first');
  }
  if (folders.some((f) => f.parentId === id)) {
    throw badRequest('Folder has subfolders — delete or reparent them first');
  }
  await store().deleteFolder(id);
  // Push the tombstone so subscribed peers learn of the deletion (the LWW merge
  // never propagates a hard delete — an omitted record gets resurrected) (#1645).
  emitRecordDeleted(WRITERS_ROOM_FOLDER_KIND, id);
  return { ok: true };
}

// Conflict-restore entry point (#1645) for a body-less Writers Room record
// (folder / exercise): re-apply a journaled local snapshot after a sync LWW
// overwrite. Merges only the RESTORABLE_FIELDS the resolver passes, bumps
// updatedAt so the restore wins the next LWW + re-pushes (the exercise wire
// sanitizer prefers a stored updatedAt over its finishedAt/startedAt-derived
// key), and emits so subscribed peers converge. A missing/tombstoned record
// throws notFound (→ translateGone → ERR_TARGET_GONE in the resolver). Mirrors
// moodBoard's restoreBoard.
async function restoreBodylessRecord(id, patch, { read, write, kind, fields, label }) {
  const current = await read(id, { includeDeleted: false });
  if (!current) throw notFound(label);
  const next = { ...current };
  for (const key of fields) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  next.updatedAt = nowIso();
  await write(next);
  emitRecordUpdated(kind, id);
  return next;
}

const FOLDER_RESTORABLE = ['name', 'parentId', 'sortOrder'];
export async function restoreFolder(id, patch) {
  return restoreBodylessRecord(id, patch, {
    read: (rid, opts) => store().readFolder(rid, opts),
    write: (f) => store().writeFolder(f),
    kind: WRITERS_ROOM_FOLDER_KIND, fields: FOLDER_RESTORABLE, label: 'Folder',
  });
}

// ---------- work CRUD ----------

// Manifest read/write go through the storage dispatcher (PG metadata, or the
// legacy on-disk JSON on the file escape hatch). The drafts dir is ensured on
// every save because the draft .md bodies are written there independently (the
// file backend also persists manifest.json into the work dir, and ensureDir is
// idempotent + cheap).
async function loadManifest(workId) {
  // Validate the work id (path-traversal guard) before it reaches the backend.
  wrWorkDir(workId);
  return store().readWork(workId);
}

// Announce a persisted work change to the per-record peer-sync pipeline (#1565)
// so any existing subscription pushes the new state (+ its draft-body manifest).
// Routed through the recordEvents subscription adapter (a no-op until peerSync
// registers it at boot) so this store doesn't import peerSync — peerSync
// statically imports mergeWorksFromSync from writersRoom/sync.js, so importing
// it back would close a load-order cycle. Mirrors creativeDirector/local.js.
//
// `announce: false` opts the hot-path live-mode usage-counter writes out of a
// push (they fire once per suggest call) — the bumped counter rides the next
// structural push, exactly as Creative Director's recordRun does NOT emit.
async function saveManifest(workId, manifest, { announce = true } = {}) {
  await ensureDir(`${wrWorkDir(workId)}/drafts`);
  await store().writeWork(manifest);
  if (announce) emitRecordUpdated(WRITERS_ROOM_WORK_KIND, workId);
}

// Lazy-import to break a circular dep (mediaCollections doesn't import us, but
// importing it at module-top would still be fine; the function-level import
// just keeps this helper self-contained next to its caller).
export async function ensureWorkMediaCollection(workId) {
  const manifest = await getWork(workId);
  const { getCollection, createCollection, ERR_NOT_FOUND } = await import('../mediaCollections.js');
  if (manifest.mediaCollectionId) {
    const existing = await getCollection(manifest.mediaCollectionId).catch((err) => {
      // The collection was deleted out-of-band — drop the stale id and recreate.
      if (err?.code === ERR_NOT_FOUND) return null;
      throw err;
    });
    if (existing) return existing;
  }
  const collection = await createCollection({
    name: `Writers Room: ${manifest.title}`.slice(0, 80),
    description: `Auto-generated images for "${manifest.title}"`,
  });
  await saveManifest(workId, { ...manifest, mediaCollectionId: collection.id, updatedAt: nowIso() });
  return collection;
}

export async function listWorks() {
  // The store returns full manifests (rebuilt with drafts[] on the PG backend),
  // dropping any work with a corrupted manifest on the file backend so one bad
  // work doesn't 500 the whole library.
  const manifests = await store().listWorks();
  return manifests
    .filter(Boolean)
    .map((manifest) => {
      const activeDraft = (manifest.drafts || []).find((d) => d.id === manifest.activeDraftVersionId);
      return {
        id: manifest.id,
        folderId: manifest.folderId,
        title: manifest.title,
        kind: manifest.kind,
        status: manifest.status,
        activeDraftVersionId: manifest.activeDraftVersionId,
        wordCount: activeDraft?.wordCount ?? 0,
        draftCount: (manifest.drafts || []).length,
        pipelineSeriesId: manifest.pipelineSeriesId || null,
        pipelineIssueId: manifest.pipelineIssueId || null,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      };
    })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

/**
 * How many works listWorks() would return — without rebuilding a single
 * manifest (#2729). A `COUNT(*)` on PG; the shared live-set read on the file
 * backend. Tombstones are excluded on both, exactly as listWorks filters them.
 *
 * Use this for a tally (the Wordsmith skill's engagement score) so
 * `(await listWorks()).length` — two queries plus every work's drafts[] — never
 * has to run just to produce a number.
 */
export async function countWorks() {
  return store().countWorks();
}

export async function getWork(id) {
  const manifest = await loadManifest(id);
  if (!manifest) throw notFound('Work');
  return manifest;
}

async function readDraftFile(workId, draftId) {
  return readFile(wrDraftPath(workId, draftId), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
}

export async function getWorkWithBody(id) {
  const manifest = await getWork(id);
  const activeId = manifest.activeDraftVersionId;
  if (!activeId) return { manifest, body: '' };
  return { manifest, body: await readDraftFile(id, activeId) };
}

export async function createWork({ folderId = null, title, kind = 'short-story' }) {
  if (!title || !title.trim()) throw badRequest('Work title required');
  if (!WORK_KINDS.includes(kind)) throw badRequest(`Invalid kind: ${kind}`);
  if (folderId) {
    const folders = await store().listFolders();
    if (!folders.find((f) => f.id === folderId)) throw notFound('Folder');
  }
  const id = `wr-work-${randomUUID()}`;
  const draftId = `wr-draft-${randomUUID()}`;
  const now = nowIso();
  await ensureDir(`${wrWorkDir(id)}/drafts`);
  await atomicWrite(wrDraftPath(id, draftId), '');
  const manifest = {
    id,
    folderId,
    title: title.trim(),
    kind,
    status: 'drafting',
    activeDraftVersionId: draftId,
    drafts: [
      {
        id: draftId,
        label: 'Draft 1',
        contentFile: `drafts/${draftId}.md`,
        contentHash: contentHash(''),
        wordCount: 0,
        segmentIndex: [],
        createdAt: now,
        createdFromVersionId: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await saveManifest(id, manifest);
  // Auto-subscribe every writersRoomWorks-enabled peer so brand-new works (and
  // their later tombstones) propagate without waiting for a reconnect (#1565).
  autoSubscribeRecordToAllPeers(WRITERS_ROOM_WORK_KIND, id).catch(() => {});
  return manifest;
}

// Default Phase 5 live-mode config. Stored on the manifest only once the user
// opts in; readers (the suggest path) fall back to this when the field is
// absent. `usage` is the server-tracked daily budget counter for text
// suggestions; `renderUsage` is the distinct counter for live render previews
// (renders cost materially more than text, so they get their own budget knob
// `dailyRenderBudget`). Neither counter is accepted from the client (updateWork
// strips both; only recordLiveModeUsage / recordLiveModeRenderUsage write them).
export const DEFAULT_LIVE_MODE = Object.freeze({
  enabled: false,
  debounceMs: 2500,
  dailyCallBudget: 100,
  dailyRenderBudget: 20,
  usage: Object.freeze({ date: null, count: 0 }),
  renderUsage: Object.freeze({ date: null, count: 0 }),
});

function resolveUsageCounter(stored) {
  return {
    date: typeof stored?.date === 'string' ? stored.date : null,
    count: Number.isInteger(stored?.count) ? stored.count : 0,
  };
}

export function resolveLiveMode(manifest) {
  const stored = manifest?.liveMode || {};
  return {
    enabled: stored.enabled === true,
    debounceMs: Number.isInteger(stored.debounceMs) ? stored.debounceMs : DEFAULT_LIVE_MODE.debounceMs,
    dailyCallBudget: Number.isInteger(stored.dailyCallBudget) ? stored.dailyCallBudget : DEFAULT_LIVE_MODE.dailyCallBudget,
    dailyRenderBudget: Number.isInteger(stored.dailyRenderBudget) ? stored.dailyRenderBudget : DEFAULT_LIVE_MODE.dailyRenderBudget,
    usage: resolveUsageCounter(stored.usage),
    renderUsage: resolveUsageCounter(stored.renderUsage),
  };
}

export async function updateWork(id, patch) {
  const manifest = await getWork(id);
  const allowed = ['title', 'folderId', 'kind', 'status', 'imageStyle'];
  const next = { ...manifest, updatedAt: nowIso() };
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'kind' && !WORK_KINDS.includes(patch.kind)) throw badRequest(`Invalid kind: ${patch.kind}`);
    if (key === 'status' && !WORK_STATUSES.includes(patch.status)) throw badRequest(`Invalid status: ${patch.status}`);
    next[key] = patch[key];
  }
  // liveMode is a partial merge (the UI PATCHes one knob at a time) onto the
  // resolved current config — and the client-supplied usage counters are
  // dropped so a crafted PATCH can't reset the server-side daily budgets. Only
  // the user-editable knobs flow through; both server-owned counters carry over.
  if (patch.liveMode !== undefined && patch.liveMode !== null) {
    const current = resolveLiveMode(manifest);
    const p = patch.liveMode;
    next.liveMode = {
      enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
      debounceMs: Number.isInteger(p.debounceMs) ? p.debounceMs : current.debounceMs,
      dailyCallBudget: Number.isInteger(p.dailyCallBudget) ? p.dailyCallBudget : current.dailyCallBudget,
      dailyRenderBudget: Number.isInteger(p.dailyRenderBudget) ? p.dailyRenderBudget : current.dailyRenderBudget,
      usage: current.usage,
      renderUsage: current.renderUsage,
    };
  }
  // Voice exemplars / anti-exemplars (#2179 Writers Room parity). Sanitized
  // through the SAME helper the series style guide uses (drops empty passages,
  // trims to the char caps, caps the list at 3). Key present → replace (an
  // explicit `[]` clears); key absent → carry the stored value untouched. These
  // are consumed by the live-continuation prompt and the Phase 9 polish loop's
  // revision brief so a freeform work anchors its voice the same way a series
  // does.
  if (patch.voiceExemplars !== undefined) {
    next.voiceExemplars = sanitizeVoiceExemplars(patch.voiceExemplars);
  }
  if (patch.voiceAntiExemplars !== undefined) {
    next.voiceAntiExemplars = sanitizeVoiceExemplars(patch.voiceAntiExemplars);
  }
  // Trim title and reject if it becomes empty after trim — keeps parity with
  // createWork's "title required" guard so a PATCH can't blank a title out.
  if (patch.title !== undefined) {
    const trimmed = String(patch.title ?? '').trim();
    if (!trimmed) throw badRequest('Work title required');
    next.title = trimmed;
  }
  // folderId can be set to a real folder id or to null (unfile the work).
  // Anything else would orphan it from the library tree.
  if (patch.folderId !== undefined && patch.folderId !== null) {
    const folders = await store().listFolders();
    if (!folders.find((f) => f.id === patch.folderId)) throw notFound('Folder');
  }
  await saveManifest(id, next);
  return next;
}

/**
 * Resolve a work's voice exemplars into the rendered "MATCH this voice / NEVER
 * drift toward this" prompt block (#2179 Writers Room parity), or `''` when the
 * work carries no passages. Re-sanitizes on read (defense against a hand-edited
 * manifest) and delegates to the shared styleGuide renderer so the block is
 * byte-identical to the series pipeline's. Consumed by the live-continuation
 * suggest path (liveDirector.js) and the Phase 9 polish loop (polish.js).
 */
export function renderWorkVoiceGuide(manifest) {
  return renderVoiceExemplars({
    voiceExemplars: sanitizeVoiceExemplars(manifest?.voiceExemplars),
    voiceAntiExemplars: sanitizeVoiceExemplars(manifest?.voiceAntiExemplars),
  });
}

/**
 * Bidirectional bridge link: record that this work was promoted to a pipeline
 * series + first issue. Set once by `promoteToPipeline`; the WR side reads it
 * to render the "Open in pipeline" CTA on the work detail page. Distinct from
 * `updateWork` because the link isn't user-editable. Pass `null` to unlink.
 */
export async function linkToPipeline(id, { seriesId = null, issueId = null } = {}) {
  const manifest = await getWork(id);
  const next = {
    ...manifest,
    pipelineSeriesId: seriesId ? String(seriesId).slice(0, 64) : null,
    pipelineIssueId: issueId ? String(issueId).slice(0, 64) : null,
    updatedAt: nowIso(),
  };
  await saveManifest(id, next);
  return next;
}

/**
 * Bidirectional bridge link: record that this work seeded a Creative Director
 * project (Phase 5 CD-bridge slice). Set once by liveDirector.sendToCreativeDirector;
 * the WR side reads it to render the "Open in Creative Director" CTA on the work
 * detail page. Distinct from `updateWork` because the link isn't user-editable
 * (the allow-list in updateWork excludes it, so a crafted PATCH can't set it).
 * Mirrors `linkToPipeline`. Pass `null` to unlink.
 */
export async function linkToCreativeDirector(id, { projectId = null } = {}) {
  const manifest = await getWork(id);
  const next = {
    ...manifest,
    cdProjectId: projectId ? String(projectId).slice(0, 64) : null,
    updatedAt: nowIso(),
  };
  await saveManifest(id, next);
  return next;
}

// UTC day key (YYYY-MM-DD) for the daily budget window. UTC (not local) so the
// reset boundary is deterministic across machines a single user federates.
// Exported so the live-director's pre-call budget check compares against the
// same boundary recordLiveModeUsage rolls over on.
export function utcDayKey() {
  return nowIso().slice(0, 10);
}

/**
 * Bump the live-mode daily usage counter for a work, rolling over to a fresh
 * count when the stored date is not today (UTC). Set once per successful
 * suggest call by the live-director path — distinct from `updateWork` because
 * the counter is server-owned, not user-editable. Returns the resolved live
 * config with the new usage so the caller can echo remaining budget.
 */
export async function recordLiveModeUsage(id) {
  const manifest = await getWork(id);
  const live = resolveLiveMode(manifest);
  const today = utcDayKey();
  const count = live.usage.date === today ? live.usage.count + 1 : 1;
  const nextLive = { ...live, usage: { date: today, count } };
  // Do NOT bump updatedAt: this counter is a local-only daily budget (never
  // announced, #1565). updatedAt is the federation LWW key, so advancing it here
  // would let a local counter bump on one peer win LWW over a real manuscript
  // edit pushed from another — silently dropping the edit. Preserving updatedAt
  // keeps the counter local without disturbing the merge order.
  await saveManifest(id, { ...manifest, liveMode: nextLive }, { announce: false });
  return nextLive;
}

/**
 * Bump the live-mode daily RENDER usage counter for a work, rolling over to a
 * fresh count on a new UTC day. Distinct from `recordLiveModeUsage` because
 * render previews carry a different cost profile and their own budget knob
 * (`dailyRenderBudget`). Set once per reserved render-preview by the
 * live-director path. Returns the resolved live config with the new
 * `renderUsage` so the caller can echo remaining render budget.
 */
export async function recordLiveModeRenderUsage(id) {
  const manifest = await getWork(id);
  const live = resolveLiveMode(manifest);
  const today = utcDayKey();
  const count = live.renderUsage.date === today ? live.renderUsage.count + 1 : 1;
  const nextLive = { ...live, renderUsage: { date: today, count } };
  // Same as recordLiveModeUsage above: a local-only render-budget bump must not
  // advance the federation LWW key (updatedAt) and risk dropping a peer's edit.
  await saveManifest(id, { ...manifest, liveMode: nextLive }, { announce: false });
  return nextLive;
}

export async function deleteWork(id) {
  // 404 the caller if the manifest is missing; rm() with force:true would
  // silently succeed on a non-existent dir and the user gets no signal.
  // Tolerate CORRUPTED_MANIFEST so a user can recover from on-disk corruption
  // by deleting the work via the API/UI instead of resorting to `rm -rf`.
  let corrupt = false;
  await getWork(id).catch((err) => {
    if (err?.code === 'CORRUPTED_MANIFEST') {
      console.warn(`⚠️  wr: deleting work ${id} despite corrupted manifest`);
      corrupt = true;
      return;
    }
    throw err;
  });
  if (corrupt) {
    // A tombstone needs a parseable manifest to soft-delete + federate, but a
    // corrupt manifest can't be sanitized for the wire anyway (sanitizeWorkForSync
    // would drop it), so it was never syncable. Hard-remove the dir so the API's
    // "delete a broken work to recover" path still works (the soft-delete store
    // call would otherwise no-op on the unreadable manifest and strand it).
    await rm(wrWorkDir(id), { recursive: true, force: true });
    return { ok: true };
  }
  // Soft-delete tombstone (#1565) so the deletion federates and an out-of-date
  // peer can't resurrect the work via the LWW merge. The work row/manifest + its
  // draft rows + the on-disk .md bodies all stay until tombstone GC hard-prunes
  // them (sync.js pruneTombstonedWorks). The record drops out of every user-facing
  // read immediately (readWork/listWorks filter `deleted`).
  await store().deleteWork(id);
  // Push the tombstone to subscribed peers immediately.
  emitRecordDeleted(WRITERS_ROOM_WORK_KIND, id);
  return { ok: true };
}

// ---------- draft body / version snapshots ----------

function buildDraftMeta(text, base = {}) {
  return {
    ...base,
    contentHash: contentHash(text),
    wordCount: countWords(text),
    segmentIndex: buildSegmentIndex(text),
  };
}

export async function saveDraftBody(workId, body, { referencedIngredientIds } = {}) {
  const manifest = await getWork(workId);
  const activeId = manifest.activeDraftVersionId;
  if (!activeId) throw badRequest('Work has no active draft');
  const text = String(body ?? '');
  await atomicWrite(wrDraftPath(workId, activeId), text);
  const draftIdx = manifest.drafts.findIndex((d) => d.id === activeId);
  if (draftIdx < 0) throw notFound('Active draft');
  const meta = buildDraftMeta(text, manifest.drafts[draftIdx]);
  // Distinguish "caller omitted the field" (preserve the existing snapshot of
  // referenced ids) from "caller passed an empty array" (the prose no longer
  // mentions any linked ingredient — clear it). An absent field must NOT wipe
  // a previously-computed reference list.
  if (Array.isArray(referencedIngredientIds)) {
    meta.referencedIngredientIds = referencedIngredientIds;
  }
  manifest.drafts[draftIdx] = meta;
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  console.log(`📝 wr: saved draft ${activeId.slice(0, 14)}… (${manifest.drafts[draftIdx].wordCount} words)`);
  return { manifest, body: text };
}

export async function snapshotDraft(workId, { label } = {}) {
  const { manifest, body } = await getWorkWithBody(workId);
  const newDraftId = `wr-draft-${randomUUID()}`;
  const fromId = manifest.activeDraftVersionId;
  const fromDraft = manifest.drafts.find((d) => d.id === fromId);
  const draftLabel = label || `Draft ${manifest.drafts.length + 1}`;
  await atomicWrite(wrDraftPath(workId, newDraftId), body);
  // The new draft copies the source's body verbatim, so carry its referenced
  // ingredient ids forward — otherwise the freshly-snapshotted version would
  // render no chips (despite identical prose) until the next save re-scans.
  manifest.drafts.push(buildDraftMeta(body, {
    id: newDraftId,
    label: draftLabel,
    contentFile: `drafts/${newDraftId}.md`,
    createdAt: nowIso(),
    createdFromVersionId: fromId,
    ...(Array.isArray(fromDraft?.referencedIngredientIds)
      ? { referencedIngredientIds: fromDraft.referencedIngredientIds }
      : {}),
  }));
  manifest.activeDraftVersionId = newDraftId;
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  console.log(`📚 wr: snapshot ${draftLabel} for ${manifest.title}`);
  return manifest;
}

export async function setActiveDraft(workId, draftId) {
  const manifest = await getWork(workId);
  if (!manifest.drafts.find((d) => d.id === draftId)) throw notFound('Draft version');
  manifest.activeDraftVersionId = draftId;
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  return manifest;
}

export async function getDraftBody(workId, draftId) {
  const manifest = await getWork(workId);
  if (!manifest.drafts.find((d) => d.id === draftId)) throw notFound('Draft version');
  return readDraftFile(workId, draftId);
}

// ---------- exercise sessions ----------

export async function listExercises({ workId } = {}) {
  const all = await store().listExercises();
  const filtered = workId ? all.filter((e) => e.workId === workId) : all;
  return filtered.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

function settled(exercise) {
  return exercise.status === 'finished' || exercise.status === 'discarded';
}

export async function createExercise({ workId = null, prompt = '', durationSeconds = 600, startingWords = 0 }) {
  if (workId) await getWork(workId); // 404 if missing
  const exercise = {
    id: `wr-ex-${randomUUID()}`,
    workId,
    prompt: String(prompt || '').trim(),
    durationSeconds: Math.max(60, Math.min(durationSeconds, 60 * 60)),
    startingWords,
    endingWords: null,
    wordsAdded: null,
    appendedText: null,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    updatedAt: nowIso(),
  };
  await store().writeExercise(exercise);
  // Auto-subscribe every writersRoomExercises-enabled peer so brand-new sprints
  // propagate; later finish/discard transitions ride emitRecordUpdated (#1645).
  autoSubscribeRecordToAllPeers(WRITERS_ROOM_EXERCISE_KIND, exercise.id).catch(() => {});
  return exercise;
}

export async function finishExercise(id, { endingWords, appendedText = null } = {}) {
  const all = await store().listExercises();
  const existing = all.find((e) => e.id === id);
  if (!existing) throw notFound('Exercise');
  if (settled(existing)) throw badRequest('Exercise is already settled');
  // Default missing endingWords to startingWords so wordsAdded never goes
  // negative when the caller forgets to send it; clamp the delta as a final
  // backstop for the case where the user backspaces past their starting count.
  const startingWords = existing.startingWords || 0;
  const resolvedEnding = endingWords ?? startingWords;
  const wordsAdded = Math.max(0, resolvedEnding - startingWords);
  const now = nowIso();
  const finished = {
    ...existing,
    endingWords: resolvedEnding,
    wordsAdded,
    appendedText: appendedText ?? null,
    status: 'finished',
    finishedAt: now,
    updatedAt: now,
  };
  await store().writeExercise(finished);
  // The settle transition stamps a fresh updatedAt (the LWW key) — push it so
  // subscribed peers converge on the finished state. updatedAt must be bumped
  // explicitly (not left to the finishedAt-derived fallback): a sync-seeded
  // exercise already carries a stored updatedAt the sanitizer would otherwise
  // prefer over the new finishedAt, so the finish wouldn't advance the key (#1645).
  emitRecordUpdated(WRITERS_ROOM_EXERCISE_KIND, id);
  return finished;
}

export async function discardExercise(id) {
  const all = await store().listExercises();
  const existing = all.find((e) => e.id === id);
  if (!existing) throw notFound('Exercise');
  if (settled(existing)) throw badRequest('Exercise is already settled');
  const now = nowIso();
  const discarded = { ...existing, status: 'discarded', finishedAt: now, updatedAt: now };
  await store().writeExercise(discarded);
  emitRecordUpdated(WRITERS_ROOM_EXERCISE_KIND, id);
  return discarded;
}

// Conflict-restore for an exercise sprint — see restoreBodylessRecord above.
const EXERCISE_RESTORABLE = ['workId', 'prompt', 'durationSeconds', 'startingWords', 'endingWords', 'wordsAdded', 'appendedText', 'status', 'finishedAt'];
export async function restoreExercise(id, patch) {
  return restoreBodylessRecord(id, patch, {
    read: (rid, opts) => store().readExercise(rid, opts),
    write: (e) => store().writeExercise(e),
    kind: WRITERS_ROOM_EXERCISE_KIND, fields: EXERCISE_RESTORABLE, label: 'Exercise',
  });
}
