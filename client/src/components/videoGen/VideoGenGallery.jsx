import { Link } from 'react-router-dom';
import MediaCard from '../media/MediaCard';
import FavoritesFilterChip from '../media/FavoritesFilterChip';
import { normalizeVideo } from '../media/normalize';

// Gallery sections for VideoGen.jsx (#2834): "Recent renders" (favorites-
// filterable, capped at 5 with a View-all link) and the collapsible "hidden"
// group. Both drive the same MediaPreview via `onPreview`. Extracted verbatim —
// note the hidden section intentionally omits Upscale (matching the original).
export default function VideoGenGallery({
  galleryVisible, galleryHidden, favoritesOnly, showHidden,
  onToggleFavorites, onToggleShowHidden,
  onPreview, onContinue, onUpscale, onDelete, onToggleHidden, getCardProps,
}) {
  return (
    <>
      {(galleryVisible.length > 0 || favoritesOnly) && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent renders ({Math.min(galleryVisible.length, 5)} of {galleryVisible.length})</h2>
            <div className="flex items-center gap-2">
              <FavoritesFilterChip active={favoritesOnly} onToggle={onToggleFavorites} />
              {galleryVisible.length > 5 && (
                <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>
              )}
            </div>
          </div>
          {galleryVisible.length === 0 ? (
            <div className="text-xs text-gray-500 py-3">No favorited videos yet.</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {galleryVisible.slice(0, 5).map((v) => {
                const item = normalizeVideo(v);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => onPreview(item)}
                    onContinue={() => onContinue(v)}
                    onUpscale={() => onUpscale(v)}
                    onDelete={() => onDelete(v)}
                    onToggleHidden={() => onToggleHidden(v)}
                    {...getCardProps(item.key)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}

      {galleryHidden.length > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <button
            type="button"
            onClick={onToggleShowHidden}
            className="flex items-center justify-between w-full text-xs font-medium text-gray-400 uppercase tracking-wide hover:text-white"
          >
            <span>{showHidden ? 'Hide' : 'Show'} hidden ({galleryHidden.length})</span>
            <span className="text-xs text-gray-500">{showHidden ? '▾' : '▸'}</span>
          </button>
          {showHidden && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {galleryHidden.map((v) => {
                const item = normalizeVideo(v);
                return (
                  <MediaCard
                    key={item.key}
                    item={item}
                    onPreview={() => onPreview(item)}
                    onContinue={() => onContinue(v)}
                    onDelete={() => onDelete(v)}
                    onToggleHidden={() => onToggleHidden(v)}
                    {...getCardProps(item.key)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </>
  );
}
