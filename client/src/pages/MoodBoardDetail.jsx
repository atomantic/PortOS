/**
 * Mood Board canvas (issue #911).
 *
 * The board editor: rename/describe the board, and pin/edit/remove reference
 * items. v1 items are an external image URL (or app path) or a text note, each
 * with an optional caption + source backref. The board's JSONB also stores a
 * `mediaKey` for items pinned from elsewhere in PortOS (the cross-surface "Pin
 * to mood board" flow is a follow-up — see issue trailer); this page renders a
 * `mediaKey` image item if one exists, but the in-page add form uses URL/text.
 */

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { ArrowLeft, ImageIcon, FileText, Trash2, Plus, Save, Link2, Unlink, RefreshCw, Images, Film, Play, ScanEye, Copy } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GalleryVideoPicker from '../components/videoGen/GalleryVideoPicker';
import { PromptFromMediaModal } from '../components/media/PromptFromMedia';
import { copyToClipboard } from '../lib/clipboard';
import {
  getMoodBoard,
  updateMoodBoard,
  addMoodBoardItem,
  updateMoodBoardItem,
  removeMoodBoardItem,
  linkMoodBoardPinterest,
  unlinkMoodBoardPinterest,
  syncMoodBoardPinterest,
} from '../services/api';
import { moodBoardItemSrc, moodBoardItemVideoSrc, moodBoardItemAnalysisSource } from '../lib/moodBoardItemSrc';
import { timeAgo } from '../utils/formatters';
import useMounted from '../hooks/useMounted';

export default function MoodBoardDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [confirmingItemId, setConfirmingItemId] = useState(null);

  // Add-item form.
  const [itemType, setItemType] = useState('image');
  const [imageUrl, setImageUrl] = useState('');
  const [text, setText] = useState('');
  const [caption, setCaption] = useState('');
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);

  // Gallery pickers (#4188) + inline video playback.
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);
  const [playingItemId, setPlayingItemId] = useState(null);

  // Per-item prompt-from-media analysis (#4188 Phase 3). Track the item by id
  // (not a snapshot) so the modal's stored-analysis view stays fresh after the
  // persist PATCH updates the board state.
  const [analyzeItemId, setAnalyzeItemId] = useState(null);

  // Pinterest link/sync.
  const [pinUrl, setPinUrl] = useState('');
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);

  // Stale-response guards. `load` fires whenever the board `id` changes; because
  // the fetch is async, an older request can resolve *after* a newer one (the
  // user navigated to a different board) and clobber current state. We bump a
  // sequence counter per call and only apply the result if it's still the latest
  // — and only if the component is still mounted. The seq counter independently
  // drops StrictMode's duplicate first fetch.
  const mountedRef = useMounted();
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    const data = await getMoodBoard(id, { silent: true }).catch(() => null);
    // Drop stale (a newer load started) or unmounted resolutions before any
    // setState / toast so an out-of-order response can't overwrite current state.
    if (!mountedRef.current || seq !== loadSeqRef.current) return;
    if (data) {
      setBoard(data);
      setName(data.name || '');
      setDescription(data.description || '');
      setPinUrl(data.pinterest?.boardUrl || '');
    } else {
      toast.error('Mood board not found');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const metaDirty = board && (name.trim() !== (board.name || '') || description !== (board.description || ''));

  // The item under analysis (#4188 Phase 3), re-derived from board state so the
  // modal's stored-analysis view stays fresh after the persist PATCH. The
  // source is memoized on the item's identity: PromptFromMedia resets its panel
  // when its `initialSource` identity changes, so a fresh object every render
  // would wipe an in-flight run on unrelated re-renders. (Lives above the
  // loading/not-found early returns — hooks must run unconditionally.)
  const analyzeItem = analyzeItemId
    ? ((Array.isArray(board?.items) ? board.items : []).find((it) => it.id === analyzeItemId) || null)
    : null;
  const analyzeSource = useMemo(() => moodBoardItemAnalysisSource(analyzeItem), [analyzeItem]);

  const handleSaveMeta = async () => {
    if (!name.trim()) { toast.error('Board name is required'); return; }
    setSavingMeta(true);
    const updated = await updateMoodBoard(id, { name: name.trim(), description }, { silent: true }).catch(() => null);
    setSavingMeta(false);
    if (!updated) { toast.error('Failed to save board'); return; }
    setBoard(updated);
    toast.success('Board saved');
  };

  const resetAddForm = () => {
    setImageUrl(''); setText(''); setCaption(''); setSource('');
  };

  const handleAddItem = async () => {
    const payload = { type: itemType, caption: caption || null, source: source || null };
    if (itemType === 'image') {
      if (!imageUrl.trim()) { toast.error('Enter an image URL'); return; }
      payload.imageUrl = imageUrl.trim();
    } else {
      if (!text.trim()) { toast.error('Enter some text'); return; }
      payload.text = text.trim();
    }
    setAdding(true);
    const item = await addMoodBoardItem(id, payload, { silent: true }).catch(() => null);
    setAdding(false);
    if (!item) { toast.error('Failed to add item'); return; }
    setBoard((prev) => (prev ? { ...prev, items: [...(prev.items || []), item] } : prev));
    resetAddForm();
  };

  // Gallery-picker pins (#4188). Both pickers hand back a normalized media
  // item; the payload mirrors PinToMoodBoardMenu's shape — mediaKey for source
  // linkage + a directly-renderable preview. A video pin's mediaKey ref is the
  // FILENAME (`video:<file>.mp4`) so playback and peer-sync asset transfer
  // both resolve without an id→filename lookup.
  const addPickedItem = async (payload) => {
    const item = await addMoodBoardItem(id, payload, { silent: true }).catch(() => null);
    if (!item) { toast.error('Failed to add item'); return; }
    setBoard((prev) => (prev ? { ...prev, items: [...(prev.items || []), item] } : prev));
  };

  const handlePickGalleryImage = (picked) => {
    if (!picked?.previewUrl && !picked?.key) return;
    addPickedItem({
      type: 'image',
      mediaKey: typeof picked.key === 'string' && picked.key.startsWith('image:') ? picked.key : null,
      imageUrl: picked.previewUrl || null,
    });
  };

  const handlePickGalleryVideo = (picked) => {
    if (!picked?.filename) return;
    addPickedItem({
      type: 'video',
      mediaKey: `video:${picked.filename}`,
      imageUrl: picked.previewUrl || null,
    });
  };

  const handleUpdateCaption = async (itemId, nextCaption) => {
    const item = await updateMoodBoardItem(id, itemId, { caption: nextCaption || null }, { silent: true }).catch(() => null);
    if (!item) { toast.error('Failed to update caption'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === itemId ? item : it)) }
      : prev));
  };

  // Persist a prompt-from-media run onto the item (#4188 Phase 3). The
  // analyzer can return an image and/or a video prompt; store the one that
  // matches the item's own type, falling back to whichever was generated.
  const persistAnalysis = async (item, result) => {
    const preferVideo = item.type === 'video';
    const primary = preferVideo ? result.videoPrompt : result.imagePrompt;
    const fallback = preferVideo ? result.imagePrompt : result.videoPrompt;
    const usedPrimary = primary != null && primary !== '';
    const prompt = usedPrimary ? primary : fallback;
    if (!prompt) return;
    const negative = usedPrimary
      ? (preferVideo ? result.videoNegativePrompt : result.imageNegativePrompt)
      : (preferVideo ? result.imageNegativePrompt : result.videoNegativePrompt);
    const analysis = {
      prompt,
      negativePrompt: negative || null,
      rationale: result.rationale || null,
      providerId: result.providerId || null,
      model: result.model || null,
    };
    const updated = await updateMoodBoardItem(id, item.id, { analysis }, { silent: true }).catch(() => null);
    if (!updated) { toast.error('Analysis ran but could not be saved to the item'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === item.id ? updated : it)) }
      : prev));
    toast.success('Analysis saved to item');
  };

  const handleClearAnalysis = async (itemId) => {
    const updated = await updateMoodBoardItem(id, itemId, { analysis: null }, { silent: true }).catch(() => null);
    if (!updated) { toast.error('Failed to remove analysis'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === itemId ? updated : it)) }
      : prev));
  };

  const handleRemoveItem = async (itemId) => {
    setConfirmingItemId(null);
    const updated = await removeMoodBoardItem(id, itemId, { silent: true }).catch(() => null);
    if (!updated) { toast.error('Failed to remove item'); return; }
    setBoard((prev) => (prev ? { ...prev, items: (prev.items || []).filter((it) => it.id !== itemId) } : prev));
  };

  const handleLinkPinterest = async () => {
    if (!pinUrl.trim()) { toast.error('Enter a Pinterest board URL'); return; }
    setLinking(true);
    const updated = await linkMoodBoardPinterest(id, pinUrl.trim(), { silent: true }).catch(() => null);
    setLinking(false);
    if (!updated) { toast.error('Could not link that Pinterest URL — is it a public board?'); return; }
    setBoard(updated);
    setPinUrl(updated.pinterest?.boardUrl || pinUrl.trim());
    toast.success('Pinterest board linked');
  };

  const handleUnlinkPinterest = async () => {
    setConfirmingUnlink(false);
    const updated = await unlinkMoodBoardPinterest(id, { silent: true }).catch(() => null);
    if (!updated) { toast.error('Failed to unlink'); return; }
    setBoard(updated);
    setPinUrl('');
  };

  const handleSyncPinterest = async () => {
    setSyncing(true);
    const result = await syncMoodBoardPinterest(id, { silent: true }).catch(() => null);
    setSyncing(false);
    if (!result?.board) { toast.error('Pinterest sync failed — the feed may be private or rate-limited'); return; }
    setBoard(result.board);
    toast.success(result.added > 0
      ? `Added ${result.added} new pin${result.added === 1 ? '' : 's'}`
      : 'Up to date — no new pins');
  };

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <PageSkeleton
          label="Loading mood board"
          titleWidthClass="w-56"
          layout="grid"
          cards={8}
          gridColsClass="grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
        />
      </div>
    );
  }
  if (!board) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <p className="text-gray-400 mb-4">This mood board doesn’t exist.</p>
        <Link to="/mood-boards" className="text-port-accent hover:underline">Back to boards</Link>
      </div>
    );
  }

  const items = Array.isArray(board.items) ? board.items : [];
  const linkedFeedUrl = board.pinterest?.feedUrl || '';
  const linkedBoardUrl = board.pinterest?.boardUrl || '';
  const lastSyncedAt = board.pinterest?.lastSyncedAt || null;
  // "Sync now" reads the SAVED feed URL server-side, so disable it while the URL
  // input differs from what's persisted — otherwise a user edits the URL, doesn't
  // click Link, hits Sync, and the OLD board syncs.
  const pinDirty = pinUrl.trim() !== linkedBoardUrl;
  const isLinked = !!linkedFeedUrl;

  // The board-URL input is identical whether linking fresh or re-pointing an
  // already-linked board — only the label/button text and (for a re-link) the
  // dirty gate differ.
  const renderPinUrlForm = (label, buttonText) => (
    <div>
      <label htmlFor="pinterest-url" className="block text-xs text-gray-400 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          id="pinterest-url"
          type="text"
          value={pinUrl}
          maxLength={2048}
          placeholder="https://www.pinterest.com/user/board/"
          onChange={(e) => setPinUrl(e.target.value)}
          className="flex-1 min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
        />
        <button
          type="button"
          onClick={handleLinkPinterest}
          disabled={linking || !pinUrl.trim() || (isLinked && !pinDirty)}
          className="px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
        >
          {linking ? 'Linking…' : buttonText}
        </button>
      </div>
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto">
      <button
        type="button"
        onClick={() => navigate('/mood-boards')}
        className="flex items-center gap-1 text-sm text-gray-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Boards
      </button>

      {/* Board metadata */}
      <div className="bg-port-card border border-port-border rounded-md p-4 mb-6">
        <div className="space-y-3">
          <div>
            <label htmlFor="board-name" className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              id="board-name"
              type="text"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
            />
          </div>
          <div>
            <label htmlFor="board-description" className="block text-xs text-gray-400 mb-1">Description</label>
            <textarea
              id="board-description"
              value={description}
              maxLength={5000}
              rows={2}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
            />
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleSaveMeta}
              disabled={!metaDirty || savingMeta}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
            >
              <Save className="w-4 h-4" aria-hidden="true" /> Save
            </button>
          </div>
        </div>
      </div>

      {/* Pinterest link + sync */}
      <div className="bg-port-card border border-port-border rounded-md p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Link2 className="w-4 h-4 text-port-accent" aria-hidden="true" />
          <h2 className="text-sm font-medium text-white">Pinterest board</h2>
        </div>
        {linkedFeedUrl ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <a
                href={linkedBoardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-port-accent hover:underline truncate max-w-full"
              >
                {linkedBoardUrl}
              </a>
              <span className="text-gray-500">
                {lastSyncedAt ? `Last synced ${timeAgo(lastSyncedAt)}` : 'Not synced yet'}
              </span>
            </div>
            <p className="text-[11px] text-gray-500">
              Pinterest’s feed exposes only the most-recent ~25 pins, so a sync pulls those — not the entire board.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleSyncPinterest}
                disabled={syncing || linking || pinDirty}
                title={pinDirty ? 'Link the new URL before syncing' : undefined}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
              {confirmingUnlink ? (
                <InlineConfirmRow
                  question="Unlink this board?"
                  confirmText="Unlink"
                  onConfirm={handleUnlinkPinterest}
                  onCancel={() => setConfirmingUnlink(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingUnlink(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg text-gray-400 hover:text-white transition-colors"
                >
                  <Unlink className="w-4 h-4" aria-hidden="true" /> Unlink
                </button>
              )}
            </div>
            {renderPinUrlForm('Change board URL', 'Update')}
          </div>
        ) : (
          <div>
            {renderPinUrlForm('Board URL', 'Link')}
            <p className="text-[11px] text-gray-500 mt-2">
              Paste a public Pinterest board URL. “Sync now” downloads its pins (newest ~25) into this board.
            </p>
          </div>
        )}
      </div>

      {/* Add item */}
      <div className="bg-port-card border border-port-border rounded-md p-4 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <div className="flex items-center gap-2" role="tablist" aria-label="Item type">
            <button
              type="button"
              role="tab"
              aria-selected={itemType === 'image'}
              onClick={() => setItemType('image')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors ${itemType === 'image' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'}`}
            >
              <ImageIcon className="w-4 h-4" aria-hidden="true" /> Image
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={itemType === 'text'}
              onClick={() => setItemType('text')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors ${itemType === 'text' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'}`}
            >
              <FileText className="w-4 h-4" aria-hidden="true" /> Note
            </button>
          </div>
          {/* Gallery pins (#4188) — pick or upload, added to the board immediately. */}
          <div className="flex items-center gap-2 sm:ml-auto">
            <button
              type="button"
              onClick={() => setImagePickerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg text-gray-400 hover:text-white transition-colors"
            >
              <Images className="w-4 h-4" aria-hidden="true" /> Pick from gallery
            </button>
            <button
              type="button"
              onClick={() => setVideoPickerOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-bg text-gray-400 hover:text-white transition-colors"
            >
              <Film className="w-4 h-4" aria-hidden="true" /> Pick video
            </button>
          </div>
        </div>

        <div className="space-y-3">
          {itemType === 'image' ? (
            <div>
              <label htmlFor="item-image-url" className="block text-xs text-gray-400 mb-1">Image URL</label>
              <input
                id="item-image-url"
                type="text"
                value={imageUrl}
                maxLength={2048}
                placeholder="https://… or /data/images/…"
                onChange={(e) => setImageUrl(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
              />
            </div>
          ) : (
            <div>
              <label htmlFor="item-text" className="block text-xs text-gray-400 mb-1">Note</label>
              <textarea
                id="item-text"
                value={text}
                maxLength={10000}
                rows={2}
                onChange={(e) => setText(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
              />
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="item-caption" className="block text-xs text-gray-400 mb-1">Caption (optional)</label>
              <input
                id="item-caption"
                type="text"
                value={caption}
                maxLength={2000}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
              />
            </div>
            <div>
              <label htmlFor="item-source" className="block text-xs text-gray-400 mb-1">Source (optional)</label>
              <input
                id="item-source"
                type="text"
                value={source}
                maxLength={2048}
                placeholder="where it came from"
                onChange={(e) => setSource(e.target.value)}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
              />
            </div>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleAddItem}
              disabled={adding}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
            >
              <Plus className="w-4 h-4" aria-hidden="true" /> Pin to board
            </button>
          </div>
        </div>
      </div>

      {/* Items grid */}
      {items.length === 0 ? (
        <div className="text-gray-400 text-sm py-12 text-center border border-dashed border-port-border rounded">
          No items yet. Pin an image or note above.
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {items.map((item) => {
            const src = moodBoardItemSrc(item);
            const videoSrc = moodBoardItemVideoSrc(item);
            const analysisSource = moodBoardItemAnalysisSource(item);
            return (
              <div key={item.id} className="bg-port-card border border-port-border rounded-md overflow-hidden flex flex-col">
                {item.type === 'video' && videoSrc ? (
                  playingItemId === item.id ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption -- reference clips have no caption track
                    <video
                      src={videoSrc}
                      poster={src || undefined}
                      controls
                      autoPlay
                      playsInline
                      className="w-full aspect-square object-cover bg-black"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setPlayingItemId(item.id)}
                      aria-label="Play video"
                      className="relative w-full aspect-square bg-port-bg text-gray-600 group"
                    >
                      {src ? (
                        <img
                          src={src}
                          alt={item.caption || ''}
                          loading="lazy"
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            // A synced board can carry a poster URL whose file
                            // only exists on the sending machine (a downloaded
                            // video's thumbnail is named `<id>.jpg`, not
                            // `<filename-stem>.jpg`). The receiver regenerates
                            // the stem-named poster when it pulls the video, so
                            // fall back to that derived name on a 404.
                            const fallback = moodBoardItemSrc({ ...item, imageUrl: null });
                            if (fallback && e.currentTarget.getAttribute('src') !== fallback) {
                              e.currentTarget.src = fallback;
                            }
                          }}
                        />
                      ) : (
                        <span className="w-full h-full flex items-center justify-center">
                          <Film className="w-8 h-8" aria-hidden="true" />
                        </span>
                      )}
                      <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-80 group-hover:opacity-100 transition-opacity">
                        <Play className="w-8 h-8 text-white drop-shadow" aria-hidden="true" />
                      </span>
                    </button>
                  )
                ) : item.type === 'image' || item.type === 'video' ? (
                  src ? (
                    <img src={src} alt={item.caption || ''} loading="lazy" className="w-full aspect-square object-cover bg-port-bg" />
                  ) : (
                    <div className="w-full aspect-square flex items-center justify-center bg-port-bg text-gray-600">
                      <ImageIcon className="w-8 h-8" aria-hidden="true" />
                    </div>
                  )
                ) : (
                  <div className="w-full aspect-square p-3 overflow-y-auto bg-port-bg text-sm text-gray-200 whitespace-pre-wrap">
                    {item.text}
                  </div>
                )}
                <div className="p-2 flex flex-col gap-1">
                  <input
                    type="text"
                    defaultValue={item.caption || ''}
                    placeholder="Add a caption…"
                    maxLength={2000}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next !== (item.caption || '')) handleUpdateCaption(item.id, next);
                    }}
                    className="w-full bg-transparent border-0 border-b border-transparent focus:border-port-border text-xs text-gray-300 px-0 py-0.5 outline-none"
                  />
                  <div className="flex items-center justify-between">
                    {item.source ? (
                      <span className="text-[10px] text-gray-500 truncate" title={item.source}>{item.source}</span>
                    ) : <span />}
                    <div className="flex items-center gap-1">
                      {analysisSource ? (
                        <button
                          type="button"
                          onClick={() => setAnalyzeItemId(item.id)}
                          title={item.analysis ? 'View AI analysis' : 'Analyze with AI'}
                          aria-label={item.analysis ? 'View AI analysis' : 'Analyze with AI'}
                          className={`p-1 transition-colors ${item.analysis ? 'text-port-accent hover:text-port-accent/80' : 'text-gray-500 hover:text-white'}`}
                        >
                          <ScanEye className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setConfirmingItemId(item.id)}
                        title="Remove item"
                        aria-label="Remove item"
                        className="p-1 text-gray-500 hover:text-port-error transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                  {confirmingItemId === item.id ? (
                    <InlineConfirmRow
                      question="Remove this item?"
                      confirmText="Remove"
                      onConfirm={() => handleRemoveItem(item.id)}
                      onCancel={() => setConfirmingItemId(null)}
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <GalleryImagePicker
        open={imagePickerOpen}
        onClose={() => setImagePickerOpen(false)}
        onSelect={handlePickGalleryImage}
        allowUpload
      />
      <GalleryVideoPicker
        open={videoPickerOpen}
        onClose={() => setVideoPickerOpen(false)}
        onSelect={handlePickGalleryVideo}
        allowUpload
        uploadToGallery
      />

      {/* Per-item prompt-from-media analysis (#4188 Phase 3). A successful run
          auto-persists onto the item; the stored analysis renders above the
          analyzer with copy/remove. */}
      {analyzeItem ? (
        <PromptFromMediaModal
          item={analyzeSource}
          open
          onClose={() => setAnalyzeItemId(null)}
          kindDefault={analyzeItem.type === 'video' ? 'video' : 'image'}
          onResult={(result) => persistAnalysis(analyzeItem, result)}
        >
          {analyzeItem.analysis ? (
            <div className="mb-4 p-3 bg-port-bg border border-port-border rounded-lg space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] uppercase tracking-wide text-gray-500">
                  Saved analysis{analyzeItem.analysis.analyzedAt ? ` · ${timeAgo(analyzeItem.analysis.analyzedAt)}` : ''}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => copyToClipboard(analyzeItem.analysis.prompt, 'Analysis prompt copied')}
                    className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
                    aria-label="Copy saved analysis prompt"
                  >
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleClearAnalysis(analyzeItem.id)}
                    className="px-2 py-1 rounded text-[11px] text-gray-400 hover:text-port-error transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {analyzeItem.analysis.rationale ? (
                <p className="text-xs text-gray-300">{analyzeItem.analysis.rationale}</p>
              ) : null}
              <textarea
                readOnly
                value={analyzeItem.analysis.prompt}
                rows={4}
                aria-label="Saved analysis prompt"
                className="w-full bg-port-card border border-port-border rounded-lg p-2 text-xs text-white resize-y"
              />
              {analyzeItem.analysis.negativePrompt ? (
                <textarea
                  readOnly
                  value={analyzeItem.analysis.negativePrompt}
                  rows={2}
                  aria-label="Saved analysis negative prompt"
                  className="w-full bg-port-card border border-port-border rounded-lg p-2 text-xs text-gray-300 resize-y"
                />
              ) : null}
              {(analyzeItem.analysis.providerId || analyzeItem.analysis.model) ? (
                <p className="text-[10px] text-gray-500 truncate">
                  {[analyzeItem.analysis.providerId, analyzeItem.analysis.model].filter(Boolean).join(' · ')}
                </p>
              ) : null}
            </div>
          ) : null}
        </PromptFromMediaModal>
      ) : null}
    </div>
  );
}
