import { Bot } from 'lucide-react';
import ProviderModelSelector from '../ProviderModelSelector';
import useRunWithPicker from '../../hooks/useRunWithPicker';

/** A saved provider/model/effort as one line, e.g. "Auto provider · high effort". */
export function describeAgentPin(pin, providers = []) {
  const provider = pin?.provider ? providers.find((entry) => entry.id === pin.provider)?.name || pin.provider : 'Auto provider';
  return [provider, pin?.model, pin?.effort ? `${pin.effort} effort` : null].filter(Boolean).join(' · ');
}

/**
 * A provider › model › effort picker prefilled with `pin`, for one agent run or
 * an account's agent defaults. Submits `{ provider, model, effort }` with null
 * for each Auto choice, so the server can tell "Auto" from "not chosen".
 */
export default function GitHubAgentPinForm({ pin, label, submitLabel, busy = false, onSubmit, onCancel, children }) {
  const picker = useRunWithPicker({ preselectDefaults: false, seed: pin });
  const submit = (event) => {
    event.preventDefault();
    onSubmit({ provider: picker.pin.provider || null, model: picker.pin.model || null, effort: picker.pin.effort || null });
  };
  return (
    <form onSubmit={submit} aria-label={label} className="mt-2 min-w-0 space-y-2 rounded-lg border border-port-border bg-port-bg p-3">
      <span className="flex items-center gap-1.5 text-xs text-gray-400"><Bot size={12} aria-hidden="true" /> Run with</span>
      <ProviderModelSelector {...picker.selectorProps} compact />
      {children}
      <div className="flex flex-wrap gap-2">
        {/* Submitting before the catalog loads would send Auto over the saved pin. */}
        <button type="submit" disabled={busy || picker.loading} className="inline-flex min-h-[36px] items-center rounded bg-port-accent px-3 py-1.5 text-xs text-white disabled:opacity-50">
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="inline-flex min-h-[36px] items-center rounded border border-port-border px-3 py-1.5 text-xs text-gray-300">Cancel</button>
      </div>
    </form>
  );
}
