import { Link } from 'react-router';
import { ArrowUp, ImagePlus, MessageCircle, RefreshCw, X } from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import FilePickerButton from '../../ui/FilePickerButton';
import PersistentMindTemporaryRoute from '../PersistentMindTemporaryRoute';
import { UPLOAD_IMAGE_ACCEPT } from '../../../utils/fileUpload';
import { ConversationItem, MAX_MESSAGE_IMAGES, MindImage, MindTurnIndicator } from './MindPanelParts.jsx';

export default function MindConversationPanel({
  turnProgress,
  showActivity,
  setShowActivity,
  messageListRef,
  loading,
  events,
  conversationItems,
  loadError,
  selectedEventId,
  selectEvent,
  submitMessage,
  submitError,
  messageImageError,
  imageAttachmentsUnavailable,
  imageCapabilityGuidance,
  messageImages,
  removeMessageImage,
  submitting,
  messageImagesUploading,
  thinkingPresets,
  providers,
  selectedPresetId,
  selectPreset,
  openPanel,
  isPaused,
  uploadMessageImages,
  messageText,
  changeMessageText,
  handleMessageKeyDown,
  selectedPreset,
}) {
  return (
    <section data-testid="mind-chat" aria-label="Persistent mind chat" className="flex h-[68dvh] min-h-[30rem] flex-col overflow-hidden rounded-[1.5rem] border border-port-border bg-port-card shadow-lg shadow-black/10 sm:min-h-[34rem] xl:h-full xl:min-h-0">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-port-border bg-port-card/95 px-3 py-2.5 sm:px-4">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-medium text-port-text"><span className="shrink-0">Conversation</span> <MindTurnIndicator progress={turnProgress} /></h3>
        <label htmlFor="mind-show-activity" className="flex shrink-0 items-center gap-2 rounded-full border border-port-border px-2.5 py-1.5 text-[11px] text-port-text-muted">
          <input id="mind-show-activity" type="checkbox" checked={showActivity} onChange={(event) => setShowActivity(event.target.checked)} className="accent-port-accent" /> Activity
        </label>
      </header>

      <div ref={messageListRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-5 sm:px-5" aria-label="Persistent mind conversation">
        {loading && events === null ? (
          <div className="flex h-full items-center justify-center"><BrailleSpinner text="Loading mind history" /></div>
        ) : conversationItems.length === 0 && !loadError ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-port-accent/10 text-port-accent"><MessageCircle size={26} aria-hidden="true" /></span>
            <p className="text-sm font-medium text-port-text">Start the conversation</p>
            <p className="mt-1 max-w-sm text-xs text-port-text-muted">Send a message below. This thread stays on this machine and carries forward across wakes.</p>
          </div>
        ) : (
          <ol className="space-y-3">
            {conversationItems.map((item) => (
              <ConversationItem
                key={item.event.eventId}
                {...item}
                selectedEventId={selectedEventId}
                onSelect={selectEvent}
              />
            ))}
          </ol>
        )}
      </div>

      <form onSubmit={submitMessage} className="shrink-0 border-t border-port-border bg-port-card/95 px-2.5 pb-[max(0.65rem,env(safe-area-inset-bottom))] pt-2.5 sm:px-4">
        {submitError && <p role="alert" className="mt-2 text-sm text-port-error">{submitError} — Retry uses the same id, so it will not duplicate the input.</p>}
        {messageImageError && <p role="alert" className="mt-2 text-sm text-port-error">{messageImageError}</p>}
        {imageAttachmentsUnavailable && (
          <p className="mt-2 text-xs text-port-text-muted">
            Image attachments are unavailable for this Mind profile. {imageCapabilityGuidance || 'Choose a vision-capable provider or model in'}{' '}
            <Link to="/settings?tab=providers" className="text-port-accent underline">Settings</Link>.
          </p>
        )}
        {messageImages.length > 0 && (
          <ul aria-label="Attached images" className="mt-2 flex flex-wrap gap-2">
            {messageImages.map((image) => (
              <li key={image.attachmentId} className="relative h-16 w-16 overflow-hidden rounded-lg border border-port-border bg-port-bg">
                <MindImage image={image} className="h-full w-full object-cover" />
                <button type="button" onClick={() => void removeMessageImage(image)} disabled={submitting || messageImagesUploading} aria-label={`Remove ${image.originalName}`} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center absolute right-1 top-1 rounded-full bg-port-bg/90 p-1 text-port-text shadow disabled:opacity-50">
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <PersistentMindTemporaryRoute
          presets={thinkingPresets}
          providers={providers}
          selectedPresetId={selectedPresetId}
          onSelectPreset={selectPreset}
          onManagePresets={() => openPanel('models')}
          disabled={submitting}
          paused={isPaused}
          imageCount={messageImages.length}
        />
        <div className="flex items-end gap-2 rounded-[1.35rem] border border-port-border bg-port-bg p-1.5 pl-3 focus-within:border-port-accent/70 focus-within:ring-1 focus-within:ring-port-accent/30">
          <FilePickerButton
            accept={UPLOAD_IMAGE_ACCEPT}
            multiple
            onChange={(event) => uploadMessageImages(event.target.files)}
            disabled={submitting || messageImagesUploading || imageAttachmentsUnavailable || messageImages.length >= MAX_MESSAGE_IMAGES}
            ariaLabel="Attach images"
            title={imageAttachmentsUnavailable ? 'Image attachments are unavailable for this profile' : 'Attach images'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-port-text-muted hover:bg-port-border/50 hover:text-port-text"
          >
            {messageImagesUploading ? <RefreshCw size={17} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={18} aria-hidden="true" />}
          </FilePickerButton>
          <label htmlFor="mind-input-text" className="sr-only">Message</label>
          <AutoSizeTextarea id="mind-input-text" value={messageText} onChange={(event) => changeMessageText(event.target.value)} onKeyDown={handleMessageKeyDown} maxLength={8000} rows={1} className="min-h-[36px] max-h-[40vh] flex-1 overflow-y-auto bg-transparent py-2 text-sm leading-5 text-port-text outline-none placeholder:text-port-text-muted" placeholder="Message Persistent Mind" />
          <button type="submit" disabled={(!messageText.trim() && messageImages.length === 0) || submitting || messageImagesUploading} aria-label={submitting ? 'Sending message' : submitError ? 'Retry' : selectedPreset ? `Send with ${selectedPreset.label}` : 'Send message'} title={selectedPreset ? `Send this one message with ${selectedPreset.label}` : undefined} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-colors disabled:cursor-not-allowed disabled:bg-port-border disabled:text-port-text-muted ${selectedPreset ? 'bg-port-warning hover:bg-port-warning/85' : 'bg-port-accent hover:bg-port-accent/85'}`}>
            {submitting ? <RefreshCw size={17} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={19} strokeWidth={2.5} aria-hidden="true" />}
          </button>
        </div>
      </form>
    </section>
  );
}
