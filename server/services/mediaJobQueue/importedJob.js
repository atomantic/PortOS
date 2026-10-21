import { isSafeRecordId } from '../../lib/validation.js';
import { isPlainObject } from '../../lib/objects.js';
import { isStr } from '../../lib/textUtils.js';
import { PARAM_ALLOWLIST } from './sanitizeJob.js';

// Re-render metadata a share bucket carries for a gallery asset. The record is
// peer-authored, so only completed image/video rows survive, and params are
// cut to the re-render knobs: worker paths, upload cleanup targets and the
// `remotePeerReservation` marker (which exempts a row from every archive trim)
// must never arrive from a bucket.
const IMPORTABLE_KINDS = new Set(['image', 'video']);
const RESULT_FILE_KEYS = ['filename', 'videoPath', 'thumbnail'];
const isBareFilename = (value) => isStr(value) && value.length > 0 && !/[\\/]/.test(value) && value !== '..' && value !== '.';

export function importedArchiveRow(raw) {
  if (!isPlainObject(raw) || !isSafeRecordId(raw.id)) return null;
  if (!IMPORTABLE_KINDS.has(raw.kind) || raw.status !== 'completed') return null;
  const params = Object.fromEntries(Object.entries(isPlainObject(raw.params) ? raw.params : {})
    .filter(([key]) => PARAM_ALLOWLIST.has(key)));
  const result = Object.fromEntries(RESULT_FILE_KEYS
    .filter((key) => isBareFilename(raw.result?.[key]))
    .map((key) => [key, raw.result[key]]));
  const completedAt = isStr(raw.completedAt) && Number.isFinite(Date.parse(raw.completedAt)) ? raw.completedAt : null;
  return {
    id: raw.id,
    kind: raw.kind,
    owner: isStr(raw.owner) ? raw.owner : null,
    status: 'completed',
    completedAt,
    params,
    result,
    imported: true,
  };
}
