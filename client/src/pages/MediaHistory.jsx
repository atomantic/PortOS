/**
 * Media History — unified timeline of generated images + videos with filter
 * chips, ffmpeg stitching (videos only), Remix + Send-to-Video for images,
 * and "continue from last frame" piping back into Image Gen.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Combine, Image as ImageIcon, Film } from 'lucide-react';
import toast from '../components/ui/Toast';
import MediaCard from '../components/media/MediaCard';
import MediaLightbox from '../components/media/MediaLightbox';
import { normalizeImage, normalizeVideo } from '../components/media/normalize';
import {
  listVideoHistory, deleteVideoHistoryItem, extractLastFrame, stitchVideos,
  upscaleVideo,
  listImageGallery, deleteImage,
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
  const [stitchMode, setStitchMode] = useState(false);
  const [selected, setSelected] = useState([]); // video ids
  const [stitching, setStitching] = useState(false);
  const [preview, setPreview] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
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

  const filtered = useMemo(
    () => filter === 'all' ? items : items.filter(i => i.kind === filter),
    [items, filter]
  );
  const counts = useMemo(() => ({
    all: items.length,
    image: items.filter(i => i.kind === 'image').length,
    video: items.filter(i => i.kind === 'video').length,
  }), [items]);

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

  const handleRemix = (item) => {
    const params = new URLSearchParams();
    if (item.prompt) params.set('prompt', item.prompt);
    if (item.modelId) params.set('modelId', item.modelId);
    if (item.width) params.set('width', String(item.width));
    if (item.height) params.set('height', String(item.height));
    if (item.seed != null) params.set('seed', String(item.seed));
    if (item.steps) params.set('steps', String(item.steps));
    navigate(`/media/image?${params}`);
  };

  const [upscalingId, setUpscalingId] = useState(null);
  const handleUpscale = async (item) => {
    if (upscalingId) return;
    setUpscalingId(item.id);
    toast.info?.('Upscaling 2× — typically 10-30s…');
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
          {filter === 'video'
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
              />
            );
          })}
        </div>
      )}

      <MediaLightbox
        item={preview}
        onClose={() => setPreview(null)}
        onRemix={handleRemix}
        onSendToVideo={handleSendToVideo}
        onContinue={handleContinue}
      />
    </div>
  );
}
