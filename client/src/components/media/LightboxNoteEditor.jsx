import { useEffect, useRef, useState } from 'react';

export const NOTE_MAX = 2000;
const NOTE_DEBOUNCE_MS = 500;
const SAVED_INDICATOR_MS = 1500;

// Debounced "My note" editor. Local draft state debounces saves so each
// keystroke doesn't PATCH. onSaveRef keeps the debounce effect off the
// parent's render churn — page components pass inline-arrow
// onAnnotationChange callbacks, which would otherwise restart the timer every
// time a media-gen event arrived.
export default function LightboxNoteEditor({ itemKey, annotation, onAnnotationChange }) {
  const [noteDraft, setNoteDraft] = useState(annotation?.note ?? '');
  const [saveStatus, setSaveStatus] = useState('idle');
  const onSaveRef = useRef(onAnnotationChange);
  const pendingNoteRef = useRef(null);
  useEffect(() => { onSaveRef.current = onAnnotationChange; });
  // Sync noteDraft to whatever the server says (server push, save echo,
  // initial load). Kept separate from the item-swap effect so a successful
  // save's prop update doesn't also reset saveStatus and hide "Saved".
  useEffect(() => {
    setNoteDraft(annotation?.note ?? '');
  }, [itemKey, annotation?.note]);
  // On item swap (or full unmount): flush any pending note to the *old* item's
  // save callback before resetting local state. onSaveRef still holds the old
  // closure at cleanup time because React runs effect cleanups before the new
  // render's ref-update effect body fires. Without this, prev/next silently
  // drops a mid-debounce edit.
  useEffect(() => {
    setSaveStatus('idle');
    return () => {
      if (pendingNoteRef.current !== null && onSaveRef.current) {
        onSaveRef.current({ note: pendingNoteRef.current });
        pendingNoteRef.current = null;
      }
    };
  }, [itemKey]);
  useEffect(() => {
    if (!onSaveRef.current) return undefined;
    if (noteDraft === (annotation?.note ?? '')) {
      pendingNoteRef.current = null;
      // Nothing left to save: an edit typed back to the saved text, or the
      // one render after prev/next where the draft still held the previous
      // item's note. Either one armed 'pending' with no save to clear it.
      setSaveStatus((status) => (status === 'pending' ? 'idle' : status));
      return undefined;
    }
    pendingNoteRef.current = noteDraft;
    setSaveStatus('pending');
    const handle = setTimeout(() => {
      onSaveRef.current?.({ note: noteDraft });
      pendingNoteRef.current = null;
      setSaveStatus('saved');
    }, NOTE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [noteDraft, annotation?.note]);
  useEffect(() => {
    if (saveStatus !== 'saved') return undefined;
    const handle = setTimeout(() => setSaveStatus('idle'), SAVED_INDICATOR_MS);
    return () => clearTimeout(handle);
  }, [saveStatus]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-gray-500 uppercase tracking-wide">My note</span>
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          {saveStatus === 'pending' && <span>Saving…</span>}
          {saveStatus === 'saved' && <span className="text-port-success">Saved</span>}
          {saveStatus === 'idle' && <span>Saves automatically</span>}
          <span>{noteDraft.length}/{NOTE_MAX}</span>
        </div>
      </div>
      <textarea
        aria-label="Note"
        value={noteDraft}
        onChange={(e) => setNoteDraft(e.target.value.slice(0, NOTE_MAX))}
        placeholder="Add a note — use this for cover, reshoot at 24fps, etc."
        rows={3}
        maxLength={NOTE_MAX}
        className="w-full bg-port-bg border border-port-border rounded p-2 text-xs text-gray-200 placeholder:text-gray-600 focus:outline-none focus:border-port-accent resize-y"
      />
    </div>
  );
}
