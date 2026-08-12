import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageUp, Send, X } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';
import FormField from '../ui/FormField';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../hooks/usePopoverPosition.js';
import useEscapeKey from '../../hooks/useEscapeKey';
import useClickOutside from '../../hooks/useClickOutside.js';
import { IMAGE_ACCEPT, validateImageFile } from '../../utils/fileUpload';
import { formatBytes } from '../../utils/formatters';
import toast from '../ui/Toast';

const PANEL_WIDTH = 352;

/**
 * "Photo" button + composer popover for the Shell page: pick (or snap, or paste,
 * or drag) an image, type a message, and send both to whatever is running in the
 * active session — the point being a live `claude`/`codex` TUI, which reads the
 * image off disk from the path the server pastes in.
 *
 * The picker is `IMAGE_ACCEPT` (png/jpeg/webp) rather than `image/*` on purpose:
 * naming `image/jpeg` is what makes iOS transcode a HEIC camera roll photo to
 * JPEG on the way out, and the server only accepts formats it can magic-byte
 * verify. No `capture` attribute — that would force camera-only and lock the user
 * out of their photo library; the iOS sheet already offers "Take Photo".
 *
 * The panel is PORTALED and fixed-positioned via `usePopoverPosition`, which
 * measures the trigger and clamps/flips into the viewport. Both hosts need that:
 * the fullscreen control bar is `overflow-x-auto` (an `auto` overflow on one axis
 * makes the other clip too, so an in-flow absolute panel would be cut off) and it
 * scrolls horizontally, so a hardcoded offset would detach from the button.
 *
 * @param {Object} props
 * @param {(file: File, message: string) => Promise<boolean>} props.onSend - resolves
 *   true once the server confirms the paste; a false keeps the composer open with
 *   the user's message intact so they can retry without retyping.
 * @param {'below'|'above'} [props.placement] - preferred side; flips if there's no room
 */
export default function ShellImageDrop({ onSend, placement = 'below' }) {
  const [open, setOpen] = useState(false);
  // One piece of state, not a `file`/`preview` pair kept in lockstep — divergence
  // becomes unrepresentable and the render branch needs no optional chaining.
  const [picked, setPicked] = useState(null);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const containerRef = useRef(null);
  // Bumped by every edit to the draft (pick, remove, message, close). A send
  // captures it and only tears the composer down if it still matches — otherwise a
  // slow send the user cancelled and re-drafted mid-flight would, on success, wipe
  // the photo and message they had just started.
  const draftGenRef = useRef(0);
  const bumpDraft = () => { draftGenRef.current += 1; };
  const { triggerRef, popoverRef, style } = usePopoverPosition({
    open,
    width: PANEL_WIDTH,
    position: placement === 'above' ? 'above' : 'below',
    // The panel's height changes when the picker swaps for the thumbnail, so
    // re-measure on that (it decides whether the preferred side still fits).
    contentDeps: [!!picked],
  });

  // Object URLs are revoked on replacement and on unmount — a long Shell session
  // where the user sends a dozen photos would otherwise pin every one in memory.
  useEffect(() => {
    if (!picked) return undefined;
    return () => URL.revokeObjectURL(picked.url);
  }, [picked]);

  const selectFile = useCallback((file) => {
    if (!file) return;
    const problem = validateImageFile(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    bumpDraft();
    setPicked({ file, url: URL.createObjectURL(file) });
  }, []);

  const clearFile = useCallback(() => {
    bumpDraft();
    setPicked(null);
  }, []);

  const editMessage = useCallback((next) => {
    bumpDraft();
    setMessage(next);
  }, []);

  const close = useCallback(() => {
    bumpDraft();
    setOpen(false);
    setPicked(null);
    setMessage('');
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    selectFile(e.dataTransfer?.files?.[0]);
  }, [selectFile]);

  // Desktop screenshot → Cmd+Shift+Ctrl+4 → paste straight into the composer.
  const handlePaste = useCallback((e) => {
    const pasted = Array.from(e.clipboardData?.files || [])
      .find(f => f.type.startsWith('image/'));
    if (!pasted) return;
    e.preventDefault();
    selectFile(pasted);
  }, [selectFile]);

  const send = useCallback(async () => {
    if (!picked || sending) return;
    const gen = draftGenRef.current;
    setSending(true);
    const ok = await onSend(picked.file, message.trim());
    // Always clear `sending` — only one send is ever in flight (the guard above),
    // so the flag belongs to this one regardless of what the draft did meanwhile.
    setSending(false);
    // Tear the composer down only on success AND only while it still holds the
    // draft we sent: on failure the user keeps their message and file to retry, and
    // a completion the user has since re-drafted past must not wipe the new draft.
    if (ok && draftGenRef.current === gen) close();
  }, [picked, message, onSend, sending, close]);

  useEscapeKey(open, close);

  // This panel is portaled to <body>, so it isn't a descendant of the trigger
  // container — a single-ref containment check would read every click on the
  // textarea as outside and close the composer mid-typing. Both refs have to
  // count as "inside", which is what the array form of useClickOutside does.
  useClickOutside([containerRef, popoverRef], open, close);

  return (
    <div className="relative shrink-0" ref={containerRef}>
      <button
        ref={triggerRef}
        onClick={() => (open ? close() : setOpen(true))}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors border min-h-[40px] shrink-0 ${
          open
            ? 'bg-port-accent/25 text-port-accent border-port-accent/50'
            : 'bg-port-accent/15 hover:bg-port-accent/25 text-port-accent hover:text-port-accent/80 border-port-accent/30'
        }`}
        title="Send a photo to this session"
        aria-label="Send a photo to this session"
        aria-expanded={open}
      >
        <ImageUp size={14} />
        <span className="hidden sm:inline">Photo</span>
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          className="fixed max-w-[calc(100vw-1rem)] z-[100] p-3 bg-port-card border border-port-border rounded-lg shadow-xl space-y-2"
          style={{
            left: style?.left ?? `${VIEWPORT_PADDING}px`,
            top: style?.top ?? `${VIEWPORT_PADDING}px`,
            width: style?.width ?? `${PANEL_WIDTH}px`,
            // Hidden until measured so the panel never flashes at the corner.
            visibility: style ? 'visible' : 'hidden',
          }}
        >
          {picked ? (
            <div className="flex items-start gap-2">
              <img
                src={picked.url}
                alt={picked.file.name}
                className="w-16 h-16 object-cover rounded border border-port-border"
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-300 truncate" title={picked.file.name}>{picked.file.name}</div>
                <div className="text-xs text-gray-500 font-mono">{formatBytes(picked.file.size)}</div>
              </div>
              <button
                onClick={clearFile}
                className="p-1 text-gray-400 hover:text-white transition-colors"
                title="Remove image"
                aria-label="Remove image"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <FilePickerButton
              accept={IMAGE_ACCEPT}
              onChange={(e) => selectFile(e.target.files?.[0])}
              className="flex flex-col items-center justify-center gap-1 w-full py-4 border border-dashed border-port-border hover:border-port-accent/50 rounded text-xs text-gray-400 hover:text-gray-200 transition-colors"
              ariaLabel="Choose a photo to send to this session"
            >
              <ImageUp size={18} />
              <span>Choose, drop, or paste a photo</span>
            </FilePickerButton>
          )}

          <FormField label="Message" labelClassName="block text-xs text-gray-400 mb-1">
            <textarea
              value={message}
              onChange={(e) => editMessage(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter adds a newline — the same contract as
                // every other agent prompt box in PortOS.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="What should the agent do with this photo?"
              className="w-full px-2 py-1.5 bg-port-bg text-white text-xs rounded border border-port-border focus:outline-none focus:border-port-accent placeholder-gray-500 resize-y"
            />
          </FormField>

          <div className="flex items-center gap-2">
            <button
              onClick={send}
              disabled={!picked || sending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded text-xs transition-colors min-h-[40px]"
            >
              <Send size={14} />
              {sending ? 'Sending…' : 'Send'}
            </button>
            <button
              onClick={close}
              className="px-3 py-1.5 bg-port-card hover:bg-port-border text-gray-300 hover:text-white rounded text-xs transition-colors border border-port-border min-h-[40px]"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Pastes the message plus the saved image path into the session, so a running
            agent can read it.
          </p>
        </div>,
        document.body
      )}
    </div>
  );
}
