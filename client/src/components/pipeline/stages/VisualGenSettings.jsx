/**
 * Per-stage generation settings panel for visual pipeline stages
 * (comicPages, storyboards). Lets the user pick:
 *
 *   - Image backend: 'auto' | 'local' | 'codex'
 *     ('auto' defers to the server resolver — prefers codex when enabled,
 *      else falls back to local diffusion.)
 *   - Local image model (only shown when backend is local).
 *   - LLM provider + model for the "AI: refine" prompt button.
 *
 * Settings persist on `stages.<stageId>.genConfig` so reloads keep the
 * user's choice. Callers pass the current genConfig + an onChange handler
 * that writes the new value via updatePipelineIssue.
 */

import { useEffect, useMemo, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  getSettings, listImageModels, getProviders,
} from '../../../services/api';
import { filterSelectableModels } from '../../../utils/providers';
import {
  deriveAvailableBackends, IMAGE_GEN_MODE, RENDER_TARGET, imageModeCandidates, modeLabel, pickUsableMode,
} from '../../../lib/imageGenBackends';
import BackendChipStrip from '../../media/BackendChipStrip';
import ProviderModelSelector from '../../ProviderModelSelector';
import ListLoadError from '../../ui/ListLoadError';

// Non-destructive image-prompt fan-out (issue #904). MAX mirrors the
// server's IMAGE_PROMPT_CANDIDATE_MAX in refineHelpers.js — keep the two in
// sync so the client never requests a count the server would reject.
export const IMAGE_PROMPT_COUNT_DEFAULT = 3;
export const IMAGE_PROMPT_COUNT_MAX = 6;

const DEFAULT_CONFIG = Object.freeze({
  imageMode: 'auto',
  imageModelId: null,
  refineProvider: null,
  refineModel: null,
  // Trained character-LoRA auto-apply (local renders). Default on; the
  // server only honors an explicit false.
  applyCharacterLoras: true,
});

// "auto" is the default sentinel — the backend strip displays it as a
// dedicated chip that means "follow the server's resolver". The actual
// dispatch happens server-side in pipeline/visualStageHelpers.js#resolveMode.
const AUTO_BACKEND = Object.freeze({ id: 'auto', label: 'Auto', icon: Sparkles });

const MODE_BLURB = {
  auto: 'Auto follows the server default.',
  codex: 'Renders via your logged-in Codex session. Model/steps/seed are picked by Codex.',
  local: 'Renders locally via mflux/diffusers. Pick the model below.',
};

// Each read is settled on its own so one failure doesn't blank the others,
// but a failed read is reported as failed — never as "no providers" / "codex
// disabled" — and the panel offers a Retry.
const LOOKUPS = [
  { key: 'settings', label: 'settings', read: () => getSettings({ silent: true }) },
  { key: 'imageModels', label: 'image models', read: () => listImageModels({ silent: true }) },
  { key: 'providers', label: 'providers', read: () => getProviders({ silent: true }) },
];

// The "Auto →" label in this panel resolves through the SAME shared ladder
// the server dispatches through — `pickUsableMode` + `imageModeCandidates`
// (server/lib/renderModeLadder.js, re-exported via imageGenBackends.js) —
// instead of a hand-copied mirror that can drift from it (#6815): the
// candidate order is `[series pin, pipeline-visual renderDefaults pin,
// settings.imageGen.mode]`, exactly matching
// `pipeline/visualStageHelpers.js#resolveMode`. Local diffusion gets a
// friendlier display name here than the shared `modeLabel` (used by the
// terser chip strip), plus the "(not configured)" suffix when it has no
// pythonPath.
const AUTO_LOCAL_LABEL = 'Local diffusion';
const autoModeLabel = (mode, s) => {
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    return s?.imageGen?.local?.pythonPath ? AUTO_LOCAL_LABEL : `${AUTO_LOCAL_LABEL} (not configured)`;
  }
  return modeLabel(mode);
};

function VisualGenSettingsBody({ cfg, update, stageLabel, systemSettings, settingsLoaded, imageModels, providers, providersLoaded, refineModels, availableBackends, blurb, loadFailures, retryLoad }) {
  return (
    <div className="space-y-3">
      {loadFailures.length > 0 && (
        <ListLoadError what={loadFailures.join(', ')} onRetry={retryLoad} />
      )}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
          Image backend
        </div>
        <BackendChipStrip
          availableBackends={availableBackends}
          value={cfg.imageMode}
          onChange={(id) => update({ imageMode: id, ...(id !== IMAGE_GEN_MODE.LOCAL ? { imageModelId: null } : {}) })}
          size="sm"
          ariaLabel={`${stageLabel} image backend`}
          titlePrefix="Render images via"
        />
        <p className="text-[10px] text-gray-500 mt-1">{blurb}</p>
        {cfg.imageMode === IMAGE_GEN_MODE.CODEX && settingsLoaded && !systemSettings?.imageGen?.codex?.enabled && (
          <p className="text-[10px] text-port-warning mt-1">
            Codex Imagegen is disabled in Settings — renders will fall back to local diffusion.
          </p>
        )}
      </div>

      <div>
        <label className="text-[10px] text-gray-500 inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={cfg.applyCharacterLoras !== false}
            onChange={(e) => update({ applyCharacterLoras: e.target.checked })}
          />
          Auto-apply trained character LoRAs
        </label>
        <p className="text-[10px] text-gray-500 mt-0.5 ml-5">
          Local renders attach a matched character&apos;s trained LoRA + trigger word automatically (codex has no LoRA support).
        </p>
      </div>

      {cfg.imageMode === IMAGE_GEN_MODE.LOCAL && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Local image model
          </div>
          <select
            aria-label="Image model"
            value={cfg.imageModelId || ''}
            onChange={(e) => update({ imageModelId: e.target.value || null })}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs"
          >
            <option value="">Default ({imageModels.find((m) => m.default)?.name || imageModels[0]?.name || 'flux-1'})</option>
            {imageModels.map((m) => (
              <option key={m.id} value={m.id}>{m.name || m.id}</option>
            ))}
          </select>
        </div>
      )}

      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
          AI refine LLM
        </div>
        {providersLoaded && providers.length === 0 ? (
          <p className="text-[10px] text-gray-600 italic">
            No enabled providers — add one in Settings → AI Providers.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1">
              <label className="text-[10px] text-gray-500 inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={!!cfg.refineProvider}
                  disabled={!providersLoaded || providers.length === 0}
                  title={!providersLoaded ? 'Loading providers…' : undefined}
                  onChange={(e) => {
                    if (e.target.checked) {
                      const first = providers[0];
                      update({
                        refineProvider: first.id,
                        refineModel: first.defaultModel || filterSelectableModels(first.models)[0] || '',
                      });
                    } else {
                      update({ refineProvider: null, refineModel: null });
                    }
                  }}
                />
                Override default
              </label>
            </div>
            {cfg.refineProvider && (
              <ProviderModelSelector
                providers={providers}
                selectedProviderId={cfg.refineProvider}
                selectedModel={cfg.refineModel || ''}
                availableModels={refineModels}
                onProviderChange={(id) => {
                  const p = providers.find((pr) => pr.id === id);
                  update({
                    refineProvider: id,
                    refineModel: p?.defaultModel || filterSelectableModels(p?.models)[0] || '',
                  });
                }}
                onModelChange={(model) => update({ refineModel: model })}
                compact
              />
            )}
            <p className="text-[10px] text-gray-500 mt-1">
              Used by the <strong className="text-gray-400">AI: refine</strong> button to rewrite panel/scene descriptions into richer image-gen prompts.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// All the loads (settings / image models / providers) plus the derived state
// the panel body needs. The Drawer unmounts the panel on close, so each open
// fetches fresh values — a provider enabled in Settings shows up on reopen.
// `series` — the owning series record, threaded through to `imageModeCandidates`
// so the "Auto →" label honors a series-level render pin (#6815) the same way
// the server's resolver does. Optional: omit it for a caller with no series in
// scope, which just means that candidate never contributes a pin.
function useVisualGenSettings(value, stageLabel, { series = null } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(value || {}) };
  const [lookups, setLookups] = useState(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLookups(null);
    Promise.allSettled(LOOKUPS.map(({ read }) => read())).then((results) => {
      if (cancelled) return;
      const next = { failed: [] };
      results.forEach((result, i) => {
        const { key, label } = LOOKUPS[i];
        if (result.status === 'fulfilled') next[key] = result.value;
        else next.failed.push(label);
      });
      setLookups(next);
    });
    return () => { cancelled = true; };
  }, [attempt]);

  const systemSettings = lookups?.settings ?? null;
  const settingsLoaded = !!lookups && lookups.settings !== undefined;
  const imageModels = Array.isArray(lookups?.imageModels) ? lookups.imageModels : [];
  const providersLoaded = !!lookups && lookups.providers !== undefined;
  const providers = useMemo(
    () => (lookups?.providers?.providers || []).filter((p) => p.enabled),
    [lookups],
  );
  const loadFailures = lookups?.failed || [];

  const baseBackends = useMemo(
    () => deriveAvailableBackends(systemSettings, { excludeExternal: true }),
    [systemSettings],
  );
  const availableBackends = useMemo(() => [AUTO_BACKEND, ...baseBackends], [baseBackends]);

  const refineModels = useMemo(() => {
    const p = providers.find((pr) => pr.id === cfg.refineProvider);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, cfg.refineProvider]);

  const autoMode = pickUsableMode(systemSettings, imageModeCandidates(systemSettings, RENDER_TARGET.PIPELINE_VISUAL, series));
  // Without the settings there is no "currently X" to name.
  const blurb = cfg.imageMode !== 'auto'
    ? MODE_BLURB[cfg.imageMode]
    : settingsLoaded
      ? `Auto follows the server default — currently ${autoModeLabel(autoMode, systemSettings)}.`
      : MODE_BLURB.auto;

  return {
    cfg, stageLabel, systemSettings, settingsLoaded, imageModels, providers, providersLoaded,
    availableBackends, refineModels, blurb, loadFailures,
    retryLoad: () => setAttempt((n) => n + 1),
  };
}

/**
 * Chromeless settings panel — just the controls, no accordion wrapper.
 * Use when embedding inside a Modal or other parent-owned container.
 */
export function VisualGenSettingsPanel({
  value, onChange, stageLabel = 'Visual stage', series = null,
}) {
  const bag = useVisualGenSettings(value, stageLabel, { series });
  const update = (patch) => onChange?.({ ...bag.cfg, ...patch });
  return <VisualGenSettingsBody {...bag} update={update} />;
}

/**
 * Helper: turn a stage's persisted genConfig into the option overrides
 * that the visual-stage generate APIs expect. Skips fields when the
 * config is set to "auto"/null so the server falls back to its resolver.
 */
export function genConfigToImageOptions(cfg) {
  if (!cfg) return {};
  const out = {};
  if (cfg.imageMode && cfg.imageMode !== 'auto') out.mode = cfg.imageMode;
  if (cfg.imageMode === IMAGE_GEN_MODE.LOCAL && cfg.imageModelId) out.modelId = cfg.imageModelId;
  // Server default is ON — only the explicit opt-out travels.
  if (cfg.applyCharacterLoras === false) out.applyCharacterLoras = false;
  return out;
}

export function genConfigToRefineOptions(cfg) {
  if (!cfg) return {};
  const out = {};
  if (cfg.refineProvider) out.providerId = cfg.refineProvider;
  if (cfg.refineModel) out.model = cfg.refineModel;
  return out;
}
