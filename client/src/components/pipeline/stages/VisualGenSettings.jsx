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
import { ChevronDown, ChevronRight, SlidersHorizontal, Sparkles } from 'lucide-react';
import {
  getSettings, listImageModels, getProviders,
} from '../../../services/api';
import { filterSelectableModels } from '../../../utils/providers';
import { deriveAvailableBackends } from '../../../lib/imageGenBackends';
import BackendChipStrip from '../../media/BackendChipStrip';
import ProviderModelSelector from '../../ProviderModelSelector';

const DEFAULT_CONFIG = Object.freeze({
  imageMode: 'auto',
  imageModelId: null,
  refineProvider: null,
  refineModel: null,
});

// "auto" is the default sentinel — the backend strip displays it as a
// dedicated chip that means "follow the server's resolver". The actual
// dispatch happens server-side in visualStages.js#resolveMode.
const AUTO_BACKEND = Object.freeze({ id: 'auto', label: 'Auto', icon: Sparkles });

const MODE_BLURB = {
  auto: 'Auto follows the server default.',
  codex: 'Renders via your logged-in Codex session. Model/steps/seed are picked by Codex.',
  local: 'Renders locally via mflux/diffusers. Pick the model below.',
};

// Cache the three session-stable lookups (settings, image models, providers)
// at module scope so every Comic/Storyboard stage mount on the same Pipeline
// page (or after a remount) reuses the result instead of re-fetching. Stored
// as the in-flight Promise so concurrent mounts don't race. The cache is
// cleared when ANY underlying request failed so a transient error during
// settings/provider startup doesn't lock the panel into stale fallbacks for
// the rest of the SPA session — the next mount retries.
let lookupCache = null;
const loadLookups = () => {
  if (lookupCache) return lookupCache;
  let anyFailed = false;
  const promise = Promise.all([
    getSettings().catch(() => { anyFailed = true; return null; }),
    listImageModels().catch(() => { anyFailed = true; return []; }),
    getProviders().catch(() => { anyFailed = true; return { providers: [] }; }),
  ]).then((vals) => {
    if (anyFailed) lookupCache = null;
    return vals;
  });
  lookupCache = promise;
  return promise;
};

// Mirror of server-side `visualStages.js#resolveMode`. The "Auto →" label in
// this panel must match what the server will actually dispatch — otherwise
// the modal tells the user "Auto is currently Codex" while the render flows
// to local diffusion (or vice versa). Priority:
//   1. settings.imageGen.mode pinned to 'codex' AND codex.enabled   → 'codex'
//   2. settings.imageGen.mode pinned to 'local'                      → 'local'
//   3. settings.imageGen.codex.enabled (auto-default)               → 'codex'
//   4. local pythonPath configured                                   → 'local'
//   5. otherwise                                                     → not configured
// Codex is gated on the enabled flag at every step — a stale 'codex' pin
// from before the toggle was turned off must resolve as local, not Codex.
const resolveAutoLabel = (s) => {
  const codexEnabled = s?.imageGen?.codex?.enabled === true;
  const pinned = s?.imageGen?.mode;
  if (pinned === 'codex' && codexEnabled) return 'Codex';
  if (pinned === 'local') return 'Local diffusion';
  if (codexEnabled) return 'Codex';
  if (s?.imageGen?.local?.pythonPath) return 'Local diffusion';
  return 'Local diffusion (not configured)';
};

const summarizeMode = (cfg, autoResolution) => {
  if (cfg.imageMode === 'auto' && !cfg.imageModelId && !cfg.refineProvider) {
    return `Auto → ${autoResolution.toLowerCase()}`;
  }
  const head = cfg.imageMode === 'auto'
    ? `auto → ${autoResolution.toLowerCase()}`
    : cfg.imageMode;
  const tail = cfg.imageMode === 'local' && cfg.imageModelId ? ` / ${cfg.imageModelId}` : '';
  return `Pinned: ${head}${tail}`;
};

// The actual settings panel body. Extracted so the same controls can live
// either inside a self-contained accordion (legacy inline placement) or
// chromelessly inside a parent-owned container like a settings modal.
function VisualGenSettingsBody({ cfg, update, stageLabel, systemSettings, imageModels, providers, providersLoaded, refineModels, availableBackends, blurb }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
          Image backend
        </div>
        <BackendChipStrip
          availableBackends={availableBackends}
          value={cfg.imageMode}
          onChange={(id) => update({ imageMode: id, ...(id !== 'local' ? { imageModelId: null } : {}) })}
          size="sm"
          ariaLabel={`${stageLabel} image backend`}
          titlePrefix="Render images via"
        />
        <p className="text-[10px] text-gray-500 mt-1">{blurb}</p>
        {cfg.imageMode === 'codex' && !systemSettings?.imageGen?.codex?.enabled && (
          <p className="text-[10px] text-port-warning mt-1">
            Codex Imagegen is disabled in Settings — renders will fall back to local diffusion.
          </p>
        )}
      </div>

      {cfg.imageMode === 'local' && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
            Local image model
          </div>
          <select
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

// Internal hook: all the shared loads (settings / image models / providers)
// plus the derived state every flavor of the panel needs. Returns the
// "props bundle" callers feed straight into <VisualGenSettingsBody>.
// `refreshOnMount` — when true, busts the module-level cache on each mount so
// the panel always fetches fresh settings/providers. Used by VisualGenSettingsPanel
// (mounted inside a Modal that is freshly constructed each open) so users who
// enable Codex or swap providers in Settings see the change immediately on the
// next modal open without reloading the SPA.
function useVisualGenSettings(value, stageLabel, refreshOnMount = false) {
  const cfg = { ...DEFAULT_CONFIG, ...(value || {}) };
  const [systemSettings, setSystemSettings] = useState(null);
  const [imageModels, setImageModels] = useState([]);
  const [providers, setProviders] = useState([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (refreshOnMount) lookupCache = null;
    loadLookups().then(([s, modelList, providerResp]) => {
      if (cancelled) return;
      setSystemSettings(s);
      setImageModels(Array.isArray(modelList) ? modelList : []);
      setProviders((providerResp?.providers || []).filter((p) => p.enabled));
      setProvidersLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  const baseBackends = useMemo(
    () => deriveAvailableBackends(systemSettings, { excludeExternal: true }),
    [systemSettings],
  );
  const availableBackends = useMemo(() => [AUTO_BACKEND, ...baseBackends], [baseBackends]);

  const refineModels = useMemo(() => {
    const p = providers.find((pr) => pr.id === cfg.refineProvider);
    return p ? filterSelectableModels(p.models || [p.defaultModel]) : [];
  }, [providers, cfg.refineProvider]);

  const autoResolution = resolveAutoLabel(systemSettings);
  const summary = summarizeMode(cfg, autoResolution);
  const blurb = cfg.imageMode === 'auto'
    ? `Auto follows the server default — currently ${autoResolution}.`
    : MODE_BLURB[cfg.imageMode];

  return {
    cfg, stageLabel, systemSettings, imageModels, providers, providersLoaded,
    availableBackends, refineModels, summary, blurb,
  };
}

/**
 * Chromeless settings panel — just the controls, no accordion wrapper.
 * Use when embedding inside a Modal or other parent-owned container.
 */
export function VisualGenSettingsPanel({ value, onChange, stageLabel = 'Visual stage' }) {
  const bag = useVisualGenSettings(value, stageLabel, true);
  const update = (patch) => onChange?.({ ...bag.cfg, ...patch });
  return <VisualGenSettingsBody {...bag} update={update} />;
}

/**
 * Summarize the current genConfig in a short line ("Auto → codex",
 * "Pinned: local / flux-1", etc). Exported so a settings trigger button
 * elsewhere can show the same one-liner as the legacy accordion header.
 */
export function summarizeGenConfig(cfg) {
  const merged = { ...DEFAULT_CONFIG, ...(cfg || {}) };
  // We don't have systemSettings on the synchronous call path — the
  // accordion shows "Auto → codex/local"; without the lookups we surface a
  // generic "Auto" instead and let the modal body fill in detail.
  return summarizeMode(merged, 'server default');
}

export default function VisualGenSettings({ value, onChange, stageLabel = 'Visual stage' }) {
  const bag = useVisualGenSettings(value, stageLabel);
  const update = (patch) => onChange?.({ ...bag.cfg, ...patch });
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-port-border bg-port-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-gray-300 hover:text-white"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <SlidersHorizontal size={14} className="text-gray-500" />
        <span className="font-medium">Generation settings</span>
        <span className="ml-2 text-[10px] text-gray-500">{bag.summary}</span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-port-border">
          <VisualGenSettingsBody {...bag} update={update} />
        </div>
      )}
    </div>
  );
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
  if (cfg.imageMode === 'local' && cfg.imageModelId) out.modelId = cfg.imageModelId;
  return out;
}

export function genConfigToRefineOptions(cfg) {
  if (!cfg) return {};
  const out = {};
  if (cfg.refineProvider) out.providerId = cfg.refineProvider;
  if (cfg.refineModel) out.model = cfg.refineModel;
  return out;
}
