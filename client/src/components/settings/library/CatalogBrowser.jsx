import { memo, useState } from 'react';
import { Download, Plus, ExternalLink, Play } from 'lucide-react';
import FormField from '../../ui/FormField';
import BrailleSpinner from '../../BrailleSpinner';
import { controlOllamaService } from '../../../services/apiLocalLlm.js';
import { LOCAL_LLM_BACKENDS as BACKENDS, localLlmBackendLabel as labelFor } from '../../../lib/localLlmBackends.js';
import CatalogSearchPanel from './CatalogSearchPanel';
import CatalogModelCard from './CatalogModelCard';
import HuggingFaceSearchPanel from './HuggingFaceSearchPanel';
import useLocalLlmCatalog, { categoryLabel } from './useLocalLlmCatalog';

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

// Install progress can arrive many times per second. The browser only needs
// action transitions and refreshed status, never the individual messages.
export default memo(function CatalogBrowser({
  selected, setSelected, selectedData, actionInProgress, busy, install, installAudio,
  installRuntimeBackend, runAction, reloadCatalogRef,
}) {
  const state = useLocalLlmCatalog(selected, reloadCatalogRef);
  const {
    catalogSource, setCatalogSource, catalog, catalogLoading, catalogError,
    selectedVariants, setSelectedVariants, activeCategory, setActiveCategory, query, visibleCatalogGroups,
  } = state;
  const onVariantChange = (key, variant) => setSelectedVariants((prev) => ({ ...prev, [key]: variant }));
  const [manualId, setManualId] = useState('');
  const selectedOllamaStartupAction = selectedData?.service?.supported ? 'enable' : 'start';
  const selectedOllamaStartupLabel = selectedData?.service?.supported ? 'Run at Startup' : 'Start Ollama';

  const manualInstall = (
    <div className="flex items-center gap-2">
      <FormField label={`Install a ${labelFor(selected)} model by id`} labelClassName="sr-only" className="flex-1 sm:w-56">
        <input
          id="llm-manual-install"
          value={manualId}
          onChange={(e) => setManualId(e.target.value)}
          placeholder={selected === 'ollama' ? 'pull by name e.g. llama3.2' : 'publisher/Model-GGUF'}
          className="w-full flex-1 sm:w-56 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
        />
      </FormField>
      <button
        onClick={() => { const id = manualId.trim(); if (id) { install(id); setManualId(''); } }}
        disabled={busy || !manualId.trim()}
        className="flex items-center gap-1.5 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-sm font-medium rounded-lg disabled:opacity-50"
      >
        <Plus size={14} /> Install
      </button>
    </div>
  );

  return (
    <>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 id="llm-library-heading" className="text-sm font-medium text-gray-300">Models</h2>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <div className="flex items-center gap-1.5 pointer-coarse:gap-2">
            {['recommended', 'huggingface'].map((source) => (
              <button
                key={source}
                onClick={() => { setCatalogSource(source); setActiveCategory('all'); }}
                className={`px-2.5 py-1 pointer-coarse:min-h-11 text-xs rounded transition-colors ${catalogSource === source ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
              >
                {source === 'recommended' ? 'Recommended' : 'Hugging Face'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 pointer-coarse:gap-2">
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                onClick={() => { setSelected(b.id); setActiveCategory('all'); }}
                className={`px-2.5 py-1 pointer-coarse:min-h-11 text-xs rounded transition-colors ${selected === b.id ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {selectedData && !selectedData.available && !selectedData.disabled && (
        <div className="flex items-center gap-2 flex-wrap text-xs text-port-warning">
          <span>
            {selectedData.installed
              ? `${labelFor(selected)} isn't running — ${selected === 'ollama' ? 'use the controls to start it or keep it running at login.' : 'launch the app and enable the local server.'}`
              : `${labelFor(selected)} isn't installed yet.`}
          </span>
          {!selectedData.installed && selectedData.canAutoInstall && (
            <button
              onClick={() => installRuntimeBackend(selected)}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
            >
              {actionInProgress === `runtime-install-${selected}` ? <BrailleSpinner /> : <Download size={12} />}
              Install {labelFor(selected)}
            </button>
          )}
          {!selectedData.installed && !selectedData.canAutoInstall && selectedData.downloadUrl && (
            <a
              href={selectedData.downloadUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white no-underline`}
            >
              <ExternalLink size={12} />
              Download {labelFor(selected)}
            </a>
          )}
          {selected === 'ollama' && selectedData.installed && selectedData.canControl && (
            <button
              onClick={() => runAction(
                `ollama-service-${selectedOllamaStartupAction}-models`,
                () => controlOllamaService(selectedOllamaStartupAction),
                selectedOllamaStartupAction === 'enable' ? 'Ollama will run at login' : 'Ollama is running',
                { ollamaService: true }
              )}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
            >
              {actionInProgress === `ollama-service-${selectedOllamaStartupAction}-models` ? <BrailleSpinner /> : <Play size={12} />}
              {selectedOllamaStartupLabel}
            </button>
          )}
        </div>
      )}
      {catalogSource === 'huggingface' ? (
        <HuggingFaceSearchPanel backend={selected} state={state} manualInstall={manualInstall} />
      ) : (
        <CatalogSearchPanel
          backend={selected}
          state={state}
          placeholder={`Search the ${labelFor(selected)} catalog…`}
          loadingLabel="Loading recommendations"
          manualInstall={manualInstall}
        />
      )}

      {/* Catalog cards */}
      <div className="space-y-4">
        {visibleCatalogGroups.map((group) => (
          <div key={group.category} className="space-y-2">
            {activeCategory === 'all' && (
              <h3 className="text-xs font-medium text-gray-400">{group.label}</h3>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {group.models.map((model) => (
                <CatalogModelCard
                  key={model.key || model.id}
                  model={model}
                  selected={selected}
                  variantId={selectedVariants[model.key]}
                  onVariantChange={onVariantChange}
                  busy={busy}
                  actionInProgress={actionInProgress}
                  install={install}
                  installAudio={installAudio}
                />
              ))}
            </div>
          </div>
        ))}
        {!catalogLoading && !catalogError && catalog.length === 0 && (
          <p className="text-xs text-gray-500">No catalog matches{query ? ` for "${query}"` : ''}.</p>
        )}
        {!catalogLoading && !catalogError && catalog.length > 0 && visibleCatalogGroups.length === 0 && (
          <p className="text-xs text-gray-500">No {categoryLabel(activeCategory)} matches{query ? ` for "${query}"` : ''}.</p>
        )}
      </div>
    </>
  );
});
