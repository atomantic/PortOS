import { query } from '../lib/db.js';
import { listSheetPointers } from '../lib/sheetPointers.js';
import { resolveGalleryImage, resolveImageRef } from '../lib/pathSafety.js';

// Only structured, direct provenance is evidence of a relationship. Prompts can
// contain a whole production bible, and universe/collection membership does not
// mean that an image depicts this ingredient. Do not recursively widen the set.
export async function listRelatedImages(ingredient, media, { limit, offset }) {
  const payload = ingredient.payload || {};
  const filenames = [...new Set([
    payload.primaryImageRef,
    ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : []),
    ...listSheetPointers(payload).map(sheet => sheet.filename),
    ...media.filter(m => m.kind === 'portrait' || m.kind === 'reference').map(m => m.mediaKey),
  ].filter(value => typeof value === 'string' && value.length > 0))];
  if (!filenames.length) return { items: [], total: 0, limit, offset };

  // Read the existing derived index rather than scanning every sidecar for
  // each detail request. Count + page share a single database snapshot, and
  // only card fields leave the server (never prompts or local paths).
  const result = await query(`
    WITH candidates AS (
      SELECT ref, data, created_at,
        (data->>'cleanedFrom' = ANY($1::text[]) OR data->>'upscaledFrom' = ANY($1::text[])) AS derived,
        (data->>'initImageFilename' = ANY($1::text[])
          OR (CASE WHEN jsonb_typeof(data->'referenceImageFilenames') = 'array'
            THEN data->'referenceImageFilenames' ELSE '[]'::jsonb END) ?| $1::text[]) AS supplied,
        EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(data #> '{visualConditioning,assets}') = 'array'
            THEN data #> '{visualConditioning,assets}' ELSE '[]'::jsonb END) AS asset
          WHERE asset->>'filename' = ANY($1::text[])) AS compiled,
        EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(data->'requestedInputImages') = 'array'
            THEN data->'requestedInputImages' ELSE '[]'::jsonb END) AS asset
          WHERE asset->>'filename' = ANY($1::text[])) AS requested,
        EXISTS (SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(data->'omittedInputImages') = 'array'
            THEN data->'omittedInputImages' ELSE '[]'::jsonb END) AS asset
          WHERE asset->>'filename' = ANY($1::text[])) AS omitted
      FROM media_assets
      WHERE kind = 'image' AND COALESCE(data->>'hidden', 'false') <> 'true'
        AND NOT (ref = ANY($1::text[]))
    ), linked AS MATERIALIZED (
      SELECT ref AS filename, created_at,
        jsonb_build_object('filename', ref, 'width', data->'width',
          'height', data->'height', 'createdAt', data->'createdAt',
          'provenanceStatus', CASE WHEN derived OR (supplied AND data->>'inputProvenance' = 'provider-inputs')
            THEN 'recorded' WHEN omitted THEN 'not-supplied'
            WHEN supplied THEN 'legacy-unverified' ELSE 'provider-use-unverified' END,
          'association', CASE WHEN derived THEN 'derived-image'
            WHEN supplied THEN 'reference-input' WHEN compiled THEN 'compiled-reference'
            ELSE 'requested-reference' END) AS item
      FROM candidates WHERE derived OR supplied OR compiled OR requested
    ), page AS (
      SELECT item, created_at, filename FROM linked
      ORDER BY created_at DESC NULLS LAST, filename ASC LIMIT $2 OFFSET $3
    )
    SELECT (SELECT count(*)::int FROM linked) AS total,
      COALESCE((SELECT jsonb_agg(item ORDER BY created_at DESC NULLS LAST, filename ASC) FROM page), '[]'::jsonb) AS items
  `, [filenames, limit, offset]);
  const { items, total } = result.rows[0];
  return {
    items: items.map(item => ({ ...item, missing: !(resolveGalleryImage(item.filename) || resolveImageRef(item.filename)) })),
    total, limit, offset,
  };
}
