// Zod request schemas for the authors routes.

import { z } from 'zod';
import * as authors from './authorLimits.js';

const nameField = z.string().trim().min(1).max(authors.NAME_MAX);

const writingStyleField = z.string().trim().max(authors.WRITING_STYLE_MAX);

const bioField = z.string().trim().max(authors.BIO_MAX);

const physicalDescriptionField = z.string().trim().max(authors.PHYSICAL_DESCRIPTION_MAX);

const headshotStyleField = z.string().trim().max(authors.HEADSHOT_STYLE_MAX);

const headshotImageUrlField = z.string().trim().max(authors.HEADSHOT_IMAGE_URL_MAX);

export const createSchema = z.object({
  name: nameField,
  writingStyle: writingStyleField.optional().default(''),
  bio: bioField.optional().default(''),
  physicalDescription: physicalDescriptionField.optional().default(''),
  headshotStyle: headshotStyleField.optional().default(''),
  headshotImageUrl: headshotImageUrlField.optional().default(''),
});

export const patchSchema = z.object({
  name: nameField.optional(),
  writingStyle: writingStyleField.optional(),
  bio: bioField.optional(),
  physicalDescription: physicalDescriptionField.optional(),
  headshotStyle: headshotStyleField.optional(),
  headshotImageUrl: headshotImageUrlField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });
