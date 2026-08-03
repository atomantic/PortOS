/**
 * Per-kind context for one canon trunk (Characters / Places / Objects) inside
 * `UniverseCanonSection`.
 *
 * `KindSection` used to take ~30 props — the whole handler + job-state bag was
 * threaded manually through JSX, so adding one capability meant touching the
 * call site, the signature, and every default. The bag is now published once
 * per kind by the parent and read where it's needed, which keeps the call site
 * a single `<KindSection />` and makes the section's dependencies explicit at
 * the point of use.
 *
 * The value is intentionally a fresh object per parent render — identical to
 * the previous prop-threading behavior, where every inline arrow (`onRender`,
 * `onToggleLock`, …) also reallocated each render. Nothing downstream is
 * memoized on the bag's identity, so there's no re-render regression here.
 *
 * Shape (all supplied by `UniverseCanonSection`):
 *   kind, universeId, all, totalCount, filtered, usage, seriesNameMap,
 *   fullList, castList, compact,
 *   renderingJobs, externalPendingByEntryId,
 *   refiningId, expandingId, togglingLockId, bulkLocking, renderingAll,
 *   catalogLinking, creating,
 *   onRender, onRenderAll, onRenderCleanPlate, onJobCompleted, onJobFailed,
 *   onPreview, onRefine, onExpandCharacter, onSheetCompleted, onSheetDeleted,
 *   onToggleLock, onBulkLock, onPatchEntry, onDescribeImages,
 *   onCorrectFromImage, onPickFromCatalog, onAddEntry
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

// Fail fast rather than silently rendering a section with no handlers — a
// missing provider is always a wiring bug, never a valid state.
export function useKindSection() {
  const ctx = useContext(KindSectionContext);
  if (!ctx) throw new Error('useKindSection must be used inside a KindSectionProvider');
  return ctx;
}

export default KindSectionContext;
