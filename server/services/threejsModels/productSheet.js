/**
 * Read-only lookup from a gallery filename to its owning Casting object's
 * product-sheet filename, so the Three.js model pickers can offer the sheet as
 * a one-tap reference view. Nothing is written and nothing is added implicitly.
 */

import { query } from '../../lib/db.js';
import { readSheetPointer } from '../../lib/sheetPointers.js';

// Mirrors the `product` variant id of the catalog `object` type
// (CATALOG_SHEET_VARIANTS in services/catalog/catalogSheet.js).
const PRODUCT_SHEET_VARIANT = 'product';

/** @returns {Promise<string|null>} the sheet filename, or null when the image is not an object's or it has no sheet */
export async function findProductSheetForImage(filename) {
  const { rows } = await query(
    `SELECT payload FROM catalog_ingredients
     WHERE type = 'object' AND deleted = false
       AND (payload->>'primaryImageRef' = $1
         OR (CASE WHEN jsonb_typeof(payload->'imageRefs') = 'array' THEN payload->'imageRefs' ELSE '[]'::jsonb END) ? $1)
     ORDER BY updated_at DESC`,
    [filename],
  );
  for (const row of rows) {
    const sheet = readSheetPointer(row.payload, PRODUCT_SHEET_VARIANT);
    if (sheet) return sheet;
  }
  return null;
}
