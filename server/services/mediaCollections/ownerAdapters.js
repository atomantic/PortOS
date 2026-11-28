/** Resolve, provision, rename and unlink owner-managed media collections. */

import {
  NAME_MAX_LENGTH, ERR_VALIDATION, DESCRIPTION_MAX_LENGTH, UNIVERSE_ID_MAX, store,
  announceNewCollection, SERIES_ID_MAX, assertCollectionId,
} from './collectionStore.js';
import { codedError } from '../../lib/codedError.js';
import { randomUUID } from 'crypto';
import { updateCollection } from './collectionEdits.js';

// Find an existing collection by case-insensitive trimmed name, else create
// a fresh one. The non-universe-aware upsert — used by user-driven flows
// where the bucket is identified by visible name (e.g. tests, ad-hoc CLI
// scripts).
//
// **Universe-owned paths must use `findOrCreateUniverseCollection`.**
// This helper is name-first and will return any same-name collection,
// including one already linked to a different universe, so it can route
// renders into the wrong bucket when two universes share a display name.
// The legacy `universeId` parameter remains for callers that need the
// best-effort backfill of an unlinked legacy bucket, but new code should
// prefer the universeId-first helper.
//
// Records this mints are stamped `source: 'auto'` (#3311) like the other
// provisioners: reaching this helper means a script or hook asked for a bucket,
// which is not the same as a person creating one in the UI (that path is
// `createCollection`, which defaults to `'user'`).
export async function findOrCreateCollectionByName({ name, description = '', universeId = null }) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > NAME_MAX_LENGTH) {
    throw codedError('Collection name is required (1..' + NAME_MAX_LENGTH + ' chars)', ERR_VALIDATION);
  }
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  // Normalize the universe id (trim whitespace, then cap length) so the
  // presence guard and the stored/derived value operate on the SAME string —
  // a padded id can't yield `uc- u1 ` while the guard saw a non-empty value.
  // Whitespace-only is treated as "no universe". Keeps the derived deterministic
  // id under the peer-sync id length cap.
  const normalizedUniverseId = typeof universeId === 'string' && universeId.trim()
    ? universeId.trim().slice(0, UNIVERSE_ID_MAX)
    : null;
  // Deterministic id when universe-linked (cross-machine convergence); a fresh
  // random id otherwise. Queue on whichever id this call would create/adopt so
  // two concurrent calls for the same universe serialize on the same record.
  // NOTE: the no-universe branch queues on a random id, so two concurrent calls
  // for the same NAME do NOT serialize and could both create a same-named
  // bucket. Acceptable: this name-first helper has no production callers (it's
  // the ad-hoc/CLI path); universe/series filing uses the deterministic-id
  // helpers, which converge. A hot caller should derive a stable queue key.
  const canonId = linkedCollectionId({ universeId: normalizedUniverseId });
  const queueId = canonId || randomUUID();
  let createdId = null;
  const result = await store().queueRecordWrite(queueId, async () => {
    const all = await store().loadAll();
    const needle = trimmed.toLowerCase();
    // Do not match (or reuse) tombstoned records — a deleted collection
    // should not be resurrected by name.
    const existing = all.find((c) => !c.deleted && c.name.toLowerCase() === needle);
    if (existing) {
      if (normalizedUniverseId && !existing.universeId) {
        // Lazy backfill so legacy "Universe: <name>" collections gain the link
        // the first time a universe-builder render references them. Adopt the
        // DETERMINISTIC id at the same time — keeping the old random id would
        // leave a universe-linked collection that can't converge across peers
        // (the very bug deterministic ids fix).
        //
        // If the universe ALREADY has its canonical collection, don't promote a
        // same-named orphan over it (that would clobber the canonical record's
        // items) — return the canonical one; the orphan is a duplicate the merge
        // / migration 038 reconciles.
        const liveCanonical = all.find((c) => c.id === canonId && !c.deleted);
        if (liveCanonical) return liveCanonical;
        // No live canonical — rename the orphan to the deterministic id,
        // reclaiming a tombstone at that id if one exists (saveOneNow overwrites
        // the canonId record), then drop the old random-id record.
        const linked = { ...existing, id: canonId, universeId: normalizedUniverseId, updatedAt: new Date().toISOString() };
        await store().saveOneNow(canonId, linked);
        if (canonId !== existing.id) {
          await store().deleteOneNow(existing.id);
          createdId = canonId; // announce the newly-linked record
        }
        return linked;
      }
      return existing;
    }
    const now = new Date().toISOString();
    const next = {
      id: queueId,
      name: trimmed,
      description: trimmedDescription,
      coverKey: null,
      universeId: normalizedUniverseId,
      // Programmatic provisioner — see the docstring above (#3311).
      source: 'auto',
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    createdId = next.id;
    // saveOneNow overwrites any tombstone already at this deterministic id
    // (re-creating a previously-deleted universe/series collection).
    await store().saveOneNow(next.id, next);
    return next;
  });
  if (createdId) announceNewCollection(createdId);
  return result;
}

// Naming convention for the auto-managed universe collection. Single source
// of truth so the upsert path, the rename cascade (updateUniverse), and any
// caller that needs to display the name stay aligned. Truncated to
// NAME_MAX_LENGTH because long universe names would otherwise overflow
// sanitizeCollection's slice and silently mismatch.
export const universeCollectionNameFor = (universeName) =>
  `Universe: ${typeof universeName === 'string' ? universeName : ''}`.slice(0, NAME_MAX_LENGTH);

// Deterministic id for a universe/series-LINKED collection. Every federated
// machine derives the SAME id from the same universe/series id — so per-record
// collection sync (which keys on `id`) treats both machines' copies as ONE
// record and converges, instead of each minting a random UUID and duplicating
// the collection on every peer. Standalone (unlinked) collections keep a random
// id — they have no stable cross-machine identity. Migration 038 canonicalizes
// existing linked-collection ids to this scheme. Mirror any change here in that
// migration. `uc-`/`sc-` prefixes keep linked ids visually distinct from the
// random UUIDs of standalone collections. The owner id is sliced to the same cap
// storage uses so the derived id is bounded by construction — callers can pass a
// raw owner id without first slicing it and still converge on the canonical id
// (and stay under the peer-sync id length cap).
export const linkedCollectionId = ({ universeId = null, seriesId = null } = {}) => {
  if (universeId) return `uc-${String(universeId).slice(0, UNIVERSE_ID_MAX)}`;
  if (seriesId) return `sc-${String(seriesId).slice(0, SERIES_ID_MAX)}`;
  return null;
};

// Resolve the live collection linked to `rawValue` on `field` ('universeId' or
// 'seriesId'). Field-parameterized like clearOwnerLink / renameOwnerLinked so
// the universe and series variants can't drift.
//
// Fast path: any collection provisioned after migration 038 lives at the
// deterministic `uc-`/`sc-<id>` id, so one loadOne resolves the warm case in
// O(1) — the hot path peerSync drives on every outbound push. Only fall
// through to the full scan when that record is absent, tombstoned, or its
// stamp doesn't match — that's a legacy/unconverged collection carrying the
// link at a random id. Tombstones are excluded so "deleted" reads as gone
// (matching listCollections and the upsert provisioners' adopt rule). Returns
// null when nothing is linked; callers provision via findOrCreate*.
async function findLinkedCollection(field, rawValue, maxLen) {
  if (typeof rawValue !== 'string' || !rawValue) return null;
  const needle = rawValue.slice(0, maxLen);
  const canon = await store().loadOne(linkedCollectionId({ [field]: needle }));
  if (canon && !canon.deleted && canon[field] === needle) return canon;
  const all = await store().loadAll();
  return all.find((c) => !c.deleted && c[field] === needle) || null;
}

// Look up an existing collection by its universeId stamp. Returns null if no
// collection has ever been linked to this universe — callers fall back to
// `findOrCreateUniverseCollection` (the universeId-first upsert) to provision
// on first use. Do NOT fall back to `findOrCreateCollectionByName` here —
// that path is name-first and would adopt a same-named foreign-universe
// bucket. The argument is sliced to the same limit storage uses so passing
// an overlong id (e.g. from a malformed share manifest) matches whatever
// the upsert helper would have persisted.
export async function findCollectionByUniverseId(universeId) {
  return findLinkedCollection('universeId', universeId, UNIVERSE_ID_MAX);
}

/**
 * Atomic universeId-first upsert for a universe's auto-managed collection.
 *
 * Resolution order (serialized on the deterministic id's per-record queue):
 *   1. universeId stamp wins. Returned as-is — the caller's `universeName`
 *      can be stale (it was a snapshot taken before this call entered the
 *      queue), so reconciling the name here could ping-pong a fresh
 *      cascade rename back to an old name. `renameCollectionForUniverse`
 *      is the canonical path for name changes; if its best-effort cascade
 *      fails, the surviving stale name is acceptable until the user
 *      retriggers it (the lock blocks `updateCollection` but the cascade
 *      itself is unrestricted).
 *   2. Otherwise a fresh collection is created and stamped with `universeId`,
 *      even when the canonical name is already taken by another collection
 *      (a different universe's bucket, OR a previously-unlinked orphan from
 *      a deleted universe). Adopting either would silently mix renders
 *      across universes; two same-named collections is the user-correctable
 *      case.
 *
 * Callers (pipeline cover filer, Universe Builder render route) all funnel
 * through this so the universe → collection identity stays consistent across
 * both auto-filing and explicit-render paths.
 */
export async function findOrCreateUniverseCollection({ universeId, universeName, description = '' }) {
  if (!universeId || typeof universeId !== 'string') {
    throw codedError('universeId is required', ERR_VALIDATION);
  }
  if (typeof universeName !== 'string' || !universeName.trim()) {
    throw codedError('universeName is required', ERR_VALIDATION);
  }
  // Normalize the universeId once so lookup and storage both key on the
  // same string. Without this, an overlong id (e.g. from a malformed
  // share manifest) would not match the row it just created — the lookup
  // compares the raw value but persistence sliced — and retries would
  // pile up duplicate stamped collections.
  const normalizedUniverseId = universeId.slice(0, UNIVERSE_ID_MAX);
  const desiredName = universeCollectionNameFor(universeName);
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  // Deterministic id so this universe's collection has the SAME id on every
  // peer (per-record sync keys on id) — see linkedCollectionId. Queue on it so
  // two concurrent provisions for the same universe serialize.
  const id = linkedCollectionId({ universeId: normalizedUniverseId });
  let createdId = null;
  const result = await store().queueRecordWrite(id, async () => {
    // Resolve any existing linked collection via the deterministic-id fast path
    // (warm) with a full-scan fallback for a legacy unconverged record at a
    // random id — never adopting a tombstone (deleted means gone, re-create
    // below). Same lookup the read-only finder uses, so they can't drift.
    const linked = await findLinkedCollection('universeId', normalizedUniverseId, UNIVERSE_ID_MAX);
    if (linked) return linked;
    // No universeId match — always create fresh. The runtime intentionally
    // does NOT adopt a same-named unlinked collection here: it can't tell
    // a true pre-link legacy bucket apart from a post-`deleteUniverse`
    // orphan, and adopting the orphan would silently mix the deleted
    // universe's renders into the new same-named universe.
    //
    // Upgrade path for pre-link installs: migration 021
    // (`scripts/migrations/021-link-orphan-universe-collections.js`) does
    // a one-shot name-match link at boot — safe because at install/upgrade
    // time the orphan case doesn't exist yet. New collisions after the
    // migration belong to "ambiguous, leave it" rather than "auto-adopt."
    const now = new Date().toISOString();
    const next = {
      id,
      name: desiredName,
      description: trimmedDescription,
      coverKey: null,
      universeId: normalizedUniverseId,
      // Machine-provisioned render bucket — never a user-made collection (#3311).
      source: 'auto',
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    createdId = next.id;
    // saveOneNow overwrites any tombstone already at this deterministic id
    // (re-creating a previously-deleted universe collection).
    await store().saveOneNow(next.id, next);
    return next;
  });
  // Announce only when a NEW record was persisted (not a find-existing hit), so
  // a mediaCollections-enabled peer receives universe-linked collections even
  // with universe sync off.
  if (createdId) announceNewCollection(createdId);
  return result;
}

// Series-side mirror of the universe collection helpers above
// (`universeCollectionNameFor`, `findCollectionByUniverseId`,
// `findOrCreateUniverseCollection`, `unlinkCollectionsForUniverse`,
// `renameCollectionForUniverse`). Same resolution-order + orphan-avoidance
// rules — see those functions' docstrings for the rationale.
export const seriesCollectionNameFor = (seriesName) =>
  `Series: ${typeof seriesName === 'string' ? seriesName : ''}`.slice(0, NAME_MAX_LENGTH);

export async function findCollectionBySeriesId(seriesId) {
  return findLinkedCollection('seriesId', seriesId, SERIES_ID_MAX);
}

export async function findOrCreateSeriesCollection({ seriesId, seriesName, description = '' }) {
  if (!seriesId || typeof seriesId !== 'string') {
    throw codedError('seriesId is required', ERR_VALIDATION);
  }
  if (typeof seriesName !== 'string' || !seriesName.trim()) {
    throw codedError('seriesName is required', ERR_VALIDATION);
  }
  const normalizedSeriesId = seriesId.slice(0, SERIES_ID_MAX);
  const desiredName = seriesCollectionNameFor(seriesName);
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  // Deterministic id — same series collection id on every peer (see linkedCollectionId).
  const id = linkedCollectionId({ seriesId: normalizedSeriesId });
  let createdId = null;
  const result = await store().queueRecordWrite(id, async () => {
    // Deterministic-id fast path + full-scan fallback for a legacy unconverged
    // record; never adopts a tombstone. Shared with the read-only finder.
    const linked = await findLinkedCollection('seriesId', normalizedSeriesId, SERIES_ID_MAX);
    if (linked) return linked;
    const now = new Date().toISOString();
    const next = {
      id,
      name: desiredName,
      description: trimmedDescription,
      coverKey: null,
      seriesId: normalizedSeriesId,
      // Machine-provisioned render bucket — never a user-made collection (#3311).
      source: 'auto',
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    createdId = next.id;
    // saveOneNow overwrites any tombstone already at this deterministic id
    // (re-creating a previously-deleted series collection).
    await store().saveOneNow(next.id, next);
    return next;
  });
  if (createdId) announceNewCollection(createdId);
  return result;
}

// A music video's own collection (one per project): every still and clip
// generated for it, kept findable after a shot drops them. The id is derived
// from the project id, so the same project converges on one collection on
// every peer and no owner stamp is needed.
const MUSIC_VIDEO_ID_MAX = 100;
export const musicVideoCollectionId = (projectId) => `mvc-${String(projectId).slice(0, MUSIC_VIDEO_ID_MAX)}`;
export const musicVideoCollectionNameFor = (projectName) =>
  `Music video: ${typeof projectName === 'string' && projectName.trim() ? projectName.trim() : 'Untitled'}`.slice(0, NAME_MAX_LENGTH);

export const findOrCreateMusicVideoCollection = async ({ projectId, projectName }) => {
  if (!projectId || typeof projectId !== 'string') throw codedError('projectId is required', ERR_VALIDATION);
  return findOrCreateFixedCollection(musicVideoCollectionId(projectId), {
    name: musicVideoCollectionNameFor(projectName),
    description: 'Every still and clip generated for this music video.',
  });
};

// The "External" collection: everything downloaded from outside (Video
// Downloader, Mood Board Pinterest / X / URL imports). A fixed id so every
// peer converges on one bucket instead of minting a same-named copy each.
export const EXTERNAL_COLLECTION_ID = 'external';
export const findOrCreateExternalCollection = () => findOrCreateFixedCollection(EXTERNAL_COLLECTION_ID, {
  name: 'External',
  description: 'Images and videos downloaded from outside sources (Video Downloader, Mood Board imports).',
});

// A mood board's own collection: every image generated for the board, named
// exactly like the board. Deterministic id so peers converge on one bucket.
export const moodBoardCollectionId = (boardId) => `mbc-${String(boardId).slice(0, MUSIC_VIDEO_ID_MAX)}`;
const moodBoardCollectionName = (boardName) =>
  (typeof boardName === 'string' && boardName.trim() ? boardName.trim() : 'Untitled mood board').slice(0, NAME_MAX_LENGTH);

/** Find or create the board's collection, re-syncing its name to the board's current name. */
export async function findOrCreateMoodBoardCollection({ boardId, boardName }) {
  if (!boardId || typeof boardId !== 'string') throw codedError('boardId is required', ERR_VALIDATION);
  const name = moodBoardCollectionName(boardName);
  const collection = await findOrCreateFixedCollection(moodBoardCollectionId(boardId), {
    name,
    description: 'Every image generated for this mood board.',
  });
  return collection.name === name ? collection : updateCollection(collection.id, { name });
}

// Project ids keep equally named decks separate and converge across peers.
export async function findOrCreateDeckCollection({ deckId, deckName }) {
  const name = `Deck: ${deckName}`.slice(0, NAME_MAX_LENGTH);
  const collection = await findOrCreateFixedCollection(`deck-${deckId}`, {
    name,
    description: 'Images generated for this deck.',
  });
  return collection.name === name ? collection : updateCollection(collection.id, { name });
}

// One collection per Creative Commission: every scheduled run of the same job
// files into it instead of minting a dated bucket per fire. The id derives
// from the commission id so peers converge on one bucket.
export const commissionCollectionId = (commissionId) => `cdc-${String(commissionId).slice(0, MUSIC_VIDEO_ID_MAX)}`;
export const commissionCollectionNameFor = (commissionName) =>
  `Creative Director: ${typeof commissionName === 'string' && commissionName.trim() ? commissionName.trim() : 'Untitled job'}`.slice(0, NAME_MAX_LENGTH);

export async function findOrCreateCommissionCollection({ commissionId, commissionName }) {
  if (!commissionId || typeof commissionId !== 'string') throw codedError('commissionId is required', ERR_VALIDATION);
  const name = commissionCollectionNameFor(commissionName);
  const collection = await findOrCreateFixedCollection(commissionCollectionId(commissionId), {
    name,
    description: 'Every render from this Creative Director job.',
  });
  return collection.name === name ? collection : updateCollection(collection.id, { name });
}

// Catalog record types get one library-wide collection each, so every cast
// portrait, environment plate and object reference is findable by kind.
export const CATALOG_TYPE_COLLECTIONS = Object.freeze({
  character: { id: 'catalog-cast', name: 'Cast', description: 'Portraits and references of every catalog cast member.' },
  place: { id: 'catalog-environments', name: 'Environments', description: 'References of every catalog environment.' },
  object: { id: 'catalog-objects', name: 'Objects', description: 'References of every catalog object.' },
});

export function findOrCreateCatalogTypeCollection(type) {
  const spec = CATALOG_TYPE_COLLECTIONS[type];
  if (!spec) throw codedError(`No collection for catalog type: ${type}`, ERR_VALIDATION);
  return findOrCreateFixedCollection(spec.id, spec);
}

export const findOrCreateStoryboardCollection = ({ id, name }) => findOrCreateFixedCollection(`storyboard-${id}`, {
  name: `Storyboard: ${name}`.slice(0, NAME_MAX_LENGTH),
  description: 'Images generated for this storyboard.',
});

export const findOrCreateFableLoomCollection = ({ id, name }) => findOrCreateFixedCollection(`fable-loom-${id}`, {
  name: `Fable Loom: ${name}`.slice(0, NAME_MAX_LENGTH),
  description: 'Images and clips generated for this Fable Loom.',
});

export const findOrCreateTimelineCollection = ({ id, name }) => findOrCreateFixedCollection(`timeline-${id}`, {
  name: `Timeline: ${name}`.slice(0, NAME_MAX_LENGTH),
  description: 'Videos exported from this timeline.',
});

export const findOrCreateSpriteCollection = ({ id, name }) => findOrCreateFixedCollection(`sprite-${id}`, {
  name: `Sprite: ${name}`.slice(0, NAME_MAX_LENGTH),
  description: 'Generated reference images for this sprite.',
});

// The Avatars collection: portraits voice agents wear on the Voice Call
// transceiver channels. A fixed id so every peer converges on one bucket, and
// the collection's federation (records plus image bytes) shares avatars.
export const AVATAR_COLLECTION_ID = 'avatars';
export const findOrCreateAvatarCollection = () => findOrCreateFixedCollection(AVATAR_COLLECTION_ID, {
  name: 'Avatars',
  description: 'Portraits for voice agents, assignable to Voice Call transceiver channels.',
});

export const findOrCreateCompositionsCollection = () => findOrCreateFixedCollection('compositions', {
  name: 'Compositions',
  description: 'Videos exported from HTML compositions and Code Animation.',
});

// Find a collection by its deterministic id, or create it. A tombstone at the
// id is overwritten (re-creating a deleted auto bucket on next use).
async function findOrCreateFixedCollection(id, { name, description }) {
  assertCollectionId(id);
  let createdId = null;
  const result = await store().queueRecordWrite(id, async () => {
    const current = await store().loadOne(id);
    if (current && !current.deleted) return current;
    const now = new Date().toISOString();
    const next = { id, name, description, coverKey: null, source: 'auto', items: [], createdAt: now, updatedAt: now };
    createdId = id;
    await store().saveOneNow(id, next);
    return next;
  });
  if (createdId) announceNewCollection(createdId);
  return result;
}

// Both cascade families below — unlink (clear the owner link) and rename
// (cascade the owner's display name) — share the same shape: scan all records
// by their owner stamp, then per-match queue a load→re-check→save. The
// re-check inside the queue (`cur[field] !== needle`) is the concurrency-safety
// invariant now that there's no single file lock spanning the whole sweep —
// keep it in these two helpers so the universe/series variants can't drift.

// Clear an owner-link field (`universeId` / `seriesId`) on every collection
// stamped with `needle`. Returns the cleared ids. Deliberately does NOT bump
// `updatedAt` — see `unlinkCollectionsForUniverse`'s note.
async function clearOwnerLink(field, rawValue, maxLen) {
  if (typeof rawValue !== 'string' || !rawValue) return [];
  const needle = rawValue.slice(0, maxLen);
  const matches = (await store().loadAll()).filter((c) => c[field] === needle);
  const clearedIds = [];
  for (const c of matches) {
    await store().queueRecordWrite(c.id, async () => {
      const cur = await store().loadOne(c.id);
      if (!cur || cur[field] !== needle) return;
      await store().saveOneNow(c.id, { ...cur, [field]: null });
    });
    clearedIds.push(c.id);
  }
  return clearedIds;
}

// Cascade an owner rename onto EVERY collection stamped with `needle` (not just
// the first match — hand-edited state or a pre-serialization race could leave
// duplicate linked rows that would otherwise stay rename-locked under the stale
// name). Returns the first updated collection (back-compat).
async function renameOwnerLinked(field, rawValue, maxLen, nameFor, newOwnerName) {
  if (typeof rawValue !== 'string' || !rawValue) return null;
  const needle = rawValue.slice(0, maxLen);
  const matches = (await store().loadAll()).filter((c) => c[field] === needle);
  if (!matches.length) return null;
  const desired = nameFor(newOwnerName);
  if (!desired) return matches[0];
  const now = new Date().toISOString();
  let first = null;
  for (const c of matches) {
    const updated = await store().queueRecordWrite(c.id, async () => {
      const cur = await store().loadOne(c.id);
      if (!cur || cur[field] !== needle || cur.name === desired) return cur;
      const nextRec = { ...cur, name: desired, updatedAt: now };
      await store().saveOneNow(c.id, nextRec);
      return nextRec;
    });
    if (first === null) first = updated;
  }
  return first;
}

// Series mirror of `unlinkCollectionsForUniverse` — same cascade semantics,
// same reason for preserving `updatedAt`. A series merge tombstones the loser
// series-collection and the loser series; the series-tombstone cascade must not
// bump the collection past its own tombstone.
export const unlinkCollectionsForSeries = (seriesId) =>
  clearOwnerLink('seriesId', seriesId, SERIES_ID_MAX);

export const renameCollectionForSeries = (seriesId, newSeriesName) =>
  renameOwnerLinked('seriesId', seriesId, SERIES_ID_MAX, seriesCollectionNameFor, newSeriesName);

// Clear the `universeId` link on any collection bound to this universe.
// Used by deleteUniverse to release the rename-lock so the orphaned bucket
// becomes a normal user-owned collection (renamable, deletable, etc.). The
// items themselves are preserved — the user may still want the renders.
// Returns the list of unlinked collection ids (empty when none matched).
//
// Deliberately does NOT bump `updatedAt`. This is a CASCADED side-effect of
// the owner universe's deletion, not a user edit — severing the link doesn't
// change the collection's content (items are untouched). Advancing the LWW
// clock here would make the unlinked bucket look "freshly edited" and out-race
// the collection's OWN tombstone on a peer: a universe merge tombstones the
// loser auto-collection (older `updatedAt`) AND tombstones the universe, whose
// cascade lands first on the receiver. A bump here would defeat the (older)
// collection tombstone under pure LWW and strand a live duplicate on the peer.
// Items always union on merge (`mergeCollectionItems`), so preserving the
// timestamp can't lose renders.
export const unlinkCollectionsForUniverse = (universeId) =>
  clearOwnerLink('universeId', universeId, UNIVERSE_ID_MAX);

// Cascade a universe rename to its linked collection(s). Skips the rename-lock
// guard in updateCollection by writing the name directly — the lock exists to
// block user-driven renames, not system-driven cascades from the universe
// rename itself.
export const renameCollectionForUniverse = (universeId, newUniverseName) =>
  renameOwnerLinked('universeId', universeId, UNIVERSE_ID_MAX, universeCollectionNameFor, newUniverseName);
