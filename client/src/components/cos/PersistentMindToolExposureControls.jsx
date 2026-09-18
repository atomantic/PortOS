import { useEffect, useId, useState } from 'react';
import * as api from '../../services/api';
import toast from '../ui/Toast';

const MIN_RETENTION_TURNS = 0;
const MAX_RETENTION_TURNS = 20;
const DEFAULT_RETENTION_TURNS = 3;

const clampRetentionTurns = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_TURNS;
  return Math.min(MAX_RETENTION_TURNS, Math.max(MIN_RETENTION_TURNS, Math.round(parsed)));
};

/**
 * Progressive tool exposure settings (#7624): how many extra user turns an
 * activated tool family stays at full schema, and the all-schemas escape
 * hatch that reproduces the pre-#7624 behavior for debugging. Neither field
 * changes what the mind is ALLOWED to do — only what it is shown each turn.
 */
export default function PersistentMindToolExposureControls({
  capabilities,
  disabled = false,
  onSaved,
  onSavingChange,
}) {
  const idPrefix = useId();
  const [retentionTurns, setRetentionTurns] = useState(() => clampRetentionTurns(capabilities?.toolExposureRetentionTurns ?? DEFAULT_RETENTION_TURNS));
  const [allSchemas, setAllSchemas] = useState(capabilities?.toolExposureAllSchemas === true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (saving) return;
    setRetentionTurns(clampRetentionTurns(capabilities?.toolExposureRetentionTurns ?? DEFAULT_RETENTION_TURNS));
    setAllSchemas(capabilities?.toolExposureAllSchemas === true);
  }, [capabilities?.toolExposureRetentionTurns, capabilities?.toolExposureAllSchemas, saving]);

  const save = async (patch, { successMessage }) => {
    setSaving(true);
    onSavingChange?.(true);
    try {
      await api.updateCosConfig({ persistentMindCapabilities: patch }, { silent: true });
      onSaved?.({ ...capabilities, ...patch });
      toast.success(successMessage);
    } catch (error) {
      setRetentionTurns(clampRetentionTurns(capabilities?.toolExposureRetentionTurns ?? DEFAULT_RETENTION_TURNS));
      setAllSchemas(capabilities?.toolExposureAllSchemas === true);
      toast.error(error.message);
    } finally {
      setSaving(false);
      onSavingChange?.(false);
    }
  };

  const retentionId = `${idPrefix}-retention`;
  const allSchemasId = `${idPrefix}-all-schemas`;

  return (
    <div className="space-y-4 border-t border-port-border pt-4">
      <div>
        <p className="text-sm text-port-text">Progressive tool exposure</p>
        <p className="mt-0.5 text-xs text-port-text-muted">Full tool schemas cost context. Only the small always-on core is shown by default; everything else is a one-line index until the mind calls tools.activate for its family. This changes only what is shown — every capability grant above still applies.</p>
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor={retentionId} className="text-sm text-port-text">Retention window (extra turns)</label>
          <p className="mt-0.5 text-xs text-port-text-muted">How many additional user turns an activated family stays fully expanded after the turn that activated it. 0 is one-turn-only.</p>
        </div>
        <input
          id={retentionId}
          type="number"
          min={MIN_RETENTION_TURNS}
          max={MAX_RETENTION_TURNS}
          step={1}
          value={retentionTurns}
          disabled={disabled || saving || allSchemas}
          onChange={(event) => setRetentionTurns(clampRetentionTurns(event.target.value))}
          onBlur={() => {
            if (retentionTurns === clampRetentionTurns(capabilities?.toolExposureRetentionTurns ?? DEFAULT_RETENTION_TURNS)) return;
            save({ toolExposureRetentionTurns: retentionTurns }, { successMessage: `Tool retention window set to ${retentionTurns} turn${retentionTurns === 1 ? '' : 's'}` });
          }}
          className="w-20 rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-port-text disabled:opacity-50"
        />
      </div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <label htmlFor={allSchemasId} className="text-sm text-port-text">Send every schema on every turn (debug escape hatch)</label>
          <p className="mt-0.5 text-xs text-port-text-muted">Restores the pre-progressive-exposure behavior: every granted tool's full schema, every turn. Use this only to debug a routing problem — it costs the most context.</p>
        </div>
        <input
          id={allSchemasId}
          type="checkbox"
          checked={allSchemas}
          disabled={disabled || saving}
          onChange={(event) => {
            const next = event.target.checked;
            setAllSchemas(next);
            save({ toolExposureAllSchemas: next }, { successMessage: `Full-schema exposure ${next ? 'enabled' : 'disabled'}` });
          }}
          className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50"
        />
      </div>
    </div>
  );
}
