import { useId, useState } from 'react';
import { AlertTriangle, Copy, Image as ImageIcon, Loader2, Monitor, X } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';

const STATUS_LABEL = { analyzing: 'Reading…', ready: 'Ready', error: 'Failed' };

/**
 * Chips for images shown to the voice agent. Tapping a chip opens the exact
 * text that was (or will be) added to the user's message, so nothing reaches
 * the model unseen. `onRemove` adds a remove button (queued images only).
 */
export default function VoiceImageChips({ images, onRemove, className = '' }) {
  const [openId, setOpenId] = useState(null);
  const detailId = useId();
  if (!images?.length) return null;
  const open = images.find((img) => img.id === openId && (img.text || img.error));
  const statusSummary = images
    .filter((img) => STATUS_LABEL[img.status])
    .map((img) => `${img.name || (img.source === 'tab' ? 'Shared tab' : 'Image')}: ${STATUS_LABEL[img.status]}`)
    .join(', ');

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <p role="status" className="sr-only">{statusSummary}</p>
      <ul aria-label="Images for the voice agent" className="flex min-w-0 flex-wrap gap-1">
        {images.map((img) => {
          const SourceIcon = img.source === 'tab' ? Monitor : ImageIcon;
          const canOpen = Boolean(img.text || img.error);
          const isOpen = open?.id === img.id;
          const label = img.name || (img.source === 'tab' ? 'Shared tab' : 'Image');
          return (
            <li key={img.id} className="flex min-w-0 max-w-full items-center rounded-full border border-port-border bg-port-bg font-mono text-[10px] text-port-text">
              <button
                type="button"
                onClick={() => setOpenId(openId === img.id ? null : img.id)}
                disabled={!canOpen}
                aria-expanded={canOpen ? isOpen : undefined}
                aria-controls={isOpen ? detailId : undefined}
                title={canOpen ? 'Show what the agent was told about this image' : 'Describing the image…'}
                className="inline-flex min-h-8 min-w-0 items-center gap-1 rounded-full px-2 pointer-coarse:min-h-11 hover:text-port-accent-text disabled:cursor-default"
              >
                <SourceIcon size={11} aria-hidden="true" className="shrink-0 text-port-accent" />
                <span className="min-w-0 max-w-[9rem] truncate">{label}</span>
                {img.status === 'analyzing' && <Loader2 size={10} aria-hidden="true" className="shrink-0 animate-spin" />}
                {img.status === 'error' && <AlertTriangle size={10} aria-hidden="true" className="shrink-0 text-port-error-text" />}
                {STATUS_LABEL[img.status] && <span className="shrink-0 opacity-70">{STATUS_LABEL[img.status]}</span>}
              </button>
              {onRemove && (
                <button
                  type="button"
                  onClick={() => { if (openId === img.id) setOpenId(null); onRemove(img.id); }}
                  aria-label={`Remove ${label}`}
                  title="Remove"
                  className="inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11 opacity-70 hover:opacity-100 hover:text-port-error-text"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {open && (
        <div id={detailId} className="min-w-0 rounded-lg border border-port-border bg-port-bg p-2 font-mono text-[10px] text-port-text">
          <div className="mb-1 flex items-center justify-between gap-2 text-port-text-muted">
            <span className="min-w-0 truncate">
              {open.error ? 'Not added: the image could not be described' : `Added to your message${open.model ? ` · ${open.model}` : ''}`}
            </span>
            {open.text && (
              <button
                type="button"
                onClick={() => copyToClipboard(open.text, 'Copied image description')}
                aria-label="Copy the added text"
                title="Copy"
                className="inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded pointer-coarse:min-h-11 pointer-coarse:min-w-11 hover:text-port-accent-text"
              >
                <Copy size={11} aria-hidden="true" />
              </button>
            )}
          </div>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{open.error || open.text}</p>
        </div>
      )}
    </div>
  );
}
