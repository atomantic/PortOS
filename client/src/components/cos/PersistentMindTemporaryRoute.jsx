import { useId } from 'react';
import { RotateCcw, Settings2, TriangleAlert } from 'lucide-react';
import { classifyMindRouteBilling, findMindThinkingPreset } from '../../lib/mindThinkingPresets.js';
import MindRouteBadge from './MindRouteBadge.jsx';

/**
 * The composer's "Send with another model" affordance.
 *
 * It only ever DISPLAYS and SELECTS: choosing or previewing a preset makes no
 * provider call, starts nothing, and resumes nothing. Authorization happens on
 * the send itself, one message at a time, which is why the send button below it
 * spells out the borrowed route rather than saying "Send".
 *
 * The selected id is owned by the URL (`?preset=`), so a composed alternate is
 * shareable and survives a reload — and so clearing it after a successful send
 * is a single navigation rather than hidden component state that could drift
 * out of sync with what the next message will actually use.
 */
export default function PersistentMindTemporaryRoute({
  presets = [],
  providers = [],
  selectedPresetId = null,
  onSelectPreset,
  onManagePresets,
  disabled = false,
  paused = false,
  imageCount = 0,
}) {
  const selectId = useId();
  const selected = findMindThinkingPreset(presets, selectedPresetId);
  // A selection the saved list no longer contains is NOT a reason to fall back
  // to the default route — that is exactly the silent substitution the whole
  // feature exists to prevent. Say so and refuse to send until it is resolved.
  const missing = Boolean(selectedPresetId) && selected === null;
  const provider = selected ? providers.find((candidate) => candidate.id === selected.providerId) || null : null;
  const billing = classifyMindRouteBilling(provider);

  if (presets.length === 0 && !missing) {
    return null;
  }

  return (
    <div className="mb-2 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="text-[11px] font-medium text-port-text-muted">Send with another model</label>
        <select
          id={selectId}
          value={missing ? '' : selectedPresetId || ''}
          disabled={disabled}
          onChange={(event) => onSelectPreset?.(event.target.value || null)}
          className="min-h-[32px] max-w-full flex-1 rounded border border-port-border bg-port-bg px-2 py-1 text-xs text-port-text disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
        >
          <option value="">Default profile (unchanged)</option>
          {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
        {selectedPresetId && (
          <button
            type="button"
            onClick={() => onSelectPreset?.(null)}
            disabled={disabled}
            className="flex min-h-[32px] items-center gap-1 rounded border border-port-border px-2 text-[11px] text-port-text hover:bg-port-border/30 disabled:opacity-50"
          >
            <RotateCcw size={12} aria-hidden="true" /> Return to default
          </button>
        )}
        <button
          type="button"
          onClick={() => onManagePresets?.()}
          className="flex min-h-[32px] items-center gap-1 rounded border border-port-border px-2 text-[11px] text-port-text-muted hover:bg-port-border/30 hover:text-port-text"
        >
          <Settings2 size={12} aria-hidden="true" /> Manage
        </button>
      </div>

      {missing && (
        <p role="alert" className="flex items-start gap-1.5 rounded border border-port-error/40 bg-port-error/10 px-2 py-1.5 text-[11px] text-port-error">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          That preset is no longer saved. Choose another or return to the default profile — this message will not be sent on a substitute model.
        </p>
      )}

      {selected && (
        <div className="rounded border border-port-accent/40 bg-port-accent/5 px-2 py-1.5">
          <p className="text-[11px] font-medium text-port-text">This one message runs on {selected.label}</p>
          <MindRouteBadge route={selected} provider={provider} className="mt-1" />
          <p className="mt-1 text-[11px] text-port-text-muted">
            {billing.detail} The next message and every scheduled wake use the unchanged default.
          </p>
          {billing.spendsAccount && (
            <p className="mt-1 text-[11px] text-port-warning">Sending is what authorizes this route — nothing runs until you press send.</p>
          )}
          {paused && (
            <p className="mt-1 text-[11px] text-port-text-muted">The mind is paused. This message queues on the selected route and only runs once you resume it.</p>
          )}
          {imageCount > 0 && (
            <p className="mt-1 text-[11px] text-port-text-muted">
              {imageCount === 1 ? 'The attached image is' : `All ${imageCount} attached images are`} checked against this route, not the default one. A text-only model refuses the message rather than dropping the image.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
