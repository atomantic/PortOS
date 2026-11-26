import CatalogSearchPanel from './CatalogSearchPanel';

export default function HuggingFaceSearchPanel({ backend, state, manualInstall }) {
  return (
    <CatalogSearchPanel
      backend={backend}
      state={state}
      placeholder={state.activeCategory === 'audio' ? 'Search Hugging Face audio models…' : 'Search Hugging Face GGUF models…'}
      loadingLabel="Searching Hugging Face"
      manualInstall={manualInstall}
    />
  );
}
