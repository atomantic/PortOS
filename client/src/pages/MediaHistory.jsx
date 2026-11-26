import MediaBatchImport from '../components/media/MediaBatchImport';
import InfiniteScrollFooter from '../components/ui/InfiniteScrollFooter';
/**
 * Media History — unified timeline of generated images + videos with filter
 * chips, ffmpeg stitching (videos only), Remix for images and videos,
 * Send-to-Video for images, and "continue from last frame" piping back
 * into Video Gen.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router';
import { Combine, Image as ImageIcon, Film, Search, X, ShieldCheck, HardDrive } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import MediaCard from '../components/media/MediaCard';
import MediaHistoryGrid from '../components/media/MediaHistoryGrid';
import MediaPreview from '../components/media/MediaPreview';
import VideoUpscaleDrawer from '../components/media/VideoUpscaleDrawer';
import MediaJobsQueue from '../components/media/MediaJobsQueue';
import FavoritesFilterChip from '../components/media/FavoritesFilterChip';
import RatingFilterChips from '../components/media/RatingFilterChips';
import BatchVerificationBar from '../components/media/BatchVerificationBar';
import CollectionPrimaryControl, { SHARED_MEDIA_ID } from '../components/media/CollectionPrimaryControl';
import { verifyImageNow } from '../services/apiImageVerifier';
import { normalizeImage, normalizeMediaRow, normalizeVideo } from '../components/media/normalize';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import { useMediaDelete } from '../hooks/useMediaDelete';
import { useMediaHideToggle } from '../hooks/useMediaHideToggle';
import useMediaPreviewActions from '../hooks/useMediaPreviewActions';
import useHydratedPreviewRoute from '../hooks/useHydratedPreviewRoute';
import { useGalleryPage } from '../hooks/useGalleryPage';
import socket from '../services/socket';
import useMounted from '../hooks/useMounted';
import { getMediaJob } from '../services/apiMediaJobs';
import {
  stitchVideos,
  makeVideoVertical,
} from '../services/apiImageVideo.js';

// Match the binary thresholds used by the Media History size badges.
const VIDEO_SIZE_FILTERS = [
  [25 * 1024 ** 2, '25 MB'], [100 * 1024 ** 2, '100 MB'], [500 * 1024 ** 2, '500 MB'],
  [1024 ** 3, '1 GB'], [5 * 1024 ** 3, '5 GB'],
];

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
];


export default function MediaHistory() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [videoSizeOverBytes, setVideoSizeOverBytes] = useState('');
  const [stitchMode, setStitchMode] = useState(false);
  const [showHosting, setShowHosting] = useState(false);
  const [selected, setSelected] = useState([]); // video ids
  const [stitching, setStitching] = useState(false);
  // Stitch job ids still running server-side; the toast waits for the job's own
  // terminal event rather than the enqueue response (#13000). The button frees
  // at enqueue: a repeat POST of the same ids returns the live job server-side.
  const stitchJobsRef = useRef(new Set());
  const mounted = useMounted();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [localOnly, setLocalOnly] = useState(false);
  const [ratingFilter, setRatingFilter] = useState(null);
  const { annotations, updateAnnotation: saveAnnotation, getCardProps } = useMediaAnnotations();
  const [annotationSaves, setAnnotationSaves] = useState(0);
  const updateAnnotation = useCallback(async (...args) => {
    setAnnotationSaves(n => n + 1);
    return saveAnnotation(...args).finally(() => setAnnotationSaves(n => n - 1));
  }, [saveAnnotation]);
  const toggleStar = useCallback(item => item?.key && updateAnnotation(item.key, { starred: !annotations[item.key]?.starred }), [annotations, updateAnnotation]);
  const annotationRevision = favoritesOnly || ratingFilter ? JSON.stringify(Object.entries(annotations).map(([key, value]) => [key, value.starred, value.rating, value.updatedAt]).sort()) : '';
  // Visible rows only, as compact cards (#8292): the full record — prompt,
  // negative prompt, settings — is read when a card is opened or handed to a
  // generator, never for the whole page. Search and counts stay server-side
  // over the full metadata.
  const page = useGalleryPage({
    kind: filter, q: query, starred: favoritesOnly, localOnly: localOnly || undefined,
    rating: ratingFilter || undefined, videoSizeOverBytes: videoSizeOverBytes ? Number(videoSizeOverBytes) : undefined,
    summary: true, hidden: false, compact: true,
  }, { media: true, preserveLoadedOnRefresh: true, revision: annotationRevision, paused: (favoritesOnly || !!ratingFilter) && annotationSaves > 0 });
  const { loading, counts, refresh } = page;
  const items = useMemo(() => page.items.map(normalizeMediaRow), [page.items]);
  const setItems = useCallback(updater => page.setItems(previous => {
    const normalized = previous.map(normalizeMediaRow);
    const next = typeof updater === 'function' ? updater(normalized) : updater;
    return next.map(item => ({ kind: item.kind, data: { ...item.raw, prompt: item.prompt } }));
  }), [page.setItems]);
  const [preview, setPreview] = useHydratedPreviewRoute(items);
  useMediaCompletionRefresh({ onImageCompleted: refresh, onVideoCompleted: refresh, refreshOnHolderChange: localOnly });

  const toggleSelect = useCallback((videoId) => {
    setSelected((s) => s.includes(videoId) ? s.filter((x) => x !== videoId) : [...s, videoId]);
  }, []);
  const handleSelectCard = useCallback((item) => toggleSelect(item.id), [toggleSelect]);

  const [verifyMode, setVerifyMode] = useState(false);
  const [selectedVerify, setSelectedVerify] = useState([]);
  const [verifyProfile, setVerifyProfile] = useState('strict_anatomy');
  const [verifyModel, setVerifyModel] = useState('auto');
  const [batchVerifying, setBatchVerifying] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });

  const visibleImages = useMemo(() => items.filter((it) => it.kind === 'image' && it.filename), [items]);

  const toggleSelectVerify = useCallback((filename) => {
    setSelectedVerify((s) => s.includes(filename) ? s.filter((x) => x !== filename) : [...s, filename]);
  }, []);

  const handleSelectAllImages = useCallback(() => {
    setSelectedVerify(visibleImages.map((it) => it.filename));
  }, [visibleImages]);

  const handleClearVerifySelection = useCallback(() => {
    setSelectedVerify([]);
  }, []);

  const handleRunBatchVerify = useCallback(async (profileId, modelId = verifyModel) => {
    if (selectedVerify.length === 0) return;
    setBatchVerifying(true);
    setBatchProgress({ current: 0, total: selectedVerify.length });

    let passCount = 0;
    let failCount = 0;
    let errorCount = 0;

    for (let i = 0; i < selectedVerify.length; i++) {
      const filename = selectedVerify[i];
      setBatchProgress({ current: i + 1, total: selectedVerify.length });
      const targetItem = items.find((it) => it.filename === filename);
      try {
        const res = await verifyImageNow({
          filename,
          profileId,
          prompt: targetItem?.prompt || '',
          reviewerModel: modelId !== 'auto' ? modelId : undefined,
        });
        if (res?.verdict === 'pass') passCount++;
        else if (res?.verdict === 'fail') failCount++;

        setItems((all) => all.map((it) => {
          if (it.filename === filename) {
            return {
              ...it,
              verification: res,
              raw: { ...it.raw, verification: res },
            };
          }
          return it;
        }));
      } catch (err) {
        errorCount++;
        console.error(`Verification error on ${filename}:`, err);
      }
    }

    setBatchVerifying(false);
    if (errorCount > 0) toast.warning(`Batch verification: ${passCount} passed, ${failCount} defect(s) flagged, ${errorCount} could not be verified.`);
    else toast.success(`Batch verification complete: ${passCount} passed, ${failCount} defect(s) flagged.`);
    setSelectedVerify([]);
    refresh();
  }, [selectedVerify, verifyModel, items, setItems, refresh]);

  const settleStitch = useCallback((id, error = null) => {
    if (!stitchJobsRef.current.delete(id)) return false;
    if (error) toast.error(error);
    else toast.success('Stitched videos');
    return true;
  }, []);

  const recheckStitch = useCallback(async (jobId) => {
    const current = await getMediaJob(jobId).catch(() => null);
    if (!mounted.current) return;
    if (!current?.status && stitchJobsRef.current.has(jobId)) {
      toast('Stitch status unknown — check media history');
    } else if (current?.status === 'completed' && settleStitch(jobId)) refresh();
    else if (current?.status === 'failed' || current?.status === 'canceled') {
      settleStitch(jobId, current.error || (current.status === 'canceled' ? 'Stitch canceled' : 'Stitch failed'));
    }
  }, [mounted, refresh, settleStitch]);

  useEffect(() => {
    const onCompleted = (event) => settleStitch(event?.generationId);
    const onFailed = (event) => settleStitch(event?.generationId, event?.error || 'Stitch failed');
    const onReconnect = () => { for (const id of stitchJobsRef.current) void recheckStitch(id); };
    socket.on('video-gen:completed', onCompleted);
    socket.on('video-gen:failed', onFailed);
    socket.on('connect', onReconnect);
    return () => {
      socket.off('video-gen:completed', onCompleted);
      socket.off('video-gen:failed', onFailed);
      socket.off('connect', onReconnect);
    };
  }, [recheckStitch, settleStitch]);

  const handleStitch = async () => {
    if (selected.length < 2) return;
    setStitching(true);
    try {
      const { job } = await stitchVideos(selected, { silent: true });
      if (!mounted.current) return;
      stitchJobsRef.current.add(job.jobId);
      setStitching(false);
      toast('Stitch queued — it lands in history when it finishes');
      setStitchMode(false);
      setSelected([]);
      // Subscribe before this one-shot read: a terminal event can beat the POST
      // acknowledgement, or arrive during the read. The id set settles once.
      await recheckStitch(job.jobId);
    } catch (err) {
      if (!mounted.current) return;
      setStitching(false);
      toast.error(err.message || 'Stitch failed');
    }
  };

  const removeFromPage = useCallback((item) => {
    setItems((all) => all.filter((entry) => entry.key !== item.key));
    page.setTotal(total => Math.max(0, total - 1));
    refresh();
  }, [setItems, page.setTotal, refresh]);

  const { deleteItem: handleDelete, cancelPendingDelete, pendingPeerNames } = useMediaDelete({
    rows: items,
    onPending: useCallback((item, pendingDelete) => setItems((all) => all.map((entry) => {
      if (entry.key !== item.key) return entry;
      const { pendingDelete: _previous, ...raw } = entry.raw;
      return { ...entry, pendingDelete, raw: pendingDelete ? { ...raw, pendingDelete } : raw };
    })), [setItems]),
    onRemoved: removeFromPage,
  });

  // This page lists visible items only, so a hidden one leaves the list.
  const handleToggleHidden = useMediaHideToggle(useCallback((item, hidden) => {
    if (hidden) removeFromPage(item);
  }, [removeFromPage]));

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
    if (!videoSizeOverBytes) setItems((prev) => [normalized, ...prev.filter((x) => x.key !== normalized.key)]);
    refresh();
  }, [setItems, refresh, videoSizeOverBytes]);
  const { handleRemix, handleSendToImage, handleSendToVideo, handleSendTo3d, handleContinue, handleClean, handleRemoveWatermark, handleFilmLookComplete } = useMediaPreviewActions({
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
  // The export is a media job; the new row appears in history when it finishes.
  const handleMakeVertical = useCallback(async (item, ratio) => {
    try {
      const { job } = await makeVideoVertical(item.id, ratio, { silent: true });
      toast(job.deduplicated ? 'That vertical copy is already queued' : `Vertical ${ratio} copy queued — it lands in history when it finishes`);
    } catch (err) {
      toast.error(err.message || 'Vertical export failed');
    }
  }, []);
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
        <div className="flex items-center gap-1 flex-wrap text-xs">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setFilter(f.id);
                if (f.id !== 'video') setVideoSizeOverBytes('');
              }}
              className={`min-h-[44px] pointer-fine:sm:min-h-0 px-2.5 py-1 rounded-full border ${
                filter === f.id
                  ? 'bg-port-accent/20 border-port-accent text-port-accent'
                  : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
            >
              {f.label} <span className="opacity-60">{counts[f.id]}</span>
            </button>
          ))}
          <FavoritesFilterChip active={favoritesOnly} onToggle={() => setFavoritesOnly((v) => !v)} size="md" />
          <button
            type="button"
            aria-pressed={localOnly}
            onClick={() => {
              setLocalOnly(value => !value);
              setSelected([]);
              setSelectedVerify([]);
            }}
            className={`min-h-[44px] pointer-fine:sm:min-h-0 px-2.5 py-1 rounded-full border ${
              localOnly
                ? 'bg-port-accent/20 border-port-accent text-port-accent'
                : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
            }`}
          >
            On this machine
          </button>
          <RatingFilterChips value={ratingFilter} onChange={setRatingFilter} />
          <select
            aria-label="Video file size"
            title="Filter by original video size on this machine"
            value={videoSizeOverBytes}
            onChange={event => {
              const value = event.target.value;
              setVideoSizeOverBytes(value);
              if (value) setFilter('video');
              setSelected([]);
              setSelectedVerify([]);
            }}
            className="min-h-[44px] pointer-fine:sm:min-h-0 rounded-lg border border-port-border bg-port-card px-2.5 py-1 text-port-text"
          >
            <option value="">Any video size</option>
            {VIDEO_SIZE_FILTERS.map(([bytes, label]) => <option key={bytes} value={bytes}>Over {label}</option>)}
          </select>
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
            onClick={() => {
              setVerifyMode((v) => !v);
              setSelectedVerify([]);
              if (!verifyMode) setStitchMode(false);
            }}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded border ${
              verifyMode
                ? 'bg-port-accent text-white border-port-accent'
                : 'border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" /> {verifyMode ? `Cancel Verify (${selectedVerify.length})` : 'Verify Images'}
          </button>
          <button
            type="button"
            onClick={() => { setStitchMode((m) => !m); setSelected([]); if (!stitchMode) setVerifyMode(false); }}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded border ${
              stitchMode
                ? 'bg-port-accent text-white border-port-accent'
                : 'border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
            }`}
          >
            <Combine className="w-3.5 h-3.5" /> {stitchMode ? `Cancel (${selected.length})` : 'Stitch'}
          </button>
          <button
            type="button"
            aria-expanded={showHosting}
            onClick={() => setShowHosting((v) => !v)}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded border ${
              showHosting
                ? 'bg-port-accent/20 border-port-accent text-port-accent'
                : 'border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
            }`}
          >
            <HardDrive className="w-3.5 h-3.5" /> Hosting
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

      {showHosting && <CollectionPrimaryControl collectionId={SHARED_MEDIA_ID} oneShot />}

      {verifyMode && (
        <BatchVerificationBar
          selectedCount={selectedVerify.length}
          totalImages={visibleImages.length}
          onSelectAll={handleSelectAllImages}
          onClearSelection={handleClearVerifySelection}
          onRunBatchVerify={handleRunBatchVerify}
          isVerifying={batchVerifying}
          progress={batchProgress}
          onCancel={() => { setVerifyMode(false); setSelectedVerify([]); }}
          selectedProfile={verifyProfile}
          onProfileChange={setVerifyProfile}
          selectedModel={verifyModel}
          onModelChange={setVerifyModel}
        />
      )}

      <MediaBatchImport onImported={item => {
        if ((filter === 'all' || filter === item.kind) && !query && !favoritesOnly && !ratingFilter && !videoSizeOverBytes) {
          page.setItems(previous => [item, ...previous.filter(row => !(row.kind === item.kind && row.data.filename === item.data.filename))]);
        }
        refresh();
      }} />

      {page.error && items.length === 0 && <p role="alert" className="text-port-error">{page.error} <button type="button" onClick={page.retry}>Retry</button></p>}
      {loading && items.length === 0 ? (
        <PageSkeleton header="none" label="Loading media history" layout="grid" cards={10} gridColsClass="grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" />
      ) : items.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-xl p-8 text-center text-gray-500 text-sm">
          {query.trim()
            ? <>No matches for <span className="text-gray-300">"{query}"</span>. <button type="button" onClick={() => setQuery('')} className="text-port-accent hover:underline">Clear search</button></>
            : videoSizeOverBytes
              ? 'No videos on this machine match this size filter.'
              : localOnly
              ? 'No matching media on this machine.'
              : filter === 'video'
              ? <>No videos yet. <Link to="/media/video" className="text-port-accent hover:underline">Generate one →</Link></>
              : filter === 'image'
                ? <>No images yet. <Link to="/media/image" className="text-port-accent hover:underline">Generate one →</Link></>
                : <>Nothing here yet. Try <Link to="/media/image" className="text-port-accent hover:underline">Image</Link> or <Link to="/media/video" className="text-port-accent hover:underline">Video</Link>.</>}
        </div>
      ) : (
        <>
          <MediaHistoryGrid items={items}>
            {(it) => {
              const inStitch = stitchMode && it.kind === 'video';
              const stitchIdx = inStitch ? selected.indexOf(it.id) : -1;
              const inVerify = verifyMode && it.kind === 'image';
              const verifyIdx = inVerify ? selectedVerify.indexOf(it.filename) : -1;
              const isSelected = inStitch ? (stitchIdx !== -1) : inVerify ? (verifyIdx !== -1) : false;
              const selectionLabel = inStitch
                ? (stitchIdx !== -1 ? stitchIdx + 1 : null)
                : inVerify
                  ? (verifyIdx !== -1 ? verifyIdx + 1 : null)
                  : null;
              const cardClick = inStitch
                ? handleSelectCard
                : inVerify
                  ? () => toggleSelectVerify(it.filename)
                  : undefined;
              const selectionActive = stitchMode || verifyMode;
              return (
                <MediaCard
                  key={it.key}
                  item={it}
                  onPreview={selectionActive ? undefined : setPreview}
                  onClick={cardClick}
                  onRemix={!selectionActive ? handleRemix : undefined}
                  onSendToImage={!selectionActive ? handleSendToImage : undefined}
                  onSendToVideo={!selectionActive ? handleSendToVideo : undefined}
                  onSendTo3d={!selectionActive ? handleSendTo3d : undefined}
                  onContinue={!selectionActive ? handleContinue : undefined}
                  onUpscale={!selectionActive && it.kind === 'video' ? handleUpscale : undefined}
                  onMakeVertical={!selectionActive && it.kind === 'video' ? handleMakeVertical : undefined}
                  onDelete={!selectionActive ? handleDelete : undefined}
                  onCancelPendingDelete={!selectionActive ? cancelPendingDelete : undefined}
                  onToggleHidden={!selectionActive ? handleToggleHidden : undefined}
                  pendingPeerName={it.pendingDelete?.peerId ? pendingPeerNames[it.pendingDelete.peerId] : null}
                  selectionLabel={selectionLabel}
                  selected={isSelected}
                  disabled={(stitchMode && it.kind !== 'video') || (verifyMode && it.kind !== 'image')}
                  hideActions={selectionActive}
                  {...getCardProps(it.key)}
                  onToggleStar={!selectionActive ? toggleStar : undefined}
                  onAnnotate={!selectionActive && it.kind === 'image' ? handleAnnotate : undefined}
                />
              );
            }}
          </MediaHistoryGrid>
          <InfiniteScrollFooter hasMore={page.hasMore} loading={loading} error={page.error}
            onLoadMore={page.error ? page.retry : page.loadMore} autoLoad={!stitchMode}
            label={`Show more (${page.total - items.length} remaining)`} />
        </>
      )}

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={items}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onPromptSaved={handlePromptSaved}
        onPosterSaved={(item, result) => setItems(all => all.map(current => current.key === item.key
          ? { ...current, raw: { ...current.raw, thumbnail: result.thumbnail, posterSec: result.posterSec } } : current))}
        onRemix={handleRemix}
        onSendToImage={handleSendToImage}
        onSendToVideo={handleSendToVideo}
        onSendTo3d={handleSendTo3d}
        onContinue={handleContinue}
        onClean={(item) => handleClean(item?.raw)}
        onRemoveWatermark={(item) => handleRemoveWatermark(item?.raw)}
        onFilmLookComplete={handleFilmLookComplete}
        onDelete={handleDelete}
        onToggleHidden={handleToggleHidden}
      />

      <VideoUpscaleDrawer
        item={upscaleItem}
        onClose={() => setUpscaleItem(null)}
        onUpscaled={handleUpscaled}
      />
      <MediaJobsQueue kind="video-upscale" />
    </div>
  );
}
