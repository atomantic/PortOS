import { Search, X, RefreshCw, Upload } from 'lucide-react';
import { formatCount } from '../../utils/formatters';
import FilePickerButton from '../ui/FilePickerButton';
import ListLoadError from '../ui/ListLoadError';
import Modal from '../ui/Modal';
import MediaCard from './MediaCard';

export default function GalleryPickerShell({
  open, onClose, title, ariaLabel, searchId, searchLabel, searchPlaceholder, query, onQueryChange,
  upload, filters, items, loading, loadingText, error, errorSubject, onRetry, hasMore, remaining,
  onLoadMore, emptyText, onSelect,
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="3xl"
      // Escape themed card stacking contexts and any host modal.
      usePortal
      panelClassName="bg-port-card border border-port-border rounded-xl flex flex-col"
      ariaLabel={ariaLabel}
    >
      <div className="p-3 border-b border-port-border space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-white shrink-0">{title}</h2>
          <div className="flex items-center gap-2 shrink-0">
            {upload && (
              <FilePickerButton
                accept={upload.accept}
                onChange={upload.onChange}
                disabled={upload.uploading}
                title={upload.title}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-port-border bg-port-bg px-2.5 py-1.5 text-xs text-gray-300 hover:border-port-accent hover:text-white"
              >
                {upload.uploading
                  ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Uploading…</>
                  : <><Upload className="h-3.5 w-3.5" /> Upload</>}
              </FilePickerButton>
            )}
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 p-1.5 text-gray-400 hover:text-white rounded min-h-[44px] min-w-[44px] flex items-center justify-center"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <label htmlFor={searchId} className="sr-only">{searchLabel}</label>
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input
              id={searchId}
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full pl-7 pr-7 py-1.5 text-xs bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
              autoFocus
            />
            {query && (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          {filters}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {items.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {items.map((item) => (
              <MediaCard
                key={item.key}
                item={item}
                hideActions
                showCollectionMenu={false}
                onClick={onSelect}
              />
            ))}
          </div>
        )}
        {items.length === 0 && loading && (
          <div className="flex items-center justify-center gap-2 text-xs text-gray-400 py-10">
            <RefreshCw className="w-4 h-4 animate-spin" /> {loadingText}
          </div>
        )}
        {items.length === 0 && !loading && !error && (
          <div className="text-xs text-gray-500 py-10 text-center">{emptyText}</div>
        )}
        {error && <ListLoadError what={errorSubject} error={{ message: error }} onRetry={onRetry} />}
        {hasMore && !error && (
          <button
            type="button"
            disabled={loading}
            onClick={onLoadMore}
            className="w-full min-h-[44px] text-port-accent"
          >
            {loading ? 'Loading…' : `Show more (${formatCount(remaining)} remaining)`}
          </button>
        )}
      </div>
    </Modal>
  );
}
