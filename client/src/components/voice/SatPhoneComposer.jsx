import { ImagePlus, Send } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';
import VoiceImageChips from './VoiceImageChips';

/**
 * The handset's text composer: type a message to the voice assistant without
 * leaving the transceiver. Shared by the floating handset's log and the
 * full-page Voice Call handset, so the input sits on the device on both.
 * `images` ({ pending, attachFiles, remove }) adds an image button and the
 * chips of images queued for the next turn.
 */
export default function SatPhoneComposer({ draft, onDraft, onSend, inputRef, images }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {images && <VoiceImageChips images={images.pending} onRemove={images.remove} />}
      <form
        onSubmit={(event) => { event.preventDefault(); onSend(); }}
        className="flex min-w-0 items-center gap-1.5"
      >
        {images && (
          <FilePickerButton
            accept="image/*"
            multiple
            onChange={(event) => images.attachFiles(event.target.files)}
            ariaLabel="Attach an image for the voice assistant"
            title="Show the assistant an image"
            className="satphone-key inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border px-2.5 text-port-accent-text"
          >
            <ImagePlus size={13} aria-hidden="true" />
          </FilePickerButton>
        )}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          placeholder="Transmit text…"
          aria-label="Message to the voice assistant"
          enterKeyHint="send"
          className="min-h-9 pointer-coarse:min-h-11 min-w-0 flex-1 rounded-lg border border-port-border bg-port-bg px-2.5 py-2 font-mono text-xs text-port-text placeholder:text-port-text-muted focus:border-port-accent"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          title="Send text (Enter)"
          aria-label="Send text"
          className="satphone-key inline-flex min-h-9 min-w-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 shrink-0 items-center justify-center rounded-lg border px-2.5 text-port-accent-text disabled:opacity-35"
        >
          <Send size={13} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
