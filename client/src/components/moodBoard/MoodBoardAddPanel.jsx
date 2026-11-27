import { useState } from 'react';
import { FileText, Film, ImageIcon, Images, Plus } from 'lucide-react';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import GalleryVideoPicker from '../videoGen/GalleryVideoPicker';
import MediaBatchImport from '../media/MediaBatchImport';
import TabPills from '../ui/TabPills';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { addMoodBoardItem } from '../../services/apiMoodBoard.js';

function moodBoardAddErrorMessage(err) {
  const details = Array.isArray(err?.context?.details)
    ? err.context.details.map((entry) => entry?.message).filter((message) => typeof message === 'string' && message)
    : [];
  return details.join('; ') || err?.message || 'Failed to add item';
}

export default function MoodBoardAddPanel({ id, onItemAdded }) {
  const mountedRef = useMounted();
  const [itemType, setItemType] = useState('image');
  const [imageUrl, setImageUrl] = useState('');
  const [text, setText] = useState('');
  const [caption, setCaption] = useState('');
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [videoPickerOpen, setVideoPickerOpen] = useState(false);

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
    let addError = null;
    const item = await addMoodBoardItem(id, payload, { silent: true }).catch((err) => {
      addError = err;
      return null;
    });
    if (!mountedRef.current) return;
    setAdding(false);
    if (!item) { toast.error(moodBoardAddErrorMessage(addError)); return; }
    onItemAdded(item);
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
    onItemAdded(item);
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

  return (
    <div className="@container/add-form bg-port-card border border-port-border rounded-md p-4">
      <div className="flex items-center gap-2 mb-3">
        <Plus className="w-4 h-4 text-port-accent" aria-hidden="true" />
        <h2 className="text-sm font-medium text-white">Add item</h2>
      </div>
      <div className="mb-3">
        <MediaBatchImport moodBoardId={id} onImported={(_media, _collection, item) => onItemAdded(item)} />
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
              placeholder="https://…, data:image/…, or /data/images/…"
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
    </div>
  );
}
