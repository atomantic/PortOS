import { Search } from 'lucide-react';
import FormField from '../../ui/FormField';
import BrailleSpinner from '../../BrailleSpinner';
import ListLoadError from '../../ui/ListLoadError';
import { localLlmBackendLabel } from '../../../lib/localLlmBackends.js';

export default function CatalogSearchPanel({ backend, state, placeholder, loadingLabel, manualInstall }) {
  const {
    query, setQuery, catalog, catalogLoading, catalogError, systemMemoryGb,
    catalogCategories, activeCategory, setActiveCategory, reloadCatalog,
  } = state;
  return (
    <>
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex-1 flex items-center gap-2 bg-port-bg border border-port-border rounded-lg px-3 focus-within:border-port-accent">
          <Search size={14} className="text-gray-500" />
          <FormField label={`Search the ${localLlmBackendLabel(backend)} model catalog`} labelClassName="sr-only" className="flex-1">
            <input
              id="llm-catalog-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="w-full flex-1 bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none"
            />
          </FormField>
        </div>
        {manualInstall}
      </div>

      {catalogCategories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pointer-coarse:gap-2">
          <button
            onClick={() => setActiveCategory('all')}
            className={`px-2.5 py-1 pointer-coarse:min-h-11 text-xs rounded transition-colors ${activeCategory === 'all' ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
          >
            All ({catalog.length})
          </button>
          {catalogCategories.map((category) => (
            <button
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`px-2.5 py-1 pointer-coarse:min-h-11 text-xs rounded transition-colors ${activeCategory === category.id ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
            >
              {category.label}{category.count != null ? ` (${category.count})` : ''}
            </button>
          ))}
        </div>
      )}

      {catalogLoading && (
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <BrailleSpinner />
          {loadingLabel}
        </div>
      )}
      {catalogError && (
        <ListLoadError what="model catalog" error={catalogError} onRetry={reloadCatalog} />
      )}
      {Number.isFinite(systemMemoryGb) && catalog.some((m) => Array.isArray(m.variants) && m.variants.length > 1) && (
        <p className="text-[11px] text-gray-500">
          This machine has {systemMemoryGb} GB of memory — the default quant is the highest-fidelity build that fits. Use the Quant menu on a result to choose a smaller or larger one.
        </p>
      )}
    </>
  );
}
