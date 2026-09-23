/**
 * Universe Builder export routes.
 *
 * The route is mounted before crud.js because the CRUD wildcard owns
 * `GET /:id`; keeping this sub-router ahead of it makes the nested export path
 * an explicit part of the route contract.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, failValidation, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import { parseUniverseMarkdown, universeMarkdownFilename, universeToMarkdown } from '../../lib/universeMarkdown.js';
import * as svc from '../../services/universeBuilder.js';
import { findSameNameUniverses } from '../../services/duplicateDetection.js';
import { canonArrayField, categoriesSchema, influencesSchema, mapServiceError } from './shared.js';

const router = Router();

const markdownImportSchema = z.object({
  markdown: z.string().trim().min(1).max(10_000_000),
}).strict();
const markdownUniversePatchSchema = z.object({
  name: z.string().trim().min(1).max(svc.NAME_MAX_LENGTH),
  logline: z.string().trim().max(svc.LOGLINE_MAX).optional(),
  premise: z.string().trim().max(svc.PREMISE_MAX).optional(),
  styleNotes: z.string().trim().max(svc.STYLE_NOTES_MAX).optional(),
  categories: categoriesSchema.optional(),
  influences: influencesSchema.optional(),
  characters: canonArrayField,
  places: canonArrayField,
  objects: canonArrayField,
}).strict();

const categoryKey = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '')
  .replace(/_{2,}/g, '_')
  .slice(0, svc.WORLD_CATEGORY_KEY_MAX);

const canonIdentities = (entry, kind) => {
  const values = kind === 'places'
    ? [entry?.slugline, entry?.name]
    : [entry?.name, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])];
  return new Set(values
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, ' ')));
};

const preserveCanonMetadata = (existing, imported, kind) => imported.map((entry) => {
  const identities = canonIdentities(entry, kind);
  const previous = (existing || []).find((candidate) =>
    [...canonIdentities(candidate, kind)].some((identity) => identities.has(identity)));
  return previous
    ? { ...previous, ...entry, id: previous.id, createdAt: previous.createdAt }
    : entry;
});

const preserveCategoryMetadata = (existingCategories, importedCategories) => {
  const existingByKey = new Map(Object.entries(existingCategories || {}).map(([key, value]) => [categoryKey(key), value]));
  return Object.fromEntries(Object.entries(importedCategories || {}).map(([key, incoming]) => {
    const normalizedKey = categoryKey(key);
    const previous = existingByKey.get(normalizedKey);
    const previousVariations = Array.isArray(previous?.variations) ? previous.variations : [];
    const variations = (incoming.variations || []).map((variation) => {
      const prior = previousVariations.find((candidate) =>
        candidate?.label?.trim().toLowerCase() === variation.label?.trim().toLowerCase());
      return prior ? { ...prior, ...variation, id: prior.id } : variation;
    });
    return [normalizedKey, {
      ...(previous || {}),
      ...incoming,
      kind: incoming.kind || previous?.kind,
      variations,
    }];
  }));
};

router.get('/:id/export/markdown', asyncHandler(async (req, res) => {
  const universe = await svc.getUniverse(req.params.id).catch((err) => {
    throw mapServiceError(err);
  });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${universeMarkdownFilename(universe.name)}"`);
  res.send(universeToMarkdown(universe));
}));

router.post('/:id/import/markdown', asyncHandler(async (req, res) => {
  const { markdown } = validateRequest(markdownImportSchema, req.body ?? {});
  let patch;
  try {
    patch = parseUniverseMarkdown(markdown);
  } catch (error) {
    throw new ServerError(error.message || 'Unable to read this Markdown file.', {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }
  const checkedPatch = markdownUniversePatchSchema.safeParse(patch);
  if (!checkedPatch.success) failValidation(checkedPatch);
  patch = checkedPatch.data;

  const universe = await svc.updateUniverse(req.params.id, (current) => {
    const next = { ...patch };
    for (const kind of ['characters', 'places', 'objects']) {
      if (Array.isArray(next[kind])) next[kind] = preserveCanonMetadata(current[kind], next[kind], kind);
    }
    if (next.categories) next.categories = preserveCategoryMetadata(current.categories, next.categories);
    return next;
  }, { replaceCategories: true }).catch((err) => { throw mapServiceError(err); });

  if ('name' in patch) {
    const duplicateName = await findSameNameUniverses(universe.name, { excludeId: req.params.id });
    if (duplicateName.length) {
      res.json({ ...universe, _warnings: { duplicateName } });
      return;
    }
  }
  res.json(universe);
}));

export default router;
