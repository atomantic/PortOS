import useFieldDraft from '../../hooks/useFieldDraft';
import { FormField } from '../ui/FormField';
import {
  formatDurationMs,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
} from '../../utils/formatters';

// Buffered timeout input — typing "9" toward "900000" must NOT snap the field
// to blank just because `parseTimeoutMs("9")` returns null (below the 1s
// floor). useFieldDraft keeps the raw string locally and only invokes
// onCommit on blur with the validated value (or null when the user clears
// it / leaves it invalid).
export default function StageTimeoutField({ timeout, providerFallback, onCommit, disabled = false }) {
  const { value: draft, onChange, onBlur } = useFieldDraft(timeout, (raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') { onCommit(null); return; }
    const ms = parseTimeoutMs(raw);
    // Non-null parse → commit. Null result on non-empty input means out-of-range
    // or non-integer; leave persisted state untouched so the input snaps back.
    if (ms != null) onCommit(ms);
  });
  return (
    <FormField label="Timeout override (ms)">
      <input
        disabled={disabled}
        type="number"
        inputMode="numeric"
        min={TIMEOUT_INPUT_MIN_MS}
        max={TIMEOUT_INPUT_MAX_MS}
        step={TIMEOUT_INPUT_STEP_MS}
        value={draft}
        onChange={onChange}
        onBlur={onBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder={providerFallback != null ? String(providerFallback) : ''}
        className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden"
      />
      <p className="text-xs text-gray-500 mt-1">
        {timeout && timeout > 0
          ? `≈ ${formatDurationMs(timeout)} per run`
          : 'Leave blank to use the provider default'}
      </p>
    </FormField>
  );
}
