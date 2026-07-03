import { useEffect, useMemo, useState } from 'react';
import toast from '../ui/Toast';
import ProviderModelSelector from '../ProviderModelSelector';
import { FormField } from '../ui/FormField';
import useFieldDraft from '../../hooks/useFieldDraft';
import { filterSelectableModels, getProviderTimeout } from '../../utils/providers';
import {
  formatDurationMs,
  parseTimeoutMs,
  TIMEOUT_INPUT_MIN_MS,
  TIMEOUT_INPUT_MAX_MS,
  TIMEOUT_INPUT_STEP_MS,
} from '../../utils/formatters';

/**
 * Inline picker for a prompt stage's provider+model. Mirrors the Tier/Specific
 * toggle in PromptManager so any panel that runs an LLM stage (Adapt, Evaluate,
 * Format, Characters) can configure it locally without sending the user to
 * /prompts. Persists via PUT /api/prompts/<stageName>.
 */
export default function StagePromptModelPicker({ stageName, label = 'Stage LLM', icon = null, hint = null }) {
  const [stage, setStage] = useState(null);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([
      fetch(`/api/prompts/${encodeURIComponent(stageName)}`, { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/providers', { signal }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([s, p]) => {
      if (cancelled) return;
      // Normalize stage.timeout through parseTimeoutMs so a legacy on-disk
      // garbage value (e.g. `'abc'` from a pre-validation install) doesn't
      // flow into the number input (where it would render blank / log
      // controlled-component warnings) and doesn't poison the hint logic.
      // Accepts integers AND digit-only strings within range; everything
      // else becomes `null` (no override).
      const normalizedStage = s ? { ...s, timeout: parseTimeoutMs(s.timeout) } : null;
      setStage(normalizedStage);
      setProviders((p?.providers || []).filter((x) => x.enabled));
      setActiveProviderId(p?.activeProvider || null);
      setLoaded(true);
    });
    return () => { cancelled = true; controller.abort(); };
  }, [stageName]);

  const persist = async (next) => {
    // Snapshot the previous stage from the current closure value BEFORE
    // calling setStage. Capturing inside the setStage updater is unsafe
    // under React 18 concurrent rendering / StrictMode — updaters can be
    // re-run or deferred, leaving the side-effect-captured snapshot
    // unreliable. The closure value is stable for this call.
    const prevStage = stage;
    setSaving(true);
    setStage((prev) => ({ ...prev, ...next }));
    // Only include fields the caller actually wants to change. provider/model
    // are sent together because the picker drives them as one switch;
    // timeout is independent.
    const body = {};
    if ('provider' in next) body.provider = next.provider ?? null;
    if ('model' in next) body.model = next.model;
    if ('timeout' in next) body.timeout = next.timeout;
    const res = await fetch(`/api/prompts/${encodeURIComponent(stageName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      // Roll back the optimistic update so the picker UI doesn't show a
      // provider/model that wasn't actually persisted server-side.
      setStage(prevStage);
      toast.error(`Failed to save ${label}: ${await res.text().catch(() => res.statusText)}`);
    }
  };

  // Hooks must run in the same order every render — keep useMemo above the
  // early-return guards or React's hooks-rule check fires.
  const modelsForProvider = useMemo(() => {
    const p = providers.find((pr) => pr.id === stage?.provider);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, stage?.provider]);

  if (!loaded) return null;
  if (!stage) {
    return (
      <div className="text-[11px] text-port-error">
        Stage <code>{stageName}</code> not found — open Prompts to create it.
      </div>
    );
  }

  const isSpecific = !!stage.provider;

  const switchToTier = () => {
    if (!isSpecific) return;
    persist({ provider: null, model: 'default' });
  };
  const switchToSpecific = () => {
    if (isSpecific) return;
    const first = providers[0];
    if (!first) return;
    persist({ provider: first.id, model: first.defaultModel || filterSelectableModels(first.models)[0] || '' });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-gray-500 flex items-center gap-1">
          {icon}{label}
          {saving && <span className="text-gray-600 normal-case">· saving…</span>}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={switchToTier}
            className={`px-1.5 py-0.5 text-[9px] rounded ${!isSpecific ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'}`}
          >
            Tier
          </button>
          <button
            type="button"
            onClick={switchToSpecific}
            disabled={providers.length === 0}
            className={`px-1.5 py-0.5 text-[9px] rounded ${isSpecific ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'} disabled:opacity-50`}
          >
            Specific
          </button>
        </div>
      </div>

      {!isSpecific ? (
        <select
          value={stage.model || 'default'}
          onChange={(e) => persist({ provider: null, model: e.target.value })}
          className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
        >
          <option value="default">Default — use the active provider's default model</option>
          <option value="quick">Quick — provider's light/fast model</option>
          <option value="coding">Coding — provider's medium model</option>
          <option value="heavy">Heavy — provider's heavy model</option>
        </select>
      ) : (
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={stage.provider}
          selectedModel={stage.model || ''}
          availableModels={modelsForProvider}
          onProviderChange={(id) => {
            const p = providers.find((pr) => pr.id === id);
            persist({ provider: id, model: p?.defaultModel || filterSelectableModels(p?.models)[0] || '' });
          }}
          onModelChange={(model) => persist({ provider: stage.provider, model })}
          compact
        />
      )}

      <StageTimeoutInput
        value={stage.timeout}
        providerFallback={getProviderTimeout(providers, stage.provider, activeProviderId)}
        onCommit={(ms) => persist({ timeout: ms })}
      />

      {hint && <div className="text-[10px] text-gray-500">{hint}</div>}
    </div>
  );
}

// Inline numeric input for stage.timeout (ms). Built on `useFieldDraft` so
// the parent's optimistic state update doesn't race the user's keystrokes —
// the hook returns the persisted value until the user actually types.
function StageTimeoutInput({ value, providerFallback, onCommit }) {
  const { value: draft, onChange, onBlur: hookBlur } = useFieldDraft(value, (raw) => {
    const ms = parseTimeoutMs(raw);
    // parseTimeoutMs returns null both for blank input (intentional clear)
    // and for any non-positive/garbage value. Honor the clear; refuse the
    // garbage by leaving `value` unchanged — useFieldDraft will snap the
    // input back to persisted on the next render.
    if (raw.trim() !== '' && ms == null) return;
    if (ms !== value) onCommit(ms);
  });

  // Hint precedence: explicit override > provider fallback > nothing.
  // Coerce to a finite number before formatting — a legacy on-disk garbage
  // value (e.g. `timeout: "abc"` from a pre-validation install) reaches us
  // as a string, and `formatDurationMs(NaN)` renders "NaNh NaNm".
  const usingDefault = value == null || value <= 0;
  const candidate = usingDefault ? providerFallback : value;
  const effectiveMs = Number(candidate);
  const haveValidEffective = Number.isFinite(effectiveMs) && effectiveMs > 0;
  let hint;
  if (!haveValidEffective) {
    hint = 'No provider default set';
  } else if (usingDefault) {
    hint = `≈ ${formatDurationMs(effectiveMs)} · using provider default`;
  } else {
    hint = `≈ ${formatDurationMs(effectiveMs)}`;
  }

  return (
    <FormField
      className="space-y-0.5"
      labelClassName="block text-[9px] uppercase tracking-wider text-gray-500"
      label="Timeout override (ms)"
    >
      <input
        type="number"
        inputMode="numeric"
        min={TIMEOUT_INPUT_MIN_MS}
        max={TIMEOUT_INPUT_MAX_MS}
        step={TIMEOUT_INPUT_STEP_MS}
        value={draft}
        onChange={onChange}
        onBlur={hookBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder={providerFallback != null ? String(providerFallback) : ''}
        className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-[11px] text-gray-200"
      />
      <div className="text-[10px] text-gray-500">{hint}</div>
    </FormField>
  );
}
