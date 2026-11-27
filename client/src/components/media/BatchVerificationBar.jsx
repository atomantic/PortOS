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

export const BATCH_REVIEWER_MODELS = [
  { id: 'auto', label: 'Auto (Default Reviewer)' },
  { id: 'gemini-4-argon', label: 'Google Gemini 4 Argon' },
  { id: 'qwen-27b', label: 'Qwen 27B / 27G (Local)' },
  { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
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
  selectedModel = 'auto',
  onModelChange,
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
          title="Select verification profile"
        >
          {PROFILES.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <label htmlFor="batch-verify-model" className="text-[11px] text-gray-400 font-medium">
          Model:
        </label>
        <select
          id="batch-verify-model"
          value={selectedModel}
          onChange={(e) => onModelChange?.(e.target.value)}
          disabled={isVerifying}
          className="text-xs bg-port-bg border border-port-border rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-port-accent disabled:opacity-50"
          title="Select evaluator model"
        >
          {BATCH_REVIEWER_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={() => onRunBatchVerify?.(selectedProfile, selectedModel)}
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
            className="min-h-[44px] pointer-fine:sm:min-h-0 px-2.5 py-1.5 text-xs rounded border border-port-border text-gray-400 hover:text-white hover:bg-port-border/50"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
