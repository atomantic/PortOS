/**
 * BatchVerificationBar.jsx — Control bar for multi-image batch verification
 * of anatomical correctness, digit counts, composition, and typography.
 */

import { ShieldCheck, Loader2 } from 'lucide-react';

const PROFILES = [
  { id: 'strict_anatomy', label: 'Strict Anatomy (Hands & Limbs)' },
  { id: 'composition_and_text', label: 'Composition & Typography' },
  { id: 'full_audit', label: 'Comprehensive Quality Audit' },
  { id: 'quick_screen', label: 'Quick Defect Screen' },
];

export default function BatchVerificationBar({
  selectedCount = 0,
  totalImages = 0,
  onSelectAll,
  onClearSelection,
  onRunBatchVerify,
  isVerifying = false,
  progress = { current: 0, total: 0 },
  onCancel,
  selectedProfile = 'strict_anatomy',
  onProfileChange,
}) {
  return (
    <div
      role="region"
      aria-label="Batch verification toolbar"
      className="bg-port-card border border-port-accent/50 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-md"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-port-accent">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>Batch Verify: {selectedCount} selected</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {onSelectAll && totalImages > 0 && (
            <button
              type="button"
              onClick={onSelectAll}
              disabled={isVerifying}
              className="px-2 py-1 rounded bg-port-bg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 text-[11px] disabled:opacity-50"
            >
              Select All ({totalImages})
            </button>
          )}
          {onClearSelection && selectedCount > 0 && (
            <button
              type="button"
              onClick={onClearSelection}
              disabled={isVerifying}
              className="px-2 py-1 rounded bg-port-bg border border-port-border text-gray-400 hover:text-white text-[11px] disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label htmlFor="batch-verify-profile" className="text-[11px] text-gray-400 font-medium">
          Profile:
        </label>
        <select
          id="batch-verify-profile"
          value={selectedProfile}
          onChange={(e) => onProfileChange?.(e.target.value)}
          disabled={isVerifying}
          className="text-xs bg-port-bg border border-port-border rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-port-accent disabled:opacity-50"
        >
          {PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => onRunBatchVerify?.(selectedProfile)}
          disabled={selectedCount === 0 || isVerifying}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded transition-colors"
        >
          {isVerifying ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Verifying {progress.current} of {progress.total}...</span>
            </>
          ) : (
            <>
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Verify Selected ({selectedCount})</span>
            </>
          )}
        </button>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={isVerifying}
            className="px-2.5 py-1.5 text-xs rounded border border-port-border text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
