/**
 * Per-kind context for one canon trunk (Characters / Places / Objects) inside `UniverseCanonSection`.
 *
 * `KindSection` used to take ~30 props (the whole handler + job-state bag threaded through JSX); the parent now publishes the bag once per kind and the section reads it where needed. The value is a fresh object per parent render, as the inline arrows it replaces were; nothing downstream is memoized on its identity.
 * Shape (all supplied by `UniverseCanonSection`): kind, universeId, all, totalCount, filtered, usage, seriesNameMap, fullList, castList, compact, renderingJobs, externalPendingByEntryId, refiningId, expandingId, togglingLockId, bulkLocking, renderingAll, catalogLinking, creating,
 * onRender, onRenderAll, onRenderCleanPlate, onJobCompleted, onJobFailed, onPreview, onRefine, onExpandCharacter, onCatalogLockChanged, onToggleLock, onBulkLock, onPatchEntry, onDescribeImages, onCorrectFromImage, onPickFromCatalog, onAddEntry, onRemoveEntry
 */
import { createContext, useContext } from 'react';

const KindSectionContext = createContext(null);

export function KindSectionProvider({ value, children }) {
  return (
    <KindSectionContext.Provider value={value}>
      {children}
    </KindSectionContext.Provider>
  );
}

// Fail fast: a missing provider is always a wiring bug, never a valid state.
export function useKindSection() {
  const ctx = useContext(KindSectionContext);
  if (!ctx) throw new Error('useKindSection must be used inside a KindSectionProvider');
  return ctx;
}

export default KindSectionContext;
