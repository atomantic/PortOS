/**
 * Music album routes.
 *
 *   GET    /api/albums        → Album[]   (live, sorted by title; `?limit`/`?offset`
 *                                          switches to the bounded envelope)
 *   POST   /api/albums        → Album
 *   GET    /api/albums/:id     → Album
 *   PATCH  /api/albums/:id     → Album
 *   DELETE /api/albums/:id     → { id }     (soft delete)
 *
 * Bounds come from services/albums/logic.js so the Zod schema here and the
 * service-layer sanitizer agree by construction. Mirrors routes/artists.js.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import * as albums from '../services/albums/index.js';
import * as tracks from '../services/tracks/index.js';

const router = Router();

const titleField = z.string().trim().min(1).max(albums.TITLE_MAX);
const artistIdField = z.string().trim().max(albums.ARTIST_ID_MAX);
const artistNameField = z.string().trim().max(albums.ARTIST_NAME_MAX);
const descriptionField = z.string().trim().max(albums.DESCRIPTION_MAX);
const genreField = z.string().trim().max(albums.GENRE_MAX);
const coverImageUrlField = z.string().trim().max(albums.COVER_IMAGE_URL_MAX);
// null clears the year; a number is clamped server-side into the band.
const releaseYearField = z.number().int().min(albums.RELEASE_YEAR_MIN).max(albums.RELEASE_YEAR_MAX).nullable();
const trackIdsField = z.array(z.string().trim().max(albums.TRACK_ID_MAX)).max(albums.TRACK_IDS_MAX);

const createSchema = z.object({
  title: titleField,
  artistId: artistIdField.optional().default(''),
  artist: artistNameField.optional().default(''),
  description: descriptionField.optional().default(''),
  genre: genreField.optional().default(''),
  releaseYear: releaseYearField.optional().default(null),
  coverImageUrl: coverImageUrlField.optional().default(''),
  trackIds: trackIdsField.optional().default([]),
});

const patchSchema = z.object({
  title: titleField.optional(),
  artistId: artistIdField.optional(),
  artist: artistNameField.optional(),
  description: descriptionField.optional(),
  genre: genreField.optional(),
  releaseYear: releaseYearField.optional(),
  coverImageUrl: coverImageUrlField.optional(),
  trackIds: trackIdsField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

// Membership single-source-of-truth reconcile. The album's `trackIds` carry the
// ORDER; each track's `albumId` is the membership pointer the Tracks API reports.
// After an album write, stamp `albumId` on its member tracks and clear it on any
// track that used to belong to this album but was dropped — so the two views
// never disagree (a track removed from the album stops reporting that albumId,
// and an added track starts). Best-effort per track: a missing/deleted track id
// in `trackIds` is simply skipped (updateTrack 404s are swallowed). Runs after
// the album persists so a rejected album write doesn't mutate track membership.
async function reconcileAlbumMembership(album) {
  const desired = new Set(album.trackIds || []);
  const all = await tracks.listTracks().catch(() => []);
  const byId = new Map(all.map((t) => [t.id, t]));
  const ops = [];
  // A listed track that currently belongs to a DIFFERENT album is being moved
  // here — drop it from that other album's ordered `trackIds` so the old album
  // stops listing it (it now reports a different `albumId`). Call the album
  // SERVICE (not this route) so the write can't re-enter reconcile and loop.
  // Coalesce per-source-album removals into one update each.
  const removalsByAlbum = new Map();
  // Clear albumId on tracks that point here but are no longer listed.
  for (const t of all) {
    if (t.albumId === album.id && !desired.has(t.id)) {
      ops.push(tracks.updateTrack(t.id, { albumId: '' }).catch(() => {}));
    }
  }
  // Stamp albumId on listed tracks that don't already point here, and record any
  // prior album they're being stolen from.
  for (const id of desired) {
    const t = byId.get(id);
    if (t && t.albumId !== album.id) {
      ops.push(tracks.updateTrack(id, { albumId: album.id }).catch(() => {}));
      if (t.albumId) {
        const set = removalsByAlbum.get(t.albumId) || new Set();
        set.add(id);
        removalsByAlbum.set(t.albumId, set);
      }
    }
  }
  await Promise.all(ops);
  // Now prune each stolen track from its former album's list (one write per
  // source album; skips the album being saved and any missing/deleted album).
  await Promise.all([...removalsByAlbum.entries()].map(async ([srcAlbumId, stolen]) => {
    if (srcAlbumId === album.id) return;
    const src = await albums.getAlbum(srcAlbumId).catch(() => null);
    if (!src) return;
    const nextIds = (src.trackIds || []).filter((id) => !stolen.has(id));
    if (nextIds.length !== (src.trackIds || []).length) {
      await albums.updateAlbum(srcAlbumId, { trackIds: nextIds }).catch(() => {});
    }
  }));
}

// Backward-compatible by default: returns the full albums array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const list = await albums.listAlbums();
  if (!isPaginationRequested(req.query)) return res.json(list);
  res.json(paginateArray(list, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  const album = await albums.createAlbum(body);
  await reconcileAlbumMembership(album);
  res.status(201).json(album);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const album = await albums.getAlbum(req.params.id);
  if (!album) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
  res.json(album);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const album = await albums.updateAlbum(req.params.id, body);
  // Only reconcile when the membership list was part of this write.
  if ('trackIds' in body) await reconcileAlbumMembership(album);
  res.json(album);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await albums.deleteAlbum(req.params.id);
  // Orphan the album's tracks (clear their albumId) so they revert to singles
  // rather than pointing at a tombstoned album.
  await reconcileAlbumMembership({ id: req.params.id, trackIds: [] });
  res.json(result);
}));

export default router;
