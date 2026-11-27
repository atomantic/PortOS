// Zod request schemas for the albums routes.

import { z } from 'zod';
import * as albums from './albumLimits.js';

const titleField = z.string().trim().min(1).max(albums.TITLE_MAX);

const artistIdField = z.string().trim().max(albums.ARTIST_ID_MAX);

const artistNameField = z.string().trim().max(albums.ARTIST_NAME_MAX);

const descriptionField = z.string().trim().max(albums.DESCRIPTION_MAX);

const genreField = z.string().trim().max(albums.GENRE_MAX);

const coverImageUrlField = z.string().trim().max(albums.COVER_IMAGE_URL_MAX);

// null clears the year; a number is clamped server-side into the band.
const releaseYearField = z.number().int().min(albums.RELEASE_YEAR_MIN).max(albums.RELEASE_YEAR_MAX).nullable();

const trackIdsField = z.array(z.string().trim().max(albums.TRACK_ID_MAX)).max(albums.TRACK_IDS_MAX);

export const createSchema = z.object({
  title: titleField,
  artistId: artistIdField.optional().default(''),
  artist: artistNameField.optional().default(''),
  description: descriptionField.optional().default(''),
  genre: genreField.optional().default(''),
  releaseYear: releaseYearField.optional().default(null),
  coverImageUrl: coverImageUrlField.optional().default(''),
  trackIds: trackIdsField.optional().default([]),
});

export const patchSchema = z.object({
  title: titleField.optional(),
  artistId: artistIdField.optional(),
  artist: artistNameField.optional(),
  description: descriptionField.optional(),
  genre: genreField.optional(),
  releaseYear: releaseYearField.optional(),
  coverImageUrl: coverImageUrlField.optional(),
  trackIds: trackIdsField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });
