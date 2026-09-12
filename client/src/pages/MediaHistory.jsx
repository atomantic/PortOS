/**
 * Media History — unified timeline of generated images + videos with filter
 * chips, ffmpeg stitching (videos only), Remix for images and videos,
 * Send-to-Video for images, and "continue from last frame" piping back
 * into Video Gen.
 */

import { useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { Combine, Image as ImageIcon, Film, Search, X } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import MediaCard from '../components/media/MediaCard';
import MediaPreview from '../components/media/MediaPreview';
import VideoUpscaleDrawer from '../components/media/VideoUpscaleDrawer';
import FavoritesFilterChip from '../components/media/FavoritesFilterChip';
import { normalizeImage, normalizeVideo } from '../components/media/normalize';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import useMediaPreviewActions from '../hooks/useMediaPreviewActions';
import usePreviewRoute from '../hooks/usePreviewRoute';
import { useGalleryPage } from '../hooks/useGalleryPage';
import {
  listMediaGalleryPage, deleteVideoHistoryItem, stitchVideos, deleteImage,
} from '../services/api';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
];

const normalizeRow = row => row.kind === 'image' ? normalizeImage(row.data) : normalizeVideo(row.data);
const resolvePreview = async key => {
  const kind = key.startsWith('video:') ? 'video' : key.startsWith('image:') ? 'image' : 'all';
  const filename = key.replace(/^(image|video):/, '');
  const page = await listMediaGalleryPage({ limit: 1, kind, filename }, { silent: true });
  return page.items[0] ? normalizeRow(page.items[0]) : null;
};

export default function MediaHistory() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [stitchMode, setStitchMode] = useState(false);
  const [selected, setSelected] = useState([]); // video ids
  const [stitching, setStitching] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, updateAnnotation: saveAnnotation, getCardProps } = useMediaAnnotations();
  const [annotationSaves, setAnnotationSaves] = useState(0);
  const updateAnnotation = useCallback(async (...args) => {
    setAnnotationSaves(n => n + 1);
    return saveAnnotation(...args).finally(() => setAnnotationSaves(n => n - 1));
  }, [saveAnnotation]);
  const toggleStar = useCallback(item => item?.key && updateAnnotation(item.key, { starred: !annotations[item.key]?.starred }), [annotations, updateAnnotation]);
  const annotationRevision = favoritesOnly ? JSON.stringify(Object.entries(annotations).map(([key, value]) => [key, value.starred, value.updatedAt]).sort()) : '';
  const page = useGalleryPage({ kind: filter, q: query, starred: favoritesOnly, summary: true }, { media: true, revision: annotationRevision, paused: favoritesOnly && annotationSaves > 0 });
  const { loading, counts, refresh } = page;
  const items = useMemo(() => page.items.map(normalizeRow), [page.items]);
  const setItems = useCallback(updater => page.setItems(previous => {
    const normalized = previous.map(normalizeRow);
    const next = typeof updater === 'function' ? updater(normalized) : updater;
    return next.map(item => ({ kind: item.kind, data: { ...item.raw, prompt: item.prompt } }));
  }), [page.setItems]);
  const filtered = items;
  const visibleItems = items;
  const [preview, setPreview] = usePreviewRoute(items, { resolveItem: resolvePreview });
  useMediaCompletionRefresh({ onImageCompleted: refresh, onVideoCompleted: refresh });

  const toggleSelect = useCallback((videoId) => {
    setSelected((s) => s.includes(videoId) ? s.filter((x) => x !== videoId) : [...s, videoId]);
  }, []);
  const handleSelectCard = useCallback((item) => toggleSelect(item.id), [toggleSelect]);

  const handleStitch = async () => {
    if (selected.length < 2) return;
    setStitching(true);
    try {
      await stitchVideos(selected, { silent: true });
      toast.success(`Stitched ${selected.length} videos`);
      setStitchMode(false);
      setSelected([]);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Stitch failed');
    } finally {
      setStitching(false);
    }
  };

  const handleDelete = useCallback(async (item) => {
    try {
      await (item.kind === 'image'
        ? deleteImage(item.filename, { silent: true })
        : deleteVideoHistoryItem(item.id, { silent: true }));
      setItems((all) => all.filter((x) => x.key !== item.key));
      page.setTotal(total => Math.max(0, total - 1));
      refresh();
    } catch (err) {
      toast.error(err.message || 'Delete failed');
    }
  }, [setItems, page.setTotal, refresh]);

  const handlePromptSaved = useCallback((item, prompt) => {
    setItems((all) => all.map((current) => current.key === item.key ? { ...current, prompt } : current));
    refresh();
  }, [setItems, refresh]);

  // Remix / SendToVideo / Continue / Clean all share a single implementation
  // with MediaCollectionDetail, ImageGen, and the Universe Builder lightbox
  // via `useMediaPreviewActions`. Only the post-clean side effect (splicing
  // the cleaned image to the top of the local list) is page-specific —
  // wired through `onCleanComplete` so the cleaned record lands in `items`
  // without a full gallery refetch.
  const handleCleanComplete = useCallback((cleaned) => {
    const normalized = normalizeImage(cleaned);
    setItems((prev) => [normalized, ...prev.filter((x) => x.key !== normalized.key)]);
    refresh();
  }, [setItems, refresh]);
  const { handleRemix, handleSendToImage, handleSendToVideo, handleSendTo3d, handleContinue, handleClean, handleRemoveWatermark } = useMediaPreviewActions({
    onCleanComplete: handleCleanComplete,
  });

  // The card button opens a method-picker drawer (#6510) instead of upscaling
  // directly — the drawer owns the plan fetch, disclosure, and submit.
  const [upscaleItem, setUpscaleItem] = useState(null);
  const handleUpscale = useCallback((item) => {
    setUpscaleItem(item);
  }, []);
  const handleUpscaled = useCallback((video) => {
    setItems((all) => [normalizeVideo(video), ...all]);
    refresh();
  }, [setItems, refresh]);
  const handleAnnotate = useCallback((item) => {
    navigate(`/media/annotate/${encodeURIComponent(item.key)}`);
  }, [navigate]);


  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search media history"
              placeholder="Search prompt, model, character, place…"
              className="w-full pl-7 pr-7 py-1 bg-port-bg border border-port-border rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-gray-500 hover:text-white"
                title="Clear search" aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`px-2.5 py-1 rounded-full border ${
                filter === f.id
                  ? 'bg-port-accent/20 border-port-accent text-port-accent'
                  : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
            >
              {f.label} <span className="opacity-60">{counts[f.id]}</span>
            </button>
          ))}
          <FavoritesFilterChip active={favoritesOnly} onToggle={() => setFavoritesOnly((v) => !v)} size="md" />
        </div>
        <div className="flex items-center gap-1">
          <Link to="/media/image" className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50">
            <ImageIcon className="w-3.5 h-3.5" /> Image
          </Link>
          <Link to="/media/video" className="flex items-center gap-1.5 px-2 py-1 text-xs text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50">
            <Film className="w-3.5 h-3.5" /> Video
          </Link>
          <button
            type="button"
            onClick={() => { setStitchMode((m) => !m); setSelected([]); }}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded border ${
              stitchMode
                ? 'bg-port-accent text-white border-port-accent'
                : 'border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
            }`}
          >
            <Combine className="w-3.5 h-3.5" /> {stitchMode ? `Cancel (${selected.length})` : 'Stitch'}
          </button>
          {stitchMode && selected.length >= 2 && (
            <button
              type="button"
              onClick={handleStitch}
              disabled={stitching}
              className="flex items-center gap-1.5 px-2 py-1 text-xs bg-port-success hover:bg-port-success/80 disabled:opacity-50 text-white rounded"
            >
              {stitching ? 'Stitching…' : `Stitch ${selected.length}`}
            </button>
          )}
        </div>
      </div>

      {page.error && <p role="alert" className="text-port-error">{page.error} <button type="button" onClick={page.retry}>Retry</button></p>}
      {loading && items.length === 0 ? (
        <PageSkeleton header="none" label="Loading media history" layout="grid" cards={10} gridColsClass="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" />
      ) : filtered.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500 text-sm">
          {query.trim()
            ? <>No matches for <span className="text-gray-300">"{query}"</span>. <button type="button" onClick={() => setQuery('')} className="text-port-accent hover:underline">Clear search</button></>
            : filter === 'video'
              ? <>No videos yet. <Link to="/media/video" className="text-port-accent hover:underline">Generate one →</Link></>
              : filter === 'image'
                ? <>No images yet. <Link to="/media/image" className="text-port-accent hover:underline">Generate one →</Link></>
                : <>Nothing here yet. Try <Link to="/media/image" className="text-port-accent hover:underline">Image</Link> or <Link to="/media/video" className="text-port-accent hover:underline">Video</Link>.</>}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {visibleItems.map((it) => {
              const inStitch = stitchMode && it.kind === 'video';
              const idx = inStitch ? selected.indexOf(it.id) : -1;
              return (
                <MediaCard
                  key={it.key}
                  item={it}
                  onPreview={setPreview}
                  onClick={inStitch ? handleSelectCard : undefined}
                  onRemix={!stitchMode ? handleRemix : undefined}
                  onSendToImage={!stitchMode ? handleSendToImage : undefined}
                  onSendToVideo={!stitchMode ? handleSendToVideo : undefined}
                  onSendTo3d={!stitchMode ? handleSendTo3d : undefined}
                  onContinue={!stitchMode ? handleContinue : undefined}
                  onUpscale={!stitchMode && it.kind === 'video' ? handleUpscale : undefined}
                  onDelete={!stitchMode ? handleDelete : undefined}
                  selectionLabel={idx !== -1 ? idx + 1 : null}
                  selected={idx !== -1}
                  disabled={stitchMode && it.kind !== 'video'}
                  hideActions={stitchMode}
                  {...getCardProps(it.key)}
                  onToggleStar={!stitchMode ? toggleStar : undefined}
                  onAnnotate={!stitchMode && it.kind === 'image' ? handleAnnotate : undefined}
                />
              );
            })}
          </div>
          {page.hasMore && (
            <button
              type="button"
              onClick={page.loadMore}
              disabled={loading}
              className="w-full py-2.5 text-xs text-port-accent hover:text-white bg-port-border/30 hover:bg-port-border/50 rounded-lg transition-colors min-h-[44px]"
            >
              {loading ? 'Loading…' : `Show more (${page.total - items.length} remaining)`}
            </button>
          )}
        </>
      )}

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={filtered}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onPromptSaved={handlePromptSaved}
        onRemix={handleRemix}
        onSendToImage={handleSendToImage}
        onSendToVideo={handleSendToVideo}
        onSendTo3d={handleSendTo3d}
        onContinue={handleContinue}
        onClean={(item) => handleClean(item?.raw)}
        onRemoveWatermark={(item) => handleRemoveWatermark(item?.raw)}
      />

      <VideoUpscaleDrawer
        item={upscaleItem}
        onClose={() => setUpscaleItem(null)}
        onUpscaled={handleUpscaled}
      />
    </div>
  );
}
