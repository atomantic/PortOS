/**
 * Re-exports the shared browser-safe character-sheet pointer helpers from
 * `server/lib/sheetPointers.js`.
 *
 * `LEGACY_SHEET_VARIANT_ID` + `readSheetPointer` / `listSheetPointers` for
 * traversing both the legacy `referenceSheetImageRef` field and the `referenceSheets` map.
 */

export { LEGACY_SHEET_VARIANT_ID, readSheetPointer, listSheetPointers } from '../../../server/lib/sheetPointers.js';
