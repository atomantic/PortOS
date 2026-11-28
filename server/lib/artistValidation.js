// Zod request schemas for the artists routes.

import { z } from 'zod';
import * as artists from './artistLimits.js';

const nameField = z.string().trim().min(1).max(artists.NAME_MAX);

const genreField = z.string().trim().max(artists.GENRE_MAX);

const bioField = z.string().trim().max(artists.BIO_MAX);

const musicalStyleField = z.string().trim().max(artists.MUSICAL_STYLE_MAX);

const physicalDescriptionField = z.string().trim().max(artists.PHYSICAL_DESCRIPTION_MAX);

const portraitStyleField = z.string().trim().max(artists.PORTRAIT_STYLE_MAX);

const portraitImageUrlField = z.string().trim().max(artists.PORTRAIT_IMAGE_URL_MAX);

const submissionFields = Object.fromEntries(artists.SUBMISSION_FIELD_SPECS.map(({ key, max }) => [key, z.string().trim().max(max)]));

const submissionCreateFields = Object.fromEntries(Object.entries(submissionFields).map(([key, field]) => [key, field.optional().default('')]));

const submissionPatchFields = Object.fromEntries(Object.entries(submissionFields).map(([key, field]) => [key, field.optional()]));

export const createSchema = z.object({
  name: nameField,
  genre: genreField.optional().default(''),
  bio: bioField.optional().default(''),
  musicalStyle: musicalStyleField.optional().default(''),
  physicalDescription: physicalDescriptionField.optional().default(''),
  portraitStyle: portraitStyleField.optional().default(''),
  portraitImageUrl: portraitImageUrlField.optional().default(''),
  ...submissionCreateFields,
});

export const patchSchema = z.object({
  name: nameField.optional(),
  genre: genreField.optional(),
  bio: bioField.optional(),
  musicalStyle: musicalStyleField.optional(),
  physicalDescription: physicalDescriptionField.optional(),
  portraitStyle: portraitStyleField.optional(),
  portraitImageUrl: portraitImageUrlField.optional(),
  ...submissionPatchFields,
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });
