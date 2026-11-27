import { useState } from 'react';
import { Link } from 'react-router';
import { Clapperboard, ExternalLink, Film, GalleryHorizontal, ImageIcon, Paintbrush, Play, ScanEye, Sparkles, Trash2, Wand2 } from 'lucide-react';
import AutoSizeTextarea from '../ui/AutoSizeTextarea';
import DraftNumber from '../ui/DraftNumber';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import MediaImage from '../MediaImage';
import { moodBoardItemSrc, moodBoardItemVideoSrc, moodBoardItemAnalysisSource } from '../../lib/moodBoardItemSrc';
import {
  isMoodBoardItemAnalyzed, moodBoardItemHasPrompt, moodBoardItemPrompt, moodBoardItemSendLinks,
} from '../../lib/moodBoardAnalysis';
import { isHttpUrl } from '../../utils/urlNormalize';

function MoodBoardItemTextField({ item, displayText, isAnalyzed, hasPrompt, onUpdate }) {
  const [draft, setDraft] = useState(displayText);

  return (
    <AutoSizeTextarea
      aria-label={isAnalyzed ? 'Analyzed prompt' : hasPrompt ? 'Item prompt' : 'Item caption'}
      value={draft}
      title={displayText}
      placeholder={hasPrompt ? 'Add a prompt…' : 'Add a caption…'}
      maxLength={isAnalyzed ? 8000 : item.prompt ? 16000 : 2000}
      rows={1}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== displayText) onUpdate(item, next);
      }}
      className="min-w-0 w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs text-gray-300 focus:border-port-accent outline-none"
    />
  );
}

export default function MoodBoardItemCard({
  item, position, playing, confirmingRemoval, extracting, rendering,
  onPlay, onPreview, onUpdateText, onRequestRemove, onRemove, onCancelRemove,
  onExtractFrames, onPickFrames, onRender, onAnalyze,
}) {
  const [frameCount, setFrameCount] = useState(4);
  const mediaType = item.type === 'text' ? 'note' : item.type;
  const caption = item.caption?.trim().replace(/\s+/g, ' ');
  const shortCaption = caption?.length > 60 ? `${caption.slice(0, 59)}…` : caption;
  const itemName = shortCaption ? `${mediaType} ${position} (${shortCaption})` : `${mediaType} ${position}`;
  const src = moodBoardItemSrc(item);
  const videoSrc = moodBoardItemVideoSrc(item);
  const analysisSource = moodBoardItemAnalysisSource(item);
  const isAnalyzed = isMoodBoardItemAnalyzed(item);
  const hasPrompt = moodBoardItemHasPrompt(item);
  const promptText = moodBoardItemPrompt(item);
  const displayText = promptText || item.caption || '';
  const sendLinks = moodBoardItemSendLinks(item);
  const textField = (
    <MoodBoardItemTextField
      key={`${item.id}-${displayText}`}
      item={item}
      displayText={displayText}
      isAnalyzed={isAnalyzed}
      hasPrompt={hasPrompt}
      onUpdate={onUpdateText}
    />
  );
  return (
    <div className="min-w-0 bg-port-card border border-port-border rounded-md overflow-hidden flex flex-col">
      <div className="relative w-full aspect-square bg-port-bg">
        {item.type === 'video' && videoSrc ? (
          playing ? (
            // reference clips have no caption track
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
              onClick={() => onPlay(item.id)}
              aria-label={`Play ${itemName}`}
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
              onClick={() => onPreview(item.id)}
              aria-label={`Preview ${itemName}`}
              className="min-h-11 min-w-11 block w-full h-full cursor-zoom-in"
            >
              <MediaImage thumbnail src={src} alt={displayText} loading="lazy" className="w-full h-full object-cover bg-port-bg" />
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
            className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 port-media-overlay py-1.5 text-xs"
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
      <div className="min-w-0 p-2 sm:p-3 flex flex-col gap-2">
        <div className="min-w-0 flex items-center gap-2">
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
          <button
            type="button"
            onClick={(event) => onRequestRemove(item.id, event.currentTarget)}
            title="Remove item"
            aria-label={`Remove ${itemName}`}
            className="min-h-[44px] min-w-[44px] shrink-0 ml-auto -my-2.5 inline-flex items-center justify-center p-1 text-gray-500 hover:text-port-error transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
        {confirmingRemoval ? (
          <InlineConfirmRow
            question="Remove this item?"
            stacked
            autoFocus
            role="group"
            aria-label="Remove this mood board item?"
            confirmText="Remove"
            onConfirm={() => onRemove(item.id)}
            onCancel={onCancelRemove}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              onCancelRemove();
            }}
          />
        ) : null}
        {hasPrompt ? (
          <details className="min-w-0">
            <summary className="cursor-pointer rounded border border-port-border px-2 py-1.5 text-xs text-gray-400 hover:text-gray-200 focus-visible:outline focus-visible:outline-port-accent">
              Prompt text
            </summary>
            <div className="mt-2">
              {textField}
            </div>
          </details>
        ) : (
          textField
        )}
        {item.source ? (
          <span className="min-w-0 text-[10px] text-gray-500 truncate" title={item.source}>{item.source.replace(/^https?:\/\//i, '')}</span>
        ) : null}
        {item.type === 'text' && item.render?.status === 'failed' ? (
          <span className="min-w-0 text-[10px] text-port-error break-words">
            Render failed{item.render.error ? `: ${item.render.error}` : ''}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-1">
          {isHttpUrl(item.source) ? (
            <a
              href={item.source}
              target="_blank"
              rel="noopener noreferrer"
              title={item.source}
              className="min-h-[44px] inline-flex items-center justify-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-400 hover:text-white hover:border-port-accent focus-visible:outline-2 focus-visible:outline-port-accent transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              Visit source
            </a>
          ) : null}
          {/* Keep the frame count with its extraction action when wrapping. */}
          {videoSrc ? (
            <span className="inline-flex shrink-0 items-center gap-1 mr-auto">
              <DraftNumber integer min={1} max={24} value={frameCount} onCommit={setFrameCount}>
                {(field) => <input type="number" aria-label={`Frames to extract from ${itemName}`} className="w-14 min-h-[44px] bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs outline-none focus:border-port-accent" {...field} />}
              </DraftNumber>
              <button
                type="button"
                onClick={() => onExtractFrames(item.id, frameCount)}
                disabled={extracting}
                title={`Extract ${frameCount} frame${frameCount === 1 ? '' : 's'} and add to board`}
                aria-label={`Extract frames to board from ${itemName}`}
                className="min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 text-gray-500 hover:text-white disabled:opacity-50 transition-colors"
              >
                <Clapperboard className={`w-3.5 h-3.5 ${extracting ? 'animate-pulse' : ''}`} aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onPickFrames(item.id)}
                title="Pick frames on a timeline and add them to the board"
                aria-label={`Pick frames from ${itemName}`}
                className="min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 text-gray-500 hover:text-white transition-colors"
              >
                <GalleryHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </span>
          ) : null}
          {item.type === 'text' ? (
            <button
              type="button"
              onClick={() => onRender(item.id)}
              disabled={rendering || item.render?.status === 'queued'}
              title="Render this note as an image on the default image backend"
              className="min-h-[44px] shrink-0 inline-flex items-center gap-1.5 px-2 mr-auto text-xs text-gray-300 hover:text-white disabled:opacity-50 transition-colors"
            >
              <Paintbrush className={`w-3.5 h-3.5 ${rendering ? 'animate-pulse' : ''}`} aria-hidden="true" />
              {item.render?.status === 'queued' ? 'Rendering…' : 'Render'}
            </button>
          ) : null}
          {[
            ['textToImage', ImageIcon, 'Text to image with this prompt'],
            ['imageToImage', Wand2, 'Send to image-to-image'],
            ['video', Film, sendLinks.imageToImage ? 'Send to video' : 'Text to video with this prompt'],
          ].map(([key, Icon, label]) => (sendLinks[key] ? (
            <Link
              key={key}
              to={sendLinks[key]}
              title={label}
              aria-label={`${label} for ${itemName}`}
              className="min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 text-gray-500 hover:text-white transition-colors"
            >
              <Icon className="w-3.5 h-3.5" aria-hidden="true" />
            </Link>
          ) : null))}
          {analysisSource ? (
            <button
              type="button"
              onClick={() => onAnalyze(item.id)}
              title={item.analysis ? 'View prompt from media' : 'Prompt from media'}
              aria-label={`${item.analysis ? 'View prompt from media' : 'Prompt from media'} for ${itemName}`}
              className={`min-h-[44px] min-w-[44px] shrink-0 inline-flex items-center justify-center p-1 transition-colors ${item.analysis ? 'text-port-accent hover:text-port-accent/80' : 'text-gray-500 hover:text-white'}`}
            >
              <ScanEye className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
