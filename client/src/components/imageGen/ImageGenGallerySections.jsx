import { Link } from 'react-router';
import MediaCard from '../media/MediaCard';
import FavoritesFilterChip from '../media/FavoritesFilterChip';

export default function ImageGenGallerySections({ gallery, cards }) {
  const {
    galleryError, refreshGallery, galleryTotal, favoritesOnly, visibleGallery,
    visibleGalleryItems, hiddenTotal, showHidden, setShowHidden, hiddenGalleryItems,
    hiddenError, hasMoreHidden, hiddenLoading, loadMoreHidden,
  } = gallery;
  const {
    setPreview, handleRemix, handleSendToImage, sendToVideo, handleSendTo3d,
    handleDelete, handleToggleHidden, getCardProps, toggleGalleryStar,
  } = cards;

  return (
    <>
      {galleryError && <button type="button" onClick={refreshGallery} className="text-port-accent min-h-[44px]">Gallery could not be loaded. Retry</button>}
      {(galleryTotal > 0 || favoritesOnly) && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide">Recent renders ({Math.min(visibleGallery.length, 5)} of {galleryTotal})</h2>
            <div className="flex items-center gap-2">
              <FavoritesFilterChip active={favoritesOnly} onToggle={() => gallery.setFavoritesOnly((v) => !v)} />
              {galleryTotal > 5 && <Link to="/media/history" className="text-xs text-port-accent hover:underline">View all →</Link>}
            </div>
          </div>
          {visibleGallery.length === 0 ? (
            <div className="text-xs text-gray-500 py-3">{favoritesOnly ? 'No favorited images yet.' : 'No recent images.'}</div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {visibleGalleryItems.slice(0, 5).map((item) => (
                <MediaCard key={item.key} item={item} onPreview={setPreview} onRemix={handleRemix} onSendToImage={handleSendToImage} onSendToVideo={sendToVideo} onSendTo3d={handleSendTo3d} onDelete={handleDelete} onToggleHidden={handleToggleHidden} {...getCardProps(item.key)} onToggleStar={toggleGalleryStar} />
              ))}
            </div>
          )}
        </div>
      )}
      {hiddenTotal > 0 && (
        <div className="bg-port-card border border-port-border rounded-xl p-4 space-y-2">
          <button type="button" onClick={() => setShowHidden((s) => !s)} className="flex items-center justify-between w-full text-xs font-medium text-gray-400 uppercase tracking-wide hover:text-white">
            <span>{showHidden ? 'Hide' : 'Show'} hidden ({hiddenTotal})</span>
            <span className="text-xs text-gray-500">{showHidden ? '▾' : '▸'}</span>
          </button>
          {showHidden && (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {hiddenGalleryItems.map((item) => (
                <MediaCard key={item.key} item={item} onPreview={setPreview} onRemix={handleRemix} onSendToImage={handleSendToImage} onSendToVideo={sendToVideo} onSendTo3d={handleSendTo3d} onDelete={handleDelete} onToggleHidden={handleToggleHidden} {...getCardProps(item.key)} onToggleStar={toggleGalleryStar} />
              ))}
            </div>
          )}
          {showHidden && hiddenError && <button type="button" onClick={refreshGallery} className="min-h-[44px] text-port-accent">Retry hidden images</button>}
          {showHidden && !hiddenError && (hasMoreHidden || hiddenLoading) && (
            <button type="button" disabled={hiddenLoading} onClick={loadMoreHidden} className="min-h-[44px] text-port-accent disabled:opacity-50">
              {hiddenLoading ? 'Loading…' : 'Show more hidden'}
            </button>
          )}
        </div>
      )}
    </>
  );
}
