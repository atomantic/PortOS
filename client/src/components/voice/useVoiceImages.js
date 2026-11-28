import { useCallback, useEffect, useRef, useState } from 'react';
import { onVoiceEvent, imageFileToDataUrl, attachVoiceImage, removeVoiceImage } from '../../services/voiceClient';
import toast from '../ui/Toast';

/**
 * Images queued for the voice agent's next turn (uploads and shared-tab
 * frames). Follows the server's `voice:image` updates; a `sent` image leaves
 * the queue and is handed to `onSent` so the conversation can show it on the
 * user's turn.
 */
export function useVoiceImages({ enabled, onSent }) {
  const [pending, setPending] = useState([]);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const onSentRef = useRef(onSent);
  onSentRef.current = onSent;

  useEffect(() => {
    if (!enabled) return undefined;
    return onVoiceEvent('voice:image', (d) => {
      if (!d || typeof d.id !== 'string') return;
      if (d.status === 'sent' || d.status === 'removed' || d.status === 'dropped') {
        setPending((list) => list.filter((item) => item.id !== d.id));
        if (d.status === 'sent') onSentRef.current?.(d);
        if (d.status === 'dropped') toast(`Voice: dropped ${d.name || 'an image'} (too many queued)`, { icon: '🖼️' });
        return;
      }
      setPending((list) => (list.some((item) => item.id === d.id)
        ? list.map((item) => (item.id === d.id ? { ...item, ...d } : item))
        : [...list, d]));
    });
  }, [enabled]);

  const attachFiles = useCallback(async (files) => {
    for (const file of Array.from(files || [])) {
      const dataUrl = await imageFileToDataUrl(file);
      if (!dataUrl) {
        toast.error(`Voice: couldn't read ${file.name || 'that image'}`);
        continue;
      }
      const id = attachVoiceImage({ dataUrl, source: 'upload', name: file.name });
      setPending((list) => [...list, { id, source: 'upload', name: file.name || 'Image', status: 'analyzing' }]);
    }
  }, []);

  const remove = useCallback((id) => {
    removeVoiceImage(id);
    setPending((list) => list.filter((item) => item.id !== id));
  }, []);

  return { pending, pendingRef, attachFiles, remove };
}
