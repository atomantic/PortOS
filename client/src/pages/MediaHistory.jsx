/**
 * Media History — unified timeline of generated images + videos with filter
 * chips, ffmpeg stitching (videos only), Remix + Send-to-Video for images,
 * and "continue from last frame" piping back into Image Gen.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Combine, Image as ImageIcon, Film, Search, X } from 'lucide-react';
import toast from '../components/ui/Toast';
import MediaCard from '../components/media/MediaCard';
import MediaPreview from '../components/media/MediaPreview';
import FavoritesFilterChip from '../components/media/FavoritesFilterChip';
import { normalizeImage, normalizeVideo } from '../components/media/normalize';
import { useMediaCompletionRefresh } from '../hooks/useMediaCompletionRefresh';
import { useMediaAnnotations } from '../hooks/useMediaAnnotations';
import {
  listVideoHistory, deleteVideoHistoryItem, extractLastFrame, stitchVideos,
  upscaleVideo,
  listImageGallery, deleteImage, cleanGalleryImage,
} from '../services/api';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Videos' },
];

export default function MediaHistory() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [stitchMode, setStitchMode] = useState(false);
  const [selected, setSelected] = useState([]); // video ids
  const [stitching, setStitching] = useState(false);
  const [preview, setPreview] = useState(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const { annotations, toggleStar, updateAnnotation } = useMediaAnnotations();

  const refresh = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    const [images, videos] = await Promise.all([
      listImageGallery().catch(() => []),
      listVideoHistory().catch(() => []),
    ]);
    const merged = [
      ...(Array.isArray(images) ? images.map(normalizeImage) : []),
      ...(Array.isArray(videos) ? videos.map(normalizeVideo) : []),
    ].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    setItems(merged);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useMediaCompletionRefresh({
    onImageCompleted: () => refresh({ silent: true }),
    onVideoCompleted: () => refresh({ silent: true }),
  });

  // Precompute the searchable haystack per item once per items list — keystrokes
  // then only re-run token .includes() against a cached string instead of
  // rebuilding the array + join + lowercase per item per keystroke.
  const haystacks = useMemo(() => items.map((item) => [
    item.prompt,
    item.negativePrompt,
    item.modelId,
    item.filename,
    item.kind,
    item.seed != null ? `seed ${item.seed}` : '',
    item.width && item.height ? `${item.width}x${item.height}` : '',
    ...(Array.isArray(item.loraNames) ? item.loraNames : []),
    item.extractedFromVideoId ? 'extracted frame' : '',
    item.stitchedFrom ? 'stitched' : '',
    item.upscaledFrom ? 'upscaled 2x' : '',
  ].filter(Boolean).join(' ').toLowerCase()), [items]);

  // AND semantics across whitespace tokens — "sunset flux2 1024" matches items
  // whose haystack contains all three substrings, in any order.
  const tokens = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query]
  );

  const searched = useMemo(
    () => tokens.length === 0 ? items : items.filter((_, idx) => tokens.every((t) => haystacks[idx].includes(t))),
    [items, haystacks, tokens]
  );
  const kindFiltered = useMemo(
    () => filter === 'all' ? searched : searched.filter(i => i.kind === filter),
    [searched, filter]
  );
  const filtered = useMemo(
    () => favoritesOnly ? kindFiltered.filter((i) => annotations[i.key]?.starred) : kindFiltered,
    [kindFiltered, favoritesOnly, annotations]
  );
  const counts = useMemo(() => {
    const c = { all: 0, image: 0, video: 0 };
    for (const i of searched) {
      c.all++;
      if (i.kind === 'image') c.image++;
      else if (i.kind === 'video') c.video++;
    }
    return c;
  }, [searched]);

  const toggleSelect = (videoId) => {
    setSelected((s) => s.includes(videoId) ? s.filter((x) => x !== videoId) : [...s, videoId]);
  };

  const handleStitch = async () => {
    if (selected.length < 2) return;
    setStitching(true);
    try {
      await stitchVideos(selected);
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

  const handleDelete = async (item) => {
    try {
      await (item.kind === 'image'
        ? deleteImage(item.filename)
        : deleteVideoHistoryItem(item.id));
      setItems((all) => all.filter((x) => x.key !== item.key));
    } catch (err) {
      toast.error(err.message || 'Delete failed');
    }
  };

  const handleContinue = async (item) => {
    try {
      const { filename } = await extractLastFrame(item.id);
      const params = new URLSearchParams({ sourceImageFile: filename });
      if (item?.width) params.set('w', String(item.width));
      if (item?.height) params.set('h', String(item.height));
      navigate(`/media/video?${params.toString()}`);
    } catch (err) {
      toast.error(err.message || 'Failed to extract last frame');
    }
  };

  const handleClean = async (img, level) => {
    if (!img?.filename) throw new Error('Missing filename');
    const cleaned = await cleanGalleryImage(img.filename, level).catch((err) => {
      toast.error(err.message || 'Failed to clean image');
      throw err;
    });
    const normalized = normalizeImage(cleaned);
    setItems((prev) => [normalized, ...prev.filter((x) => x.key !== normalized.key)]);
    toast.success(`Cleaned (${level}) → ${cleaned.filename}`);
  };

  const handleRemix = (item) => {
    const params = new URLSearchParams();
    if (item.prompt && item.prompt !== '(no prompt)') params.set('prompt', item.prompt);
    if (item.negativePrompt) params.set('negativePrompt', item.negativePrompt);
    if (item.modelId) params.set('modelId', item.modelId);
    if (item.width) params.set('width', String(item.width));
    if (item.height) params.set('height', String(item.height));
    if (item.seed != null) params.set('seed', String(item.seed));
    if (item.steps) params.set('steps', String(item.steps));
    if (item.guidance != null) params.set('guidance', String(item.guidance));
    if (item.quantize) params.set('quantize', String(item.quantize));
    navigate(`/media/image?${params}`);
  };

  const [upscalingId, setUpscalingId] = useState(null);
  const handleUpscale = async (item) => {
    if (upscalingId) return;
    setUpscalingId(item.id);
    toast.loading('Upscaling 2× — typically 10-30s…');
    const result = await upscaleVideo(item.id).catch((err) => {
      toast.error(err.message || 'Upscale failed');
      return null;
    });
    setUpscalingId(null);
    if (result?.video) {
      setItems((all) => [normalizeVideo(result.video), ...all]);
      toast.success('Upscaled 2×');
    }
  };

  const handleSendToVideo = (item) => {
    const params = new URLSearchParams({ sourceImageFile: item.filename });
    if (item.prompt && item.prompt !== '(no prompt)') params.set('prompt', item.prompt);
    const neg = item.negativePrompt || item.raw?.negativePrompt || item.raw?.negative_prompt;
    if (neg) params.set('negativePrompt', neg);
    navigate(`/media/video?${params}`);
  };

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
              placeholder="Search prompt, model, seed, lora…"
              className="w-full pl-7 pr-7 py-1 bg-port-bg border border-port-border rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-gray-500 hover:text-white"
                title="Clear search"
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

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
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
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {filtered.map((it) => {
            const inStitch = stitchMode && it.kind === 'video';
            const idx = inStitch ? selected.indexOf(it.id) : -1;
            return (
              <MediaCard
                key={it.key}
                item={it}
                onPreview={(media) => setPreview(media)}
                onClick={inStitch ? () => toggleSelect(it.id) : undefined}
                onRemix={!stitchMode ? handleRemix : undefined}
                onSendToVideo={!stitchMode ? handleSendToVideo : undefined}
                onContinue={!stitchMode ? handleContinue : undefined}
                onUpscale={!stitchMode && it.kind === 'video' ? handleUpscale : undefined}
                onDelete={!stitchMode ? handleDelete : undefined}
                selectionLabel={idx !== -1 ? idx + 1 : null}
                selected={idx !== -1}
                disabled={stitchMode && it.kind !== 'video'}
                hideActions={stitchMode}
                starred={!!annotations[it.key]?.starred}
                hasNote={!!annotations[it.key]?.anyNote}
                onToggleStar={!stitchMode ? toggleStar : undefined}
              />
            );
          })}
        </div>
      )}

      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={filtered}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onRemix={handleRemix}
        onSendToVideo={handleSendToVideo}
        onContinue={handleContinue}
        onClean={(item, level) => handleClean(item?.raw, level)}
      />
    </div>
  );
}
