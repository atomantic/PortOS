import { LOCAL_RUNTIME_LABELS } from '../../../../../server/lib/modelPinMembership.js';

export const PERFORMANCE_PATH = '/models/performance';

// The report supplies the live roster. Fall back to the shared runtime labels
// for previously measured or deep-linked models missing from that roster.
const BACKEND_LABEL = LOCAL_RUNTIME_LABELS;

export const VERDICT_META = {
  fits: { label: 'Fits', cls: 'text-emerald-400 border-emerald-400/50' },
  'does-not-fit': { label: 'Does not fit', cls: 'text-port-warning border-port-warning/50' },
  incompatible: { label: 'Incompatible', cls: 'text-port-error border-port-error/50' },
  unknown: { label: 'Unknown', cls: 'text-gray-400 border-gray-500/50' },
};

export const backendLabel = (runtimes, id) =>
  runtimes?.find((r) => r.id === id)?.label || (Object.hasOwn(BACKEND_LABEL, id) ? BACKEND_LABEL[id] : id);

// An empty field means "leave the daemon on its own default", so it is dropped
// rather than sent as 0/false — the server applies the same rule.
export const compactTuning = (draft) => Object.fromEntries(
  Object.entries(draft || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined)
);

// A model can hold several measurements, one per launch tuning, so the tuning is
// part of a row's identity — not decoration. Keying on model alone gave two
// variants the same React key and made "discard" target the wrong record.
//
// `modelKey` is the coarser identity a TUNING SWEEP works in: a sweep is what
// measures the tunings, so it targets the model rather than one of its recorded
// configurations.
export const modelKey = (entry) => `${entry.backend}:${entry.modelId}`;
export const entryKey = (entry) => `${modelKey(entry)}@${entry.tuningKey || ''}`;
