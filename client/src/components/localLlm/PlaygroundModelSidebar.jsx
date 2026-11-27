import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Cpu, X } from 'lucide-react';
import { Link } from 'react-router';
import BrailleSpinner from '../BrailleSpinner';
import Pill from '../ui/Pill';
import { localLlmTargetKey } from '../../lib/localLlmTargetKey';
import { formatBytes, recommendedRamGb, timeUntil } from '../../utils/formatters';
import { getNavPageForPath } from '../../../../server/lib/navManifest.js';

const CATEGORY_LABELS = {
  general: 'General purpose',
  coding: 'Coding & agents',
  reasoning: 'Reasoning & analysis',
  vision: 'Image Analysis',
  chat: 'Chat & voice',
  audio: 'Audio & Music',
  embedding: 'Text Embeddings',
  lightweight: 'Small & Fast',
  multilingual: 'Multilingual',
};
const CAPABILITY_LABELS = {
  chat: 'Chat',
  code: 'Code',
  reasoning: 'Reasoning',
  vision: 'Vision',
  embeddings: 'Embeddings',
  tools: 'Tool use',
  multilingual: 'Multilingual',
  classification: 'Classification',
};

function formatExpiresIn(expiresAt) {
  const rel = timeUntil(expiresAt, null);
  return rel ? rel.replace(/^in /, 'frees in ') : null;
}

function modelSizeLabel(model) {
  if (Number.isFinite(model?.size)) return formatBytes(model.size);
  return model?.catalog?.size || '';
}

function getUseCaseTags(model) {
  const tags = [];
  if (model?.catalog?.category) tags.push(CATEGORY_LABELS[model.catalog.category] || model.catalog.category);
  for (const capability of model?.catalog?.capabilities || []) {
    const label = CAPABILITY_LABELS[capability] || capability;
    if (!tags.includes(label)) tags.push(label);
  }
  return tags;
}

export default function PlaygroundModelSidebar({
  backends, backendLabel, installedTargets, selectedTargets, toggleTarget, runningKeys,
  getLoadedOllamaModel, offlineRuntimes, loadingStatus, modelLoadError, runtimeError,
}) {
  const [modelsOpen, setModelsOpen] = useState(false);
  // Nothing is selectable — the install has no local models, or none that pass
  // the hardware filter — so the narrow disclosure opens on that empty state
  // instead of collapsing the prerequisite out of sight.
  //
  // Gated on the INSTALLED list, not on the selection: with models present the
  // page auto-selects the first model, so an initially empty selection should
  // leave the inventory collapsed. A manual close stays closed until the
  // inventory changes.
  useEffect(() => {
    if (loadingStatus || installedTargets.length > 0) return;
    setModelsOpen(true);
  }, [installedTargets.length, loadingStatus]);

  const selectedKeys = useMemo(() => new Set(selectedTargets.map(localLlmTargetKey)), [selectedTargets]);
  // Selections kept while their runtime's inventory is unknown have no picker row, so they get a removable one.
  const unavailableSelected = useMemo(() => {
    const listed = new Set(installedTargets.map(localLlmTargetKey));
    return selectedTargets.filter((target) => !listed.has(localLlmTargetKey(target)));
  }, [installedTargets, selectedTargets]);
  // What the collapsed Models disclosure says it is hiding: the selected model
  // by name when there is one, a count beyond that. Falls back to the raw
  // modelId while the catalog is still loading so the header is never blank.
  const selectionSummary = useMemo(() => {
    if (selectedTargets.length === 0) return 'None selected';
    if (selectedTargets.length > 1) return `${selectedTargets.length} models selected`;
    const key = localLlmTargetKey(selectedTargets[0]);
    const match = installedTargets.find((target) => localLlmTargetKey(target) === key);
    return match?.name || selectedTargets[0].modelId;
  }, [installedTargets, selectedTargets]);

  return (
    <aside className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
      {/* One header slot holding both breakpoints' variants, so the
          aside's `space-y-4` doesn't put a gap above the narrow toggle
          for the desktop heading that is display:none beside it.
          The list is permanently visible on xl+, so the toggle exists
          only on narrow screens — an always-rendered button would report
          `aria-expanded=false` while the desktop sidebar is fully open. */}
      <div>
        <div className="hidden xl:flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-gray-300">Models</span>
          {loadingStatus && <BrailleSpinner />}
        </div>
        <button
          type="button"
          onClick={() => setModelsOpen((v) => !v)}
          className="xl:hidden w-full min-h-11 flex items-center justify-between gap-2"
          aria-expanded={modelsOpen}
          aria-controls="local-llm-models"
        >
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="text-sm font-medium text-gray-300 shrink-0">Models</span>
            <span className="text-xs text-gray-500 truncate">{selectionSummary}</span>
          </span>
          <span className="flex items-center gap-2 shrink-0">
            {loadingStatus && <BrailleSpinner />}
            <span className="text-xs text-port-accent">{modelsOpen ? 'Hide models' : 'Change models'}</span>
            <ChevronDown size={16} className={`text-gray-500 transition-transform ${modelsOpen ? '' : '-rotate-90'}`} />
          </span>
        </button>
      </div>
      <div id="local-llm-models" className={`${modelsOpen ? 'block' : 'hidden'} xl:block space-y-4`}>
        {installedTargets.length === 0 && !loadingStatus ? (
          <p className={`text-sm ${modelLoadError ? 'text-port-warning' : 'text-gray-500'}`}>
            {modelLoadError || 'No installed local models found.'}
          </p>
        ) : (
          <div className="space-y-3">
            {backends.map((backend) => {
              const models = installedTargets.filter((target) => target.backend === backend);
              if (models.length === 0) return null;
              return (
                <div key={backend} className="space-y-2">
                  <div className="text-xs text-gray-500">{backendLabel(backend)}</div>
                  {models.map((target) => {
                    const selected = selectedKeys.has(localLlmTargetKey(target));
                    const size = modelSizeLabel(target);
                    const ram = recommendedRamGb(target?.size, target?.catalog?.size);
                    const tags = getUseCaseTags(target);
                    const loaded = backend === 'ollama' ? getLoadedOllamaModel(target.modelId) : null;
                    const running = runningKeys.has(localLlmTargetKey(target));
                    const freesIn = loaded ? formatExpiresIn(loaded.expiresAt) : null;
                    const detailParts = [
                      target.catalog?.params || target.params,
                      size,
                      ram ? `~${ram} GB RAM` : null,
                    ].filter(Boolean);
                    return (
                      <button
                        key={localLlmTargetKey(target)}
                        onClick={() => toggleTarget(target)}
                        className={`w-full min-h-12 flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${selected ? 'border-port-accent/60 bg-port-accent/10' : 'border-port-border bg-port-bg hover:border-gray-600'}`}
                      >
                        <span className={`w-5 h-5 mt-0.5 rounded border flex items-center justify-center shrink-0 ${selected ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-gray-600 text-transparent'}`}>
                          <Check size={13} />
                        </span>
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="block text-sm text-white truncate">{target.name}</span>
                          <span className="block text-xs text-gray-500 truncate">{target.modelId}</span>
                          {(loaded || running) && (
                            <span className="flex flex-wrap items-center gap-1 pt-0.5">
                              {running ? (
                                <Pill size="xs" tone="bare" bordered={false} className="leading-none bg-port-accent/15 text-port-accent">
                                  <BrailleSpinner />
                                  Processing
                                </Pill>
                              ) : (
                                <Pill size="xs" tone="bare" bordered={false} icon={Cpu} className="leading-none bg-port-success/15 text-port-success">
                                  In memory{Number.isFinite(loaded?.sizeVram) ? ` · ${formatBytes(loaded.sizeVram)}` : ''}
                                </Pill>
                              )}
                              {!running && freesIn && (
                                <Pill size="xs" tone="bare" bordered={false} className="leading-none bg-port-border/70 text-gray-400">{freesIn}</Pill>
                              )}
                            </span>
                          )}
                          {detailParts.length > 0 && (
                            <span className="block text-[11px] text-gray-400 truncate">{detailParts.join(' · ')}</span>
                          )}
                          {target.catalog?.description && (
                            <span className="block text-[11px] leading-snug text-gray-500">{target.catalog.description}</span>
                          )}
                          {tags.length > 0 && (
                            <span className="flex flex-wrap gap-1 pt-0.5">
                              {tags.slice(0, 5).map((tag) => (
                                <span key={tag} className="px-1.5 py-0.5 rounded bg-port-border/70 text-[10px] leading-none text-gray-400">
                                  {tag}
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
        {unavailableSelected.length > 0 && (
          <div className="space-y-1" data-testid="local-llm-unavailable-selected">
            {unavailableSelected.map((target) => (
              <button key={localLlmTargetKey(target)} onClick={() => toggleTarget(target)} className="w-full min-h-10 flex items-center justify-between gap-2 rounded-lg border border-port-warning/40 px-3 py-2 text-left text-xs text-port-warning">
                <span className="truncate">{backendLabel(target.backend)} · {target.modelId} (not listed)</span>
                <X size={13} aria-label={`Remove ${target.modelId}`} />
              </button>
            ))}
          </div>
        )}
        {modelLoadError && installedTargets.length > 0 && (
          <p role="status" className="text-xs text-port-warning">Ollama and LM Studio could not be listed: {modelLoadError}</p>
        )}
        {runtimeError && (
          <p role="status" className="text-xs text-port-warning">Other runtimes could not be listed: {runtimeError}</p>
        )}
        {offlineRuntimes.length > 0 && (
          <div className="space-y-1" data-testid="local-llm-offline-runtimes">
            {offlineRuntimes.map((runtime) => (
              <div key={runtime.id} className="text-xs text-gray-500 flex flex-wrap items-center gap-x-1.5">
                <span className="text-gray-400">{runtime.label}</span>
                <span>{runtime.offline ? 'not running' : 'serves no models'}</span>
                {runtime.error && !/^not reachable/.test(runtime.error) && <span className="text-port-warning">({runtime.error})</span>}
                <Link to="/models/llms-runtimes" className="text-port-accent hover:underline">
                  {getNavPageForPath('/models/llms-runtimes')?.breadcrumb || 'Runtimes'}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
