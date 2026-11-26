import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getLocalLlmCatalog, getLocalLlmHuggingFaceSearch } from '../../../services/apiLocalLlm.js';

const CATEGORY_LABELS = {
  general: 'General purpose',
  coding: 'Coding & agents',
  security: 'Security specialists',
  'security-uncensored': 'Security · Uncensored / abliterated',
  reasoning: 'Reasoning & analysis',
  vision: 'Image Analysis',
  chat: 'Chat & voice',
  writing: 'Fiction & writing',
  audio: 'Audio & Music',
  embedding: 'Text Embeddings',
  lightweight: 'Small & Fast',
  multilingual: 'Multilingual'
};
const CATEGORY_ORDER = ['general', 'coding', 'security', 'security-uncensored', 'writing', 'reasoning', 'vision', 'chat', 'lightweight', 'multilingual', 'embedding', 'audio'];
export const categoryLabel = (id) => CATEGORY_LABELS[id] || id;
const primaryCategoryFor = (model) => model?.category || 'general';
const recommendationCategoriesFor = (model) => {
  const categories = model?.recommendedFor;
  return Array.isArray(categories) && categories.length ? categories : [primaryCategoryFor(model)];
};
const isRecommendedForCategory = (model, category) => recommendationCategoriesFor(model).includes(category);

const EMPTY_CATALOG = [];

export default function useLocalLlmCatalog(selected, reloadCatalogRef) {
  const [catalogSource, setCatalogSource] = useState('recommended');
  const [catalogResult, setCatalogResult] = useState({ key: null, models: [], loading: true, error: null });
  // Total unified/system memory (GB) reported by the HF search, used to caption
  // the RAM-aware quant defaults. null until the first Hugging Face search.
  const [systemMemoryGb, setSystemMemoryGb] = useState(null);
  // Per-result quant override: { [repoKey]: installId }. Empty → use each
  // result's RAM-aware default (`m.id`). Cleared whenever the catalog reloads.
  const [selectedVariants, setSelectedVariants] = useState({});
  const [activeCategory, setActiveCategory] = useState('all');
  const [query, setQuery] = useState('');
  const catalogRequestId = useRef(0);

  // `source` and `category` are required rather than defaulted from state: a
  // state default would put them in the dep list, so `loadCatalog`'s identity
  // would change on every category click and re-trigger the debounce effect —
  // the exact refetch the effect below is written to avoid. Every call site
  // passes both.
  const loadCatalog = useCallback((backend, q, source, category, key) => {
    const requestId = ++catalogRequestId.current;
    setCatalogResult((prev) => ({ key, models: prev.key === key ? prev.models : [], loading: true, error: null }));
    const request = source === 'huggingface'
      ? getLocalLlmHuggingFaceSearch(backend, q, category, 18, { silent: true })
      : getLocalLlmCatalog(backend, q, { variants: true, silent: true });
    return request
      .then((r) => {
        if (requestId !== catalogRequestId.current) return;
        setCatalogResult({ key, models: r.models || [], loading: false, error: null });
        if (Number.isFinite(r.systemMemoryGb)) setSystemMemoryGb(r.systemMemoryGb);
        // A fresh result set invalidates any per-card quant overrides.
        setSelectedVariants({});
      })
      .catch((err) => {
        if (requestId !== catalogRequestId.current) return;
        setCatalogResult((prev) => ({ ...prev, loading: false, error: err }));
      });
  }, []);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  //
  // `activeCategory` is a trigger for the Hugging Face source ONLY — the live
  // search asks the Hub for that category's models, so switching tabs is a new
  // query. The curated catalog sends just backend+q and filters by category on
  // the client (see visibleCatalogGroups), so refetching on a tab click would
  // re-request a byte-identical list AND re-run the server's ~36-repo variant
  // enrichment. `catalogCategoryKey` is the category when it matters and a
  // constant when it doesn't, which keeps the whole effect one code path.
  const catalogCategoryKey = catalogSource === 'huggingface' ? activeCategory : 'client-filtered';
  const catalogKey = JSON.stringify([selected, query, catalogSource, catalogCategoryKey]);
  const catalog = catalogResult.key === catalogKey ? catalogResult.models : EMPTY_CATALOG;
  const catalogLoading = catalogResult.key !== catalogKey || catalogResult.loading;
  const catalogError = catalogResult.key === catalogKey ? catalogResult.error : null;
  const reloadCatalog = useCallback(
    () => loadCatalog(selected, query, catalogSource, catalogCategoryKey, catalogKey),
    [selected, query, catalogSource, catalogCategoryKey, catalogKey, loadCatalog],
  );
  useEffect(() => {
    reloadCatalogRef.current = reloadCatalog;
    const timer = setTimeout(reloadCatalog, catalogSource === 'huggingface' ? 450 : 250);
    return () => {
      reloadCatalogRef.current = null;
      clearTimeout(timer);
      catalogRequestId.current += 1;
    };
  }, [catalogSource, reloadCatalog, reloadCatalogRef]);

  const catalogCategories = useMemo(() => {
    const counts = new Map();
    for (const model of catalog) {
      for (const category of recommendationCategoriesFor(model)) {
        counts.set(category, (counts.get(category) || 0) + 1);
      }
    }
    // Hugging Face is searched per-category server-side, so a default GGUF query
    // never surfaces audio results — expose the full category set as filter
    // buttons (count shown only when known) so the user can navigate to
    // categories like Audio & Music. Curated counts include every lane a model
    // is recommended for; the unfiltered groups below still use one primary
    // lane per model, so broad models never duplicate in All.
    const ids = catalogSource === 'huggingface'
      ? CATEGORY_ORDER
      : CATEGORY_ORDER.filter((id) => counts.has(id));
    return ids.map((id) => ({ id, label: categoryLabel(id), count: counts.has(id) ? counts.get(id) : null }));
  }, [catalog, catalogSource]);
  const visibleCatalogGroups = useMemo(() => {
    const filterCategory = catalogSource === 'huggingface' ? 'all' : activeCategory;
    const categoryIds = filterCategory === 'all'
      ? CATEGORY_ORDER.filter((category) => catalog.some((model) => primaryCategoryFor(model) === category))
      : [filterCategory];
    return categoryIds
      .map((category) => ({
        category,
        label: categoryLabel(category),
        // A featured recommendation leads every relevant lane, including the
        // broad All view, instead of being buried by the catalog's source order.
        models: catalog
          .filter((model) => (
            filterCategory === 'all'
              ? primaryCategoryFor(model) === category
              : isRecommendedForCategory(model, category)
          ))
          .sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)))
      }))
      .filter((group) => group.models.length > 0);
  }, [activeCategory, catalog, catalogSource]);


  return {
    catalogSource, setCatalogSource, catalog, catalogLoading, catalogError, systemMemoryGb,
    selectedVariants, setSelectedVariants, activeCategory, setActiveCategory, query, setQuery,
    catalogCategories, visibleCatalogGroups, reloadCatalog,
  };
}
