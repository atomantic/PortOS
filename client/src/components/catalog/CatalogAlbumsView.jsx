import { Library } from 'lucide-react';
import EmptyState from '../EmptyState';
import PageSkeleton from '../ui/PageSkeleton';
import { listCatalogIngredients } from '../../services/apiCatalog';
import CatalogAlbum from './CatalogAlbum';

// Albums grouped view (decision #1: flat universe albums + Raw + Orphaned).
// Album headers show counts from /facets up front; each album lazy-loads its
// cards the first time it is expanded and paginates with Load more. Mounted
// under a `key={dataVersion}` so a mutation remounts it and the lazy loads
// re-run against fresh data. A universe album rolls up its series' members
// server-side (decision #1), so a series-only ingredient still has a home here.
export default function CatalogAlbumsView({ facets, filters, selectedUniverse, selectedSeries, cardProps, onConfirmDelete, pageSize }) {
  if (!facets) {
    return <PageSkeleton header="none" label="Loading albums" cards={3} sidebar={false} />;
  }
  const { universes = [], series = [], unlinkedCount = 0, orphanedCount = 0 } = facets;
  const albumProps = { ...cardProps, onConfirmDelete, pageSize };
  // One page fetcher per album view — paginated so albums never reintroduce the
  // old silent cap. `extra` carries the album selector (unlinked / orphaned / a
  // universe ref); the active type/tag/q filters compose with it so album cards
  // stay consistent with the visible filter state.
  const pageLoader = (extra) => (offset) =>
    listCatalogIngredients({ ...filters, ...extra, limit: pageSize, offset, silent: true })
      .then((d) => (Array.isArray(d?.items) ? d.items : []));

  // A selected universe/series scopes the Albums view to that one album (the
  // grid's ref filter, surfaced as a single open album) so the dropdowns drive
  // albums the same way they drive the grid. Series wins over universe (more
  // specific), mirroring the grid's buildListParams.
  if (selectedSeries) {
    const ser = series.find((s) => s.refId === selectedSeries);
    return (
      <div className="space-y-3">
        <CatalogAlbum
          title={ser?.name || 'Series'}
          subtitle="filtered to the selected series"
          count={ser?.count ?? 0}
          defaultExpanded
          loadPage={pageLoader({ refKind: 'series', refId: selectedSeries })}
          {...albumProps}
        />
      </div>
    );
  }
  if (selectedUniverse) {
    const uni = universes.find((u) => u.refId === selectedUniverse);
    return (
      <div className="space-y-3">
        <CatalogAlbum
          title={uni?.name || 'Universe'}
          subtitle="filtered to the selected universe"
          count={uni?.count ?? 0}
          defaultExpanded
          loadPage={pageLoader({ refKind: 'universe', refId: selectedUniverse })}
          {...albumProps}
        />
      </div>
    );
  }

  const noAlbums = universes.length === 0 && unlinkedCount === 0 && orphanedCount === 0;
  if (noAlbums) {
    return (
      <EmptyState
        icon={Library}
        message="No albums yet — ingest or create ingredients to get started."
        actionLabel="Ingest"
        actionTo="/catalog/ingest"
      />
    );
  }
  return (
    <div className="space-y-3">
      {unlinkedCount > 0 && (
        <CatalogAlbum
          title="Unsorted / Raw"
          subtitle="not yet placed in a universe or series"
          count={unlinkedCount}
          defaultExpanded
          loadPage={pageLoader({ unlinked: true })}
          {...albumProps}
        />
      )}
      {universes.map((u) => (
        <CatalogAlbum
          key={u.refId}
          title={u.name}
          count={u.count}
          loadPage={pageLoader({ refKind: 'universe', refId: u.refId })}
          {...albumProps}
        />
      ))}
      {orphanedCount > 0 && (
        <CatalogAlbum
          title="Orphaned"
          subtitle="linked to a deleted universe/series — re-home these"
          count={orphanedCount}
          loadPage={pageLoader({ orphaned: true })}
          {...albumProps}
        />
      )}
    </div>
  );
}
