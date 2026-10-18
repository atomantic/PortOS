import { useCallback } from 'react';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import { listCatalogRelatedImages } from '../../services/apiCatalog';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import CatalogImagePreview from './CatalogImagePreview';

const PAGE_SIZE = 24;

export default function CatalogRelatedImages({ ingredientId, name, excludedFilenames = [] }) {
  const sources = [...new Set(excludedFilenames.filter((filename) => typeof filename === 'string' && filename))].sort();
  return <RelatedImageResults key={JSON.stringify([ingredientId, sources])}
    ingredientId={ingredientId} name={name} excludedFilenames={sources} />;
}

function RelatedImageResults({ ingredientId, name, excludedFilenames }) {
  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const offset = cursor ?? 0;
    const result = await listCatalogRelatedImages(ingredientId, { limit: PAGE_SIZE, offset, signal, silent: true });
    if (!Array.isArray(result?.items) || !Number.isFinite(result.total) || result.total < 0) {
      throw new Error('Unable to read related renders. Please retry.');
    }
    const items = result.items;
    return {
      items: items.map((item) => ({ ...item, id: item.filename })),
      total: result.total,
      nextCursor: items.length && offset + items.length < result.total ? offset + items.length : null,
    };
  }, [ingredientId]);
  const page = usePagedCollection(fetchPage);
  const excluded = new Set(excludedFilenames);
  const images = page.items.filter((item) => typeof item.filename === 'string' && item.filename && !excluded.has(item.filename));

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3" aria-label="Related renders">
      <h2 className="text-sm font-semibold text-white">Related renders</h2>
      <p className="text-xs text-gray-500">Generation metadata links these renders to this item’s images. Images can be shared by several items; appearance has not been verified.</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
        {images.map((item) => (
          <figure key={item.filename} className="min-w-0 rounded border border-port-border overflow-hidden bg-port-bg">
            <CatalogImagePreview src={`/data/images/${encodeURIComponent(item.filename)}`}
              fallbackSrc={`/data/image-refs/${encodeURIComponent(item.filename)}`}
              alt={`${name || 'Item'} related render ${item.filename}`} className="w-full aspect-square object-contain" />
            <figcaption className="text-xs text-gray-400 p-2">
              {item.association === 'derived-image' ? 'Recorded source image'
                : item.association === 'compiled-reference' ? 'Compiled reference request'
                : item.association === 'requested-reference' ? 'Recorded input request' : 'Recorded reference input'}
              {item.provenanceStatus === 'legacy-unverified' && (
                <span className="block text-port-warning mt-1">Legacy metadata · provider use unconfirmed</span>
              )}
              {item.provenanceStatus === 'provider-use-unverified' && (
                <span className="block text-port-warning mt-1">Requested input · provider use unconfirmed</span>
              )}
              {item.provenanceStatus === 'not-supplied' && (
                <span className="block text-port-warning mt-1">Not supplied to the provider</span>
              )}
              {item.missing && <span className="block mt-1 text-port-warning">Image file unavailable</span>}
            </figcaption>
          </figure>
        ))}
      </div>
      {page.loaded && !page.hasMore && !images.length && !page.loading && !page.error && (
        <p className="text-xs text-gray-500">No renders with recorded links to this item’s images.</p>
      )}
      <InfiniteScrollFooter hasMore={page.hasMore} loading={page.loading} error={page.error}
        onLoadMore={page.loadMore} autoLoad={false} label="Load more related renders" endLabel="All recorded related renders loaded" />
    </section>
  );
}
