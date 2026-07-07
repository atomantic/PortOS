import { Plus, Trash2, Brain } from 'lucide-react';
import Banner from '../ui/Banner';
import ProviderModelSelector from '../ProviderModelSelector';
import { filterSelectableModels } from '../../utils/providers';

// The self-improvement loop's per-app config surface. Field set mirrors the
// server schema (server/lib/validation.js `layeredIntelligenceConfigSchema`)
// and the effective-config accessor (server/services/layeredIntelligence.js).
// Off by default — the loop is a user-enabled scheduled automation.

// The Layer-1 telemetry toggles the loop can gather. Keep in sync with the
// server `sources` object (custom[] file sources are handled separately below).
export const LI_SOURCE_FIELDS = [
  { key: 'goals', label: 'Goals (GOALS.md)', hint: 'The app\'s inferred/authored product goals' },
  { key: 'cosMetrics', label: 'CoS metrics', hint: 'Recent autonomous-agent run stats for this app' },
  { key: 'healthReport', label: 'Health report', hint: 'Latest health / lint / test summary' },
  { key: 'planMd', label: 'PLAN.md', hint: 'The app\'s open work-plan items' },
  { key: 'openIssues', label: 'Open issues', hint: 'Currently open tracker issues' }
];

// The proposal scopes the loop may file. loop-meta / portos-self extend the loop
// itself (which lives in the PortOS repo), so they only apply to the PortOS
// baseline app — mirrors PORTOS_ONLY_SCOPES on the server.
export const LI_SCOPES = [
  { id: 'app-improvement', label: 'App improvement', portosOnly: false, hint: 'Propose feature/quality improvements to this app' },
  { id: 'app-data-gap', label: 'App data gap', portosOnly: false, hint: 'Propose new telemetry/data the loop should gather' },
  { id: 'loop-meta', label: 'Loop meta', portosOnly: true, hint: 'Improve the intelligence loop itself (PortOS only)' },
  { id: 'portos-self', label: 'PortOS self', portosOnly: true, hint: 'Improve PortOS itself (PortOS only)' }
];

const INPUT_CLASS = 'w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white focus:border-port-accent focus:outline-hidden';

// Common cadences for the interval select. Values are milliseconds; the schema
// floor is 60_000 (1 minute). A stored non-preset value renders as "Custom".
export const LI_INTERVAL_PRESETS = [
  { ms: 60 * 60 * 1000, label: 'Hourly' },
  { ms: 6 * 60 * 60 * 1000, label: 'Every 6 hours' },
  { ms: 12 * 60 * 60 * 1000, label: 'Every 12 hours' },
  { ms: 24 * 60 * 60 * 1000, label: 'Daily' },
  { ms: 7 * 24 * 60 * 60 * 1000, label: 'Weekly' }
];

// Deep-equal two allowedScopes arrays regardless of order.
function sameScopes(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every(s => sb.has(s));
}

function sameCustom(a, b) {
  const A = Array.isArray(a) ? a : [];
  const B = Array.isArray(b) ? b : [];
  if (A.length !== B.length) return false;
  return A.every((s, i) => s?.type === B[i]?.type && s?.ref === B[i]?.ref);
}

/**
 * Build the minimal Layered Intelligence PATCH: only the top-level keys whose
 * value differs from the effective baseline the drawer loaded. Sending the full
 * effective config would persist every default to disk and freeze this install
 * against future default changes — the server's merge-over-stored contract
 * (updateAppLayeredIntelligence) depends on untouched fields staying absent.
 * Returns null when nothing changed (caller then omits `layeredIntelligence`).
 * providerId/model normalize '' → null (the "use default" sentinel).
 */
export function buildLayeredIntelligenceUpdate(baseline, current) {
  if (!baseline || !current) return null;
  const update = {};
  if (!!current.enabled !== !!baseline.enabled) update.enabled = !!current.enabled;
  if (current.intervalMs !== baseline.intervalMs) update.intervalMs = current.intervalMs;
  const curProvider = current.providerId || null;
  if (curProvider !== (baseline.providerId || null)) update.providerId = curProvider;
  const curModel = current.model || null;
  if (curModel !== (baseline.model || null)) update.model = curModel;
  if ((current.rules || '') !== (baseline.rules || '')) update.rules = current.rules || '';

  const curSources = current.sources || {};
  const baseSources = baseline.sources || {};
  const toggleChanged = LI_SOURCE_FIELDS.some(f => !!curSources[f.key] !== !!baseSources[f.key]);
  const customChanged = !sameCustom(curSources.custom, baseSources.custom);
  if (toggleChanged || customChanged) {
    update.sources = {
      ...Object.fromEntries(LI_SOURCE_FIELDS.map(f => [f.key, !!curSources[f.key]])),
      custom: (Array.isArray(curSources.custom) ? curSources.custom : [])
        .map(s => ({ type: 'file', ref: String(s?.ref || '').trim() }))
        .filter(s => s.ref)
    };
  }

  if (!sameScopes(current.allowedScopes, baseline.allowedScopes)) {
    update.allowedScopes = Array.isArray(current.allowedScopes) ? current.allowedScopes : [];
  }

  return Object.keys(update).length > 0 ? update : null;
}

/**
 * Presentational Layered Intelligence config tab. All mutable state lives in the
 * parent EditAppDrawer's `formData` (the Drawer body remounts per tab), so this
 * component is fully controlled: it reads the `li` slice and calls `onChange`
 * with a partial update. `sources` updates merge one level deep here so a single
 * toggle doesn't wipe the others.
 */
export default function LayeredIntelligenceTab({ li, onChange, providers, isPortos, loaded }) {
  if (!loaded) {
    return <div className="text-sm text-gray-500">Loading Layered Intelligence config…</div>;
  }

  const sources = li.sources || {};
  const custom = Array.isArray(sources.custom) ? sources.custom : [];
  const allowedScopes = Array.isArray(li.allowedScopes) ? li.allowedScopes : [];
  const isPreset = LI_INTERVAL_PRESETS.some(p => p.ms === li.intervalMs);

  const setSources = (patch) => onChange({ sources: { ...sources, ...patch } });
  const setCustom = (next) => setSources({ custom: next });

  const currentProvider = providers.find(p => p.id === li.providerId);
  const availableModels = currentProvider
    ? filterSelectableModels(currentProvider.models || [currentProvider.defaultModel])
    : [];

  const toggleScope = (id, on) => {
    const next = on ? [...new Set([...allowedScopes, id])] : allowedScopes.filter(s => s !== id);
    onChange({ allowedScopes: next });
  };

  const visibleScopes = LI_SCOPES.filter(s => !s.portosOnly || isPortos);

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Brain size={16} className="text-port-accent mt-0.5 shrink-0" />
        <p className="text-xs text-gray-500">
          The Layered Intelligence Loop perpetually reviews this app&apos;s telemetry and files improvement proposals via CoS. Off by default — it runs on the schedule below only when enabled.
        </p>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={!!li.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
          className="rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
        />
        <span className="text-sm text-white">Enable the self-improvement loop for this app</span>
      </label>

      <div>
        <label htmlFor="li-interval" className="block text-sm text-gray-400 mb-1">Run interval</label>
        <select
          id="li-interval"
          value={isPreset ? String(li.intervalMs) : 'custom'}
          onChange={e => {
            if (e.target.value === 'custom') return;
            onChange({ intervalMs: Number(e.target.value) });
          }}
          className={INPUT_CLASS}
        >
          {LI_INTERVAL_PRESETS.map(p => (
            <option key={p.ms} value={String(p.ms)}>{p.label}</option>
          ))}
          {!isPreset && <option value="custom">Custom ({Math.round(li.intervalMs / 60000)} min)</option>}
        </select>
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-1">AI provider</span>
        <ProviderModelSelector
          providers={providers}
          selectedProviderId={li.providerId || ''}
          selectedModel={li.model || ''}
          availableModels={availableModels}
          onProviderChange={id => onChange({ providerId: id || null, model: '' })}
          onModelChange={model => onChange({ model: model || null })}
          label="Provider"
          emptyProviderOption="Use default provider"
          emptyModelOption="Default model"
          alwaysShowModel
        />
        <p className="text-xs text-gray-500 mt-1">Leave on &quot;Use default provider&quot; to run the loop with the active CoS provider.</p>
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-2">Telemetry sources</span>
        <div className="space-y-2">
          {LI_SOURCE_FIELDS.map(f => (
            <label key={f.key} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!sources[f.key]}
                onChange={e => setSources({ [f.key]: e.target.checked })}
                className="mt-1 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <span className="text-sm text-white">{f.label}<span className="block text-xs text-gray-500">{f.hint}</span></span>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">Custom file sources</span>
          <button
            type="button"
            onClick={() => setCustom([...custom, { type: 'file', ref: '' }])}
            className="flex items-center gap-1 text-xs px-2 py-1 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded"
          >
            <Plus size={12} /> Add file
          </button>
        </div>
        {custom.length === 0 ? (
          <p className="text-xs text-gray-500">No custom sources. Add a repo-relative file (e.g. <code className="text-gray-400">docs/metrics.md</code>) to feed it into the loop&apos;s prompt.</p>
        ) : (
          <div className="space-y-2">
            {custom.map((src, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={src.ref || ''}
                  onChange={e => setCustom(custom.map((s, j) => j === i ? { ...s, ref: e.target.value } : s))}
                  className={INPUT_CLASS}
                  placeholder="repo-relative path, e.g. docs/metrics.md"
                  aria-label={`Custom file source ${i + 1}`}
                />
                <button
                  type="button"
                  onClick={() => setCustom(custom.filter((_, j) => j !== i))}
                  className="p-2 text-gray-500 hover:text-port-error shrink-0"
                  aria-label={`Remove custom source ${i + 1}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <p className="text-xs text-gray-500">Paths must be repo-relative — no leading <code>/</code> and no <code>..</code> segments.</p>
          </div>
        )}
      </div>

      <div>
        <label htmlFor="li-rules" className="block text-sm text-gray-400 mb-1">Guidance rules</label>
        <textarea
          id="li-rules"
          value={li.rules || ''}
          onChange={e => onChange({ rules: e.target.value })}
          className={`${INPUT_CLASS} font-mono text-sm`}
          rows={4}
          placeholder="Free-text guidance for the loop (e.g. 'Prioritize accessibility fixes; never propose new dependencies.')"
          maxLength={8000}
        />
      </div>

      <div>
        <span className="block text-sm text-gray-400 mb-2">Allowed proposal scopes</span>
        <div className="space-y-2">
          {visibleScopes.map(s => (
            <label key={s.id} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowedScopes.includes(s.id)}
                onChange={e => toggleScope(s.id, e.target.checked)}
                className="mt-1 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
              />
              <span className="text-sm text-white">{s.label}<span className="block text-xs text-gray-500">{s.hint}</span></span>
            </label>
          ))}
        </div>
        {!isPortos && (
          <Banner tone="info" size="sm" className="mt-2">
            Loop-meta and PortOS-self scopes are only available on the PortOS baseline app.
          </Banner>
        )}
      </div>
    </div>
  );
}
