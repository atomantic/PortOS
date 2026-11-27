/** Request schemas for Music Video development artifact import, notes, and review. */

import { z } from 'zod';
import { MUSIC_VIDEO_DEV_ARTIFACT_KINDS, MUSIC_VIDEO_DEV_ARTIFACT_STATUSES } from '../musicVideoValidation.js';
import { devArtifactNoteTarget, devArtifactNoteText } from './shared.js';

// The text fields of a multipart import (the file itself is the `file` part).
// `artifactId` adds a version to that artifact; otherwise kind + title create
// one. `notes` is a JSON array of strings or `{ text, target }` objects.
export const musicVideoDevArtifactImportSchema = z.object({
  artifactId: z.string().min(1).max(64).optional(),
  kind: z.enum(MUSIC_VIDEO_DEV_ARTIFACT_KINDS).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  status: z.enum(MUSIC_VIDEO_DEV_ARTIFACT_STATUSES).optional(),
  notes: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  }, z.array(z.union([
    devArtifactNoteText,
    z.object({ text: devArtifactNoteText, target: devArtifactNoteTarget }).strict(),
  ])).max(50)).optional(),
}).strict().refine((b) => b.artifactId || b.kind, { message: 'kind is required for a new artifact', path: ['kind'] });

export const musicVideoDevArtifactNoteSchema = z.object({
  text: devArtifactNoteText,
  target: devArtifactNoteTarget,
}).strict();

export const musicVideoDevArtifactNoteUpdateSchema = z.object({
  resolved: z.boolean(),
}).strict();

export const musicVideoDevArtifactReviewSchema = z.object({
  status: z.enum(MUSIC_VIDEO_DEV_ARTIFACT_STATUSES),
  note: z.string().trim().max(2000).optional(),
}).strict();

export const musicVideoDevArtifactFileQuerySchema = z.object({
  version: z.coerce.number().int().min(1).max(1000).optional(),
}).strict();
