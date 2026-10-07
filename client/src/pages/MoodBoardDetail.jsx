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
import { ArrowLeft, ImageIcon, FileText, Trash2, Plus, Save, Link2, Unlink, RefreshCw, Images, Film, Play, ScanEye, Copy, AtSign, Download, Sparkles, Clapperboard, Paintbrush } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import TabPills from '../components/ui/TabPills';
import InlineConfirmRow from '../components/ui/InlineConfirmRow';
import GalleryImagePicker from '../components/imageGen/GalleryImagePicker';
import GalleryVideoPicker from '../components/videoGen/GalleryVideoPicker';
import { PromptFromMediaModal } from '../components/media/PromptFromMedia';
import MediaLightbox from '../components/media/MediaLightbox';
import MoodBoardStylePanel from '../components/moodBoard/MoodBoardStylePanel';
import MoodBoardCollagePanel from '../components/moodBoard/MoodBoardCollagePanel';
import usePreviewRoute from '../hooks/usePreviewRoute';
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
  importMoodBoardPinterest,
  importMoodBoardXPost,
  localizeMoodBoardMedia,
  extractMoodBoardItemFrames,
  renderMoodBoardItem,
} from '../services/api';
import socket from '../services/socket';
import { moodBoardItemSrc, moodBoardItemVideoSrc, moodBoardItemAnalysisSource } from '../lib/moodBoardItemSrc';
import {
  moodBoardAnalysisFromResult,
  moodBoardItemPrompt,
  isMoodBoardItemAnalyzed,
  moodBoardItemHasPrompt,
} from '../lib/moodBoardAnalysis';
import { timeAgo } from '../utils/formatters';
import useMounted from '../hooks/useMounted';

export default function MoodBoardDetail() {
  const { id } = useParams();
  // Route changes replace the editor so every draft, modal and pending-action
  // flag belongs to one board, including when the next board fails to load.
  return <MoodBoardEditor key={id} id={id} />;
}

function MoodBoardEditor({ id }) {
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

  // Per-video frame extraction: requested frame count + the item in flight.
  const [frameCount, setFrameCount] = useState(4);
  const [extractingItemId, setExtractingItemId] = useState(null);

  // Text note → image render (#10531): the note whose request is in flight.
  // The queued state itself lives on the item (`item.render`).
  const [renderingItemId, setRenderingItemId] = useState(null);
  // The request already toasts its own refusal; the echoed socket event must not.
  const renderRequestRef = useRef(null);

  // Pinterest link/sync.
  const [pinUrl, setPinUrl] = useState('');
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [importingPinterest, setImportingPinterest] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);

  // X.com (Twitter) post import — one-shot, no persisted link.
  const [xPostUrl, setXPostUrl] = useState('');
  const [importingXPost, setImportingXPost] = useState(false);

  // The keyed editor isolates board state. Also guard async continuations and
  // delayed child callbacks so the old editor cannot toast or start a mutation
  // after navigation. The load sequence drops StrictMode's duplicate GET.
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
      // Boards never serve remote URLs: re-host any external pins in the
      // background, then swap the localized board in.
      if ((data.items || []).some((it) => /^https?:\/\//i.test(it?.imageUrl || ''))) {
        localizeMoodBoardMedia(id, { silent: true }).then((res) => {
          if (!mountedRef.current || seq !== loadSeqRef.current || !res?.board) return;
          if (res.localized > 0) {
            setBoard(res.board);
            toast.success(`Imported ${res.localized} external image${res.localized === 1 ? '' : 's'} into the gallery`);
          }
          if (res.failed > 0) toast.error(`${res.failed} external image${res.failed === 1 ? '' : 's'} could not be downloaded`);
        }).catch(() => {});
      }
    } else {
      setBoard(null);
      toast.error('Mood board not found');
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // A note render was queued, finished or failed — possibly started by
  // autopilot or another tab — so swap in the board's current items.
  useEffect(() => {
    const onRender = async (evt) => {
      if (evt?.boardId !== id) return;
      const fresh = await getMoodBoard(id, { silent: true }).catch(() => null);
      if (!mountedRef.current || !fresh) return;
      setBoard((prev) => (prev ? { ...prev, items: fresh.items, updatedAt: fresh.updatedAt } : fresh));
      if (evt.status === 'failed' && evt.error && renderRequestRef.current !== evt.itemId) toast.error(`Render failed: ${evt.error}`);
    };
    socket.on('mood-board:item-render', onRender);
    return () => socket.off('mood-board:item-render', onRender);
  }, [id, mountedRef]);

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

  const items = Array.isArray(board?.items) ? board.items : [];
  // Still images only (videos play inline); prev/next walks this subset.
  // Lives above early returns so hooks run unconditionally.
  const previewables = useMemo(() => {
    return items
      .filter((it) => it.type === 'image' && moodBoardItemSrc(it))
      .map((it) => {
        const url = moodBoardItemSrc(it);
        return {
          kind: 'image',
          key: `moodboard:${it.id}`,
          id: it.id,
          filename: decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || ''),
          previewUrl: url,
          downloadUrl: url,
          prompt: moodBoardItemPrompt(it) || it.caption || '',
        };
      });
  }, [items]);
  const resolvePreview = useCallback(async () => null, []);
  const [preview, setPreview] = usePreviewRoute(previewables, { resolveItem: resolvePreview });
  const previewIndex = preview ? previewables.findIndex((it) => it.id === preview.id || it.key === preview.key || it.filename === preview.filename) : -1;

  const handleSaveMeta = async () => {
    if (!mountedRef.current) return;
    if (!name.trim()) { toast.error('Board name is required'); return; }
    setSavingMeta(true);
    const updated = await updateMoodBoard(id, { name: name.trim(), description }, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setSavingMeta(false);
    if (!updated) { toast.error('Failed to save board'); return; }
    setBoard(updated);
    toast.success('Board saved');
  };

  const resetAddForm = () => {
    setImageUrl(''); setText(''); setCaption(''); setSource('');
  };

  const handleAddItem = async () => {
    if (!mountedRef.current) return;
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
    if (!mountedRef.current) return;
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
    if (!mountedRef.current) return;
    const item = await addMoodBoardItem(id, payload, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!item) { toast.error('Failed to add item'); return; }
    setBoard((prev) => (prev ? { ...prev, items: [...(prev.items || []), item] } : prev));
  };

  const handlePickGalleryImage = (picked) => {
    if (!picked?.previewUrl && !picked?.key) return;
    const promptText = typeof picked.prompt === 'string' && picked.prompt !== '(no prompt)' ? picked.prompt.trim() : '';
    addPickedItem({
      type: 'image',
      mediaKey: typeof picked.key === 'string' && picked.key.startsWith('image:') ? picked.key : null,
      imageUrl: picked.previewUrl || null,
      prompt: promptText || null,
      caption: promptText || null,
    });
  };

  const handlePickGalleryVideo = (picked) => {
    if (!picked?.filename) return;
    const promptText = typeof picked.prompt === 'string' && picked.prompt !== '(no prompt)' ? picked.prompt.trim() : '';
    addPickedItem({
      type: 'video',
      mediaKey: `video:${picked.filename}`,
      imageUrl: picked.previewUrl || null,
      prompt: promptText || null,
      caption: promptText || null,
    });
  };

  const handleUpdateItemText = async (item, nextText) => {
    if (!mountedRef.current) return;
    const isAnalyzed = isMoodBoardItemAnalyzed(item);
    const patch = {};
    if (isAnalyzed) {
      patch.analysis = { ...item.analysis, prompt: nextText || '' };
      patch.prompt = nextText || null;
      if (!item.caption || item.caption.trim() === (item.analysis?.prompt || '').trim()) {
        patch.caption = nextText ? nextText.slice(0, 2000) : null;
      }
    } else if (item.prompt) {
      patch.prompt = nextText || null;
      if (!item.caption || item.caption.trim() === item.prompt.trim()) {
        patch.caption = nextText ? nextText.slice(0, 2000) : null;
      }
    } else {
      patch.caption = nextText || null;
    }
    const updated = await updateMoodBoardItem(id, item.id, patch, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to update'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === item.id ? updated : it)) }
      : prev));
  };

  // Persist a prompt-from-media run onto the item (#4188 Phase 3). The
  // analyzer can return an image and/or a video prompt; store the one that
  // matches the item's own type, falling back to whichever was generated.
  const persistAnalysis = async (item, result) => {
    if (!mountedRef.current) return;
    const analysis = moodBoardAnalysisFromResult(item, result);
    if (!analysis) return;
    // The caption mirrors the prompt: fill it when empty or when it still holds
    // the previous analysis prompt, but never overwrite a caption the user wrote.
    const prevCaption = (item.caption || '').trim();
    const captionFollows = !prevCaption || prevCaption === (item.analysis?.prompt || '').trim();
    const patch = captionFollows ? { analysis, caption: analysis.prompt.slice(0, 2000) } : { analysis };
    const updated = await updateMoodBoardItem(id, item.id, patch, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Analysis ran but could not be saved to the item'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === item.id ? updated : it)) }
      : prev));
    toast.success('Analysis saved to item');
  };

  const handleClearAnalysis = async (itemId) => {
    if (!mountedRef.current) return;
    const updated = await updateMoodBoardItem(id, itemId, { analysis: null }, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to remove analysis'); return; }
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === itemId ? updated : it)) }
      : prev));
  };

  const handleExtractFrames = async (itemId) => {
    if (!mountedRef.current) return;
    setExtractingItemId(itemId);
    const res = await extractMoodBoardItemFrames(id, itemId, frameCount, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not extract frames'); return null; });
    if (!mountedRef.current) return;
    setExtractingItemId(null);
    if (!res?.board) return;
    setBoard(res.board);
    toast.success(res.added ? `Added ${res.added} frame${res.added === 1 ? '' : 's'} to the board` : 'Those frames are already on the board');
  };

  const handleRenderItem = async (itemId) => {
    if (!mountedRef.current) return;
    setRenderingItemId(itemId);
    renderRequestRef.current = itemId;
    const res = await renderMoodBoardItem(id, itemId, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not render this note'); return null; });
    renderRequestRef.current = null;
    if (!mountedRef.current) return;
    setRenderingItemId(null);
    if (!res?.item) return;
    setBoard((prev) => (prev
      ? { ...prev, items: (prev.items || []).map((it) => (it.id === itemId && it.type === 'text' ? res.item : it)) }
      : prev));
  };

  const handleRemoveItem = async (itemId) => {
    if (!mountedRef.current) return;
    setConfirmingItemId(null);
    const updated = await removeMoodBoardItem(id, itemId, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to remove item'); return; }
    setBoard((prev) => (prev ? { ...prev, items: (prev.items || []).filter((it) => it.id !== itemId) } : prev));
  };

  const handleLinkPinterest = async () => {
    if (!mountedRef.current) return;
    if (!pinUrl.trim()) { toast.error('Enter a Pinterest board URL'); return; }
    setLinking(true);
    const updated = await linkMoodBoardPinterest(id, pinUrl.trim(), { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setLinking(false);
    if (!updated) { toast.error('Could not link that Pinterest URL — is it a public board?'); return; }
    setBoard(updated);
    setPinUrl(updated.pinterest?.boardUrl || pinUrl.trim());
    toast.success('Pinterest board linked');
  };

  const handleUnlinkPinterest = async () => {
    if (!mountedRef.current) return;
    setConfirmingUnlink(false);
    const updated = await unlinkMoodBoardPinterest(id, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    if (!updated) { toast.error('Failed to unlink'); return; }
    setBoard(updated);
    setPinUrl('');
  };

  const handleSyncPinterest = async () => {
    if (!mountedRef.current) return;
    setSyncing(true);
    const result = await syncMoodBoardPinterest(id, { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setSyncing(false);
    if (!result?.board) { toast.error('Pinterest sync failed — the feed may be private or rate-limited'); return; }
    setBoard(result.board);
    toast.success(result.added > 0
      ? `Added ${result.added} new pin${result.added === 1 ? '' : 's'}`
      : 'Up to date — no new pins');
  };

  const handleImportPinterest = async () => {
    if (!mountedRef.current) return;
    if (!pinUrl.trim()) { toast.error('Enter a Pinterest board URL'); return; }
    setImportingPinterest(true);
    const result = await importMoodBoardPinterest(id, pinUrl.trim(), { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setImportingPinterest(false);
    if (!result?.board) {
      toast.error('Could not import that board — check that Pinterest is signed in to the PortOS browser');
      return;
    }
    setBoard(result.board);
    toast.success(result.added > 0
      ? `Added ${result.added} of ${result.found} Pinterest pins`
      : result.found > 0 ? 'No new Pinterest pins were added' : 'The Pinterest board has no pins');
  };

  const handleImportXPost = async () => {
    if (!mountedRef.current) return;
    if (!xPostUrl.trim()) { toast.error('Enter an x.com/twitter.com post URL'); return; }
    setImportingXPost(true);
    const result = await importMoodBoardXPost(id, xPostUrl.trim(), { silent: true }).catch(() => null);
    if (!mountedRef.current) return;
    setImportingXPost(false);
    if (!result?.board) { toast.error('Could not import that post — check the URL or try again'); return; }
    setBoard(result.board);
    setXPostUrl('');
    toast.success(`Added ${result.added} item${result.added === 1 ? '' : 's'} from the post`);
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto">
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
      <div className="flex flex-wrap gap-2">
        <input
          id="pinterest-url"
          type="text"
          value={pinUrl}
          maxLength={2048}
          placeholder="https://www.pinterest.com/user/board/"
          onChange={(e) => setPinUrl(e.target.value)}
          className="flex-[1_1_12rem] min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
        />
        <button
          type="button"
          onClick={handleLinkPinterest}
          disabled={linking || importingPinterest || !pinUrl.trim() || (isLinked && !pinDirty)}
          className="px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
        >
          {linking ? 'Linking…' : buttonText}
        </button>
        <button
          type="button"
          onClick={handleImportPinterest}
          disabled={importingPinterest || linking || syncing || !pinUrl.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <Download className={`w-4 h-4 ${importingPinterest ? 'animate-pulse' : ''}`} aria-hidden="true" />
          {importingPinterest ? 'Importing…' : 'Import pins'}
        </button>
      </div>
    </div>
  );

  return (
    <div className="@container/board min-w-0 max-w-7xl mx-auto space-y-4">
      <button
        type="button"
        onClick={() => navigate('/mood-boards')}
        className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
      >
        <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Boards
      </button>

      {/* Board metadata — one compact row on desktop */}
      <div className="bg-port-card border border-port-border rounded-md p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-[1_1_16rem]">
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
          <div className="min-w-0 flex-[2_1_20rem]">
            <label htmlFor="board-description" className="block text-xs text-gray-400 mb-1">Description</label>
            <textarea
              id="board-description"
              value={description}
              maxLength={5000}
              rows={1}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none resize-y"
            />
          </div>
          <button
            type="button"
            onClick={handleSaveMeta}
            disabled={!metaDirty || savingMeta}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 text-sm rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
          >
            <Save className="w-4 h-4" aria-hidden="true" /> Save
          </button>
        </div>
      </div>

      <MoodBoardStylePanel board={board} onBoardChange={setBoard} />

      <MoodBoardCollagePanel board={board} onBoardChange={setBoard} />

      {/* Use board width, including space lost to the app sidebar. */}
      <div className="grid grid-cols-1 @4xl/board:grid-cols-[minmax(0,1fr)_22rem] gap-6 items-start">
        {/* Left column: Mood board items */}
        <section aria-label="Mood board items" className="min-w-0 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-white">Items ({items.length})</h2>
          </div>

          {items.length === 0 ? (
            <div className="text-gray-400 text-sm py-12 text-center border border-dashed border-port-border rounded">
              No items yet. Pin an image or note to get started.
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-3">
              {items.map((item) => {
                const src = moodBoardItemSrc(item);
                const videoSrc = moodBoardItemVideoSrc(item);
                const analysisSource = moodBoardItemAnalysisSource(item);
                const isAnalyzed = isMoodBoardItemAnalyzed(item);
                const hasPrompt = moodBoardItemHasPrompt(item);
                const promptText = moodBoardItemPrompt(item);
                const displayText = promptText || item.caption || '';
                return (
                  <div key={item.id} className="min-w-0 bg-port-card border border-port-border rounded-md overflow-hidden flex flex-col">
                    <div className="relative w-full aspect-square bg-port-bg">
                      {item.type === 'video' && videoSrc ? (
                        playingItemId === item.id ? (
                          // eslint-disable-next-line jsx-a11y/media-has-caption -- reference clips have no caption track
                          <video
                            src={videoSrc}
                            poster={src || undefined}
                            controls
                            autoPlay
                            playsInline
                            className="w-full h-full object-cover bg-black"
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => setPlayingItemId(item.id)}
                            aria-label="Play video"
                            className="relative w-full h-full bg-port-bg text-gray-600 group block"
                          >
                            {src ? (
                              <img
                                src={src}
                                alt={displayText}
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
                          <button
                            type="button"
                            onClick={() => {
                              const target = previewables.find((p) => p.id === item.id);
                              if (target) setPreview(target);
                            }}
                            aria-label="Preview image"
                            className="block w-full h-full cursor-zoom-in"
                          >
                            <img src={src} alt={displayText} loading="lazy" className="w-full h-full object-cover bg-port-bg" />
                          </button>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-port-bg text-gray-600">
                            <ImageIcon className="w-8 h-8" aria-hidden="true" />
                          </div>
                        )
                      ) : (
                        <div className="w-full h-full p-3 overflow-y-auto bg-port-bg text-sm text-gray-200 whitespace-pre-wrap">
                          {item.text}
                        </div>
                      )}

                      {item.type === 'text' && item.render?.status === 'queued' ? (
                        <div
                          data-testid="item-rendering"
                          className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-black/60 py-1.5 text-xs text-white"
                        >
                          <Paintbrush className="w-3.5 h-3.5 animate-pulse" aria-hidden="true" /> Rendering…
                        </div>
                      ) : null}

                      {/* Status indicator: whether it has been analyzed (or already has a prompt) */}
                      {(isAnalyzed || hasPrompt) && (
                        <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-1 pointer-events-none z-10">
                          {isAnalyzed ? (
                            <span
                              data-testid="item-indicator-analyzed"
                              className="pointer-events-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-port-accent/90 text-white shadow-sm flex items-center gap-1 backdrop-blur-sm"
                              title="Analyzed with image-to-prompt"
                            >
                              <ScanEye className="w-3 h-3" aria-hidden="true" />
                              Analyzed
                            </span>
                          ) : (
                            <span
                              data-testid="item-indicator-prompt"
                              className="pointer-events-auto text-[10px] font-medium px-1.5 py-0.5 rounded bg-port-success/90 text-white shadow-sm flex items-center gap-1 backdrop-blur-sm"
                              title="Already has a prompt"
                            >
                              <Sparkles className="w-3 h-3" aria-hidden="true" />
                              Prompt
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 p-3 flex flex-col gap-2">
                      <div className="min-w-0 flex flex-wrap items-center justify-between gap-1">
                        <span className="text-[10px] font-medium text-gray-400 flex items-center gap-1">
                          {isAnalyzed ? (
                            <span className="text-port-accent flex items-center gap-0.5">
                              <ScanEye className="w-3 h-3" aria-hidden="true" /> Analyzed prompt
                            </span>
                          ) : hasPrompt ? (
                            <span className="text-port-success flex items-center gap-0.5">
                              <Sparkles className="w-3 h-3" aria-hidden="true" /> Prompt
                            </span>
                          ) : (
                            <span>Caption</span>
                          )}
                        </span>
                        {item.caption && promptText && item.caption.trim() !== promptText.trim() ? (
                          <span
                            className="text-[10px] text-gray-500 truncate max-w-[120px]"
                            title={`Default caption: ${item.caption}`}
                          >
                            {item.caption}
                          </span>
                        ) : null}
                      </div>
                      <input
                        type="text"
                        key={`${item.id}-${displayText}`}
                        aria-label={isAnalyzed ? "Analyzed prompt" : hasPrompt ? "Item prompt" : "Item caption"}
                        defaultValue={displayText}
                        title={displayText}
                        placeholder={hasPrompt ? "Add a prompt…" : "Add a caption…"}
                        maxLength={2000}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next !== displayText) handleUpdateItemText(item, next);
                        }}
                        className="min-w-0 w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-300 focus:border-port-accent outline-none"
                      />
                      {item.source ? (
                        <span className="min-w-0 text-[10px] text-gray-500 truncate" title={item.source}>{item.source}</span>
                      ) : null}
                      {item.type === 'text' && item.render?.status === 'failed' ? (
                        <span className="min-w-0 text-[10px] text-port-error break-words">
                          Render failed{item.render.error ? `: ${item.render.error}` : ''}
                        </span>
                      ) : null}
                      <div className="flex flex-wrap items-center justify-end gap-1">
                        {/* Keep the frame count with its extraction action when wrapping. */}
                        {videoSrc ? (
                          <span className="inline-flex shrink-0 items-center gap-1 mr-auto">
                            <input
                              type="number"
                              min={1}
                              max={24}
                              value={frameCount}
                              aria-label="Frames to extract"
                              onChange={(e) => setFrameCount(Math.max(1, Math.min(24, Math.floor(Number(e.target.value)) || 1)))}
                              className="w-14 min-h-[44px] bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs outline-none focus:border-port-accent"
                            />
                            <button
                              type="button"
                              onClick={() => handleExtractFrames(item.id)}
                              disabled={extractingItemId === item.id}
                              title={`Extract ${frameCount} frame${frameCount === 1 ? '' : 's'} and add to board`}
                              aria-label="Extract frames to board"
                              className="min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 text-gray-500 hover:text-white disabled:opacity-50 transition-colors"
                            >
                              <Clapperboard className={`w-3.5 h-3.5 ${extractingItemId === item.id ? 'animate-pulse' : ''}`} aria-hidden="true" />
                            </button>
                          </span>
                        ) : null}
                        {item.type === 'text' ? (
                          <button
                            type="button"
                            onClick={() => handleRenderItem(item.id)}
                            disabled={renderingItemId === item.id || item.render?.status === 'queued'}
                            title="Render this note as an image on the default image backend"
                            className="min-h-[44px] shrink-0 inline-flex items-center gap-1.5 px-2 mr-auto text-xs text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
                          >
                            <Paintbrush className={`w-3.5 h-3.5 ${renderingItemId === item.id ? 'animate-pulse' : ''}`} aria-hidden="true" />
                            {item.render?.status === 'queued' ? 'Rendering…' : 'Render'}
                          </button>
                        ) : null}
                        {analysisSource ? (
                          <button
                            type="button"
                            onClick={() => setAnalyzeItemId(item.id)}
                            title={item.analysis ? 'View prompt from media' : 'Prompt from media'}
                            aria-label={item.analysis ? 'View prompt from media' : 'Prompt from media'}
                            className={`min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 transition-colors ${item.analysis ? 'text-port-accent hover:text-port-accent/80' : 'text-gray-500 hover:text-white'}`}
                          >
                            <ScanEye className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setConfirmingItemId(item.id)}
                          title="Remove item"
                          aria-label="Remove item"
                          className="min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
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
        </section>

        {/* Right column: Add forms */}
        <aside aria-label="Add to mood board" className="@container/add-form min-w-0 w-full space-y-6">
          {/* Add item */}
          <div className="bg-port-card border border-port-border rounded-md p-4">
            <div className="flex items-center gap-2 mb-3">
              <Plus className="w-4 h-4 text-port-accent" aria-hidden="true" />
              <h2 className="text-sm font-medium text-white">Add item</h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {/* The shared TabPills owns the roving tabindex + arrow-key
                  contract — never roll a tab bar (client/src/AGENTS.md). */}
              <TabPills
                variant="pills"
                size="sm"
                tabs={[
                  { id: 'image', label: 'Image', icon: ImageIcon },
                  { id: 'text', label: 'Note', icon: FileText },
                ]}
                activeTab={itemType}
                onChange={setItemType}
                ariaLabel="Item type"
              />
              {/* Gallery pins (#4188) — pick or upload, added to the board immediately. */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
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
              <div className="grid grid-cols-1 @sm/add-form:grid-cols-2 gap-3">
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

          {/* Pinterest link + sync */}
          <div className="bg-port-card border border-port-border rounded-md p-4">
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
                <p className="text-[11px] text-gray-500">
                  Use “Import pins” below to read the full board from your signed-in PortOS browser.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSyncPinterest}
                    disabled={syncing || linking || importingPinterest || pinDirty}
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
                  Link a public board to sync its newest ~25 pins. “Import pins” reads the full board from your signed-in PortOS browser and saves the images here.
                </p>
              </div>
            )}
          </div>

          {/* X.com (Twitter) post import */}
          <div className="bg-port-card border border-port-border rounded-md p-4">
            <div className="flex items-center gap-2 mb-3">
              <AtSign className="w-4 h-4 text-port-accent" aria-hidden="true" />
              <h2 className="text-sm font-medium text-white">Import from an X post</h2>
            </div>
            <div>
              <label htmlFor="x-post-url" className="block text-xs text-gray-400 mb-1">Post URL</label>
              <div className="flex flex-wrap gap-2">
                <input
                  id="x-post-url"
                  type="text"
                  value={xPostUrl}
                  maxLength={2048}
                  placeholder="https://x.com/user/status/1234567890"
                  onChange={(e) => setXPostUrl(e.target.value)}
                  className="flex-[1_1_12rem] min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:border-port-accent outline-none"
                />
                <button
                  type="button"
                  onClick={handleImportXPost}
                  disabled={importingXPost || !xPostUrl.trim()}
                  className="px-3 py-1.5 text-sm rounded bg-port-success text-white hover:bg-port-success/80 disabled:opacity-50 transition-colors"
                >
                  {importingXPost ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
            <p className="text-[11px] text-gray-500 mt-2">
              Paste a public x.com/twitter.com post URL. Pulls every attached photo (or its video) into this board.
            </p>
          </div>
        </aside>
      </div>

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

      {previewIndex >= 0 ? (
        <MediaLightbox
          item={previewables[previewIndex]}
          onClose={() => setPreview(null)}
          hasPrevious={previewIndex > 0}
          hasNext={previewIndex < previewables.length - 1}
          onPrevious={() => setPreview(previewables[previewIndex - 1])}
          onNext={() => setPreview(previewables[previewIndex + 1])}
        />
      ) : null}

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
                    className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
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
