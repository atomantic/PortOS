import { useState } from 'react';
import Modal from '../ui/Modal';
import ModelInputPreview from '../media/ModelInputPreview';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { previewImagePrompt } from '../../services/api';
import { buildFableLoomImageRequest } from './sceneMediaRequests';
import { fieldClass, labelClass } from './fieldStyles';

export default function LoomImageComposer({
  loom, episode, node, universe, series, onRender, onClose, disabled = false, disabledReason = '',
}) {
  const [prompt, setPrompt] = useState(node.imagePrompt || '');
  const request = buildFableLoomImageRequest({ loom, episodeId: episode.id, node: { ...node, imagePrompt: prompt } });
  const preview = useModelInputPreview(previewImagePrompt, request, {
    revision: JSON.stringify([loom, episode, universe, series]),
  });
  const [render, rendering] = useAsyncAction(async () => {
    const result = await onRender({ ...node, imagePrompt: prompt }, request);
    if (result) onClose();
  });
  return (
    <Modal open onClose={onClose} size="lg" ariaLabel="Render scene image">
      <div className="space-y-4 p-4">
        <h2 className="text-lg font-semibold">Render scene image</h2>
        <label htmlFor="loom-image-composer-prompt" className={labelClass}>Scene image prompt</label>
        <textarea id="loom-image-composer-prompt" className={fieldClass} rows={4}
          value={prompt} onChange={event => setPrompt(event.target.value)} disabled={rendering} />
        <ModelInputPreview preview={preview} prompt={prompt} />
        {!preview.preview && !preview.error && <p role="status" className="text-xs text-port-text-muted">Preparing model input…</p>}
        {disabledReason && <p className="text-xs text-port-warning">{disabledReason}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-port-border px-3 py-2 text-sm">Cancel</button>
          <button type="button" onClick={render}
            disabled={disabled || rendering || !prompt.trim() || !preview.preview || !!preview.error}
            className="rounded border border-port-accent bg-port-accent px-3 py-2 text-sm text-white disabled:opacity-45">
            {rendering ? 'Starting render…' : 'Render'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
