// Editor for an app's hand-written audit path priorities (`app.featurePriorities`): add, edit and remove rows of
// { label, tier, one glob per line, note }. The server validates the same limits; the pure helpers here keep the
// drawer's draft shape (paths as one textarea) out of the save payload.
import { Plus, Trash2 } from 'lucide-react';

export const FEATURE_PRIORITY_MAX_ENTRIES = 50;
export const FEATURE_PRIORITY_MAX_PATHS = 20;
const MAX_LABEL = 80;
const MAX_PATH = 200;
const MAX_NOTE = 500;

const TIER_OPTIONS = [
  { value: 'P0', label: 'P0 · heavy use, audit first' },
  { value: 'P1', label: 'P1 · normal (default)' },
  { value: 'P2', label: 'P2 · low use, real defects only' },
  { value: 'P3', label: 'P3 · dormant, left out of audits' },
];

let rowCounter = 0;
const newRowId = () => {
  rowCounter += 1;
  return `fp-${Date.now().toString(36)}-${rowCounter}`;
};

const splitPaths = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

/** Stored entries to editable rows. Tolerates anything a hand-edited apps file could hold. */
export function toPriorityRows(featurePriorities) {
  if (!Array.isArray(featurePriorities)) return [];
  return featurePriorities
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      id: typeof entry.id === 'string' && entry.id ? entry.id : newRowId(),
      label: typeof entry.label === 'string' ? entry.label : '',
      priority: typeof entry.priority === 'string' ? entry.priority : 'P1',
      pathsText: Array.isArray(entry.paths) ? entry.paths.join('\n') : '',
      note: typeof entry.note === 'string' ? entry.note : '',
    }));
}

/** Editable rows to the server payload; a blank note is dropped so it never saves as an empty string. */
export const fromPriorityRows = (rows) => rows.map((row) => ({
  id: row.id,
  label: row.label.trim(),
  paths: splitPaths(row.pathsText),
  priority: row.priority,
  ...(row.note.trim() ? { note: row.note.trim() } : {}),
}));

// Mirrors the server's prompt-safety rule: these strings are written into audit prompts, so control characters,
// quotes and backticks are refused rather than escaped.
const hasUnsafeChar = (text) => /['`]/.test(text) || [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** The first problem that would make the server refuse these rows, or null. */
export function priorityRowsError(rows) {
  if (rows.length > FEATURE_PRIORITY_MAX_ENTRIES) return `At most ${FEATURE_PRIORITY_MAX_ENTRIES} audit priorities.`;
  for (const [index, row] of rows.entries()) {
    const name = `Audit priority ${index + 1}`;
    const paths = splitPaths(row.pathsText);
    if (!row.label.trim()) return `${name} needs a name.`;
    if (row.label.trim().length > MAX_LABEL || hasUnsafeChar(row.label.trim())) return `${name}: the name must be at most ${MAX_LABEL} characters with no quotes or backticks.`;
    if (!paths.length) return `${name} needs at least one path.`;
    if (paths.length > FEATURE_PRIORITY_MAX_PATHS) return `${name}: at most ${FEATURE_PRIORITY_MAX_PATHS} paths.`;
    if (paths.some((path) => path.length > MAX_PATH || hasUnsafeChar(path))) return `${name}: each path must be at most ${MAX_PATH} characters with no quotes or backticks.`;
  }
  return null;
}

const FIELD = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-hidden';

export default function AppAuditPrioritiesEditor({ rows, onChange }) {
  const update = (id, patch) => onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const error = rows.length ? priorityRowsError(rows) : null;
  return (
    <div className="pt-2" role="group" aria-labelledby="edit-app-audit-priorities-heading">
      <h4 id="edit-app-audit-priorities-heading" className="text-sm text-gray-400 mb-1">Audit priorities</h4>
      <p className="mb-2 text-xs text-gray-500">
        Scheduled quality audits focus on P0 paths, report only real defects in P2 paths and skip P3 paths, except security, privacy and data-integrity audits, which still cover everything. Paths are globs relative to the repository root, one per line (for example <code>src/legacy/**</code>). Anything no row names counts as P1.
      </p>
      <div className="space-y-3">
        {rows.map((row, index) => (
          <div key={row.id} className="rounded-lg border border-port-border bg-port-bg/40 p-3 space-y-2" role="group" aria-label={`Audit priority ${index + 1}`}>
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_14rem] gap-2">
              <div>
                <label htmlFor={`${row.id}-label`} className="block text-xs text-gray-400 mb-1">Name</label>
                <input id={`${row.id}-label`} type="text" value={row.label} maxLength={MAX_LABEL}
                  onChange={(e) => update(row.id, { label: e.target.value })} placeholder="e.g. Legacy importer" className={FIELD} />
              </div>
              <div>
                <label htmlFor={`${row.id}-tier`} className="block text-xs text-gray-400 mb-1">Priority</label>
                <select id={`${row.id}-tier`} value={row.priority} onChange={(e) => update(row.id, { priority: e.target.value })} className={FIELD}>
                  {TIER_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label htmlFor={`${row.id}-paths`} className="block text-xs text-gray-400 mb-1">Paths (one glob per line)</label>
              <textarea id={`${row.id}-paths`} value={row.pathsText} rows={3} onChange={(e) => update(row.id, { pathsText: e.target.value })}
                placeholder={'src/legacy/**\nscripts/import-*.js'} className={`${FIELD} font-mono`} />
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-48">
                <label htmlFor={`${row.id}-note`} className="block text-xs text-gray-400 mb-1">Note (optional, not sent to audits)</label>
                <input id={`${row.id}-note`} type="text" value={row.note} maxLength={MAX_NOTE}
                  onChange={(e) => update(row.id, { note: e.target.value })} className={FIELD} />
              </div>
              <button type="button" onClick={() => onChange(rows.filter((candidate) => candidate.id !== row.id))}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded border border-port-border px-3 text-xs text-gray-300 hover:border-port-error hover:text-port-error">
                <Trash2 size={14} aria-hidden="true" />Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p role="status" className="mt-2 text-xs text-port-error">{error}</p>}
      <button type="button" disabled={rows.length >= FEATURE_PRIORITY_MAX_ENTRIES}
        onClick={() => onChange([...rows, { id: newRowId(), label: '', priority: 'P3', pathsText: '', note: '' }])}
        className="mt-2 inline-flex min-h-[40px] items-center gap-1.5 rounded border border-port-border px-3 text-xs text-gray-200 hover:border-port-accent hover:text-white disabled:opacity-40">
        <Plus size={14} aria-hidden="true" />Add audit priority
      </button>
    </div>
  );
}
