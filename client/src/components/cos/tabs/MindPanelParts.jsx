import { useState } from 'react';
import { AlertTriangle, Brain, Cpu, Database, Eraser, ListChecks, Settings2, Wrench } from 'lucide-react';
import { formatDateTime, timeUntil } from '../../../utils/formatters';
import { mindTurnHeadline } from '../../../lib/mindTurnProgress.js';

export const MAX_MESSAGE_IMAGES = 8;
export const MIND_PANEL_TABS = [
  { id: 'context', label: 'Context', icon: Brain },
  { id: 'journal', label: 'Journal', icon: ListChecks },
  { id: 'memories', label: 'Memories', icon: Database },
  { id: 'maintenance', label: 'Cleanup', icon: Eraser },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'settings', label: 'Settings', icon: Settings2 },
];

const EVENT_LABELS = {
  'mind.message.accepted': 'User input',
  'mind.annotation.accepted': 'Annotation',
  'mind.summary': 'Mind summary',
  'mind.model.result': 'Mind summary',
  'mind.turn.completed': 'Mind summary',
  'mind.thought': 'Working note',
  'mind.reply': 'Chief of Staff',
  'mind.memory.candidate': 'Memory proposal',
  'mind.memory.created': 'Memory created',
  'mind.memory.failed': 'Memory save failed',
  'mind.capability.request': 'Action request',
  'mind.capability.result': 'Action outcome',
  'mind.memory.promoted': 'Memory promoted',
  'mind.maintenance.completed': 'Mindspace cleaned',
};

export const eventLabel = (kind) => EVENT_LABELS[kind] || 'System state';
export const eventText = (event) => {
  const data = event?.data || {};
  if (typeof data.displayText === 'string') return data.displayText;
  if (typeof data.summaryText === 'string') return data.summaryText;
  if (event?.kind === 'mind.failed') return data.status === 'interrupted'
    ? 'The previous wake was interrupted'
    : 'The provider was unavailable or the wake failed';
  if (event?.kind === 'mind.paused') return data.status === 'idle'
    ? 'The persistent mind was stopped'
    : 'The persistent mind was paused';
  if (event?.kind === 'mind.capability.request' && typeof data.capabilityId === 'string') {
    return `Capability request ${data.capabilityId}`;
  }
  if (typeof data.status === 'string') return data.status;
  return null;
};

export const safeMessageImages = (event) => (Array.isArray(event?.data?.images) ? event.data.images : [])
  .filter((image) => (
    typeof image?.attachmentId === 'string'
    && typeof image?.path === 'string'
    && image.path.startsWith('/api/screenshots/')
    && typeof image?.originalName === 'string'
  ))
  .slice(0, MAX_MESSAGE_IMAGES);

// The chat header's live turn readout distinguishes healthy inference from
// cold loads, stalled turns, and provider blocks without re-announcing every poll.
export const MindTurnIndicator = ({ progress }) => {
  if (progress.phase === 'idle') return null;
  const detail = [progress.stage, progress.detail].filter(Boolean).join(' · ');

  if (progress.phase === 'thinking') {
    // Stage only: it changes when the turn genuinely moves on, while the
    // elapsed/heartbeat text re-renders on every 10s poll and would otherwise
    // re-announce the same state endlessly.
    const typingLabel = progress.stage ? `Chief of Staff is typing — ${progress.stage}` : 'Chief of Staff is typing';
    return (
      <span
        data-testid="mind-typing-indicator"
        data-phase={progress.phase}
        role="status"
        aria-label={typingLabel}
        className="inline-flex min-w-0 items-center gap-1.5 text-port-text-muted"
      >
        <span className="inline-flex items-center gap-0.5 text-port-accent">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none"
              style={{ animationDelay: `${index * 120}ms` }}
            />
          ))}
        </span>
        {detail && <span aria-hidden="true" className="truncate text-[11px] font-normal">{detail}</span>}
      </span>
    );
  }

  const label = [mindTurnHeadline(progress, timeUntil), progress.phase === 'stalled' ? detail : null]
    .filter(Boolean).join(' · ');

  return (
    <span
      data-testid="mind-turn-indicator"
      data-phase={progress.phase}
      role="status"
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-port-warning/60 bg-port-warning/10 px-2 py-0.5 text-[11px] font-normal text-port-warning"
    >
      <AlertTriangle size={12} aria-hidden="true" className="shrink-0" />
      <span className="truncate" title={label}>{label}</span>
    </span>
  );
};

export function MindStateButton({ icon: Icon, label, value, detail, onClick }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="group rounded-2xl border border-port-border bg-port-card p-3 text-left transition-colors hover:border-port-accent/60 hover:bg-port-accent/5">
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-port-text-muted group-hover:text-port-accent">
        <Icon size={14} aria-hidden="true" /> {label}
      </span>
      <span className="mt-2 block text-sm font-semibold text-port-text">{value}</span>
      <span className="mt-0.5 block truncate text-xs text-port-text-muted">{detail}</span>
    </button>
  );
}

export function ConversationItem({ event, thoughts, thoughtOnly, selectedEventId, onSelect }) {
  const outgoing = event.kind === 'mind.message.accepted';
  const incoming = thoughtOnly || ['mind.reply', 'mind.summary'].includes(event.kind);
  const selected = event.eventId === selectedEventId;
  const content = thoughtOnly ? 'Thoughts from this turn' : eventText(event) || event.kind;

  if (!outgoing && !incoming) {
    return (
      <li className="flex justify-center px-2">
        <button
          type="button"
          onClick={() => onSelect(event.eventId)}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${eventLabel(event.kind)} · ${formatDateTime(event.at)}`}
          className={`max-w-[92%] rounded-full border border-port-border bg-port-bg/70 px-3 py-1.5 text-center text-xs text-port-text-muted transition-colors hover:bg-port-border/30 ${selected ? 'ring-2 ring-port-accent/70' : ''}`}
        >
          <span className="font-medium text-port-text">{eventLabel(event.kind)}</span>
          {eventText(event) && <><span aria-hidden="true"> · </span><span>{eventText(event)}</span></>}
        </button>
      </li>
    );
  }

  return (
    <li className={`flex flex-col ${outgoing ? 'items-end' : 'items-start'}`}>
      {!outgoing && <span className="mb-1 ml-2 text-[11px] font-medium text-port-text-muted">Chief of Staff</span>}
      <div className={`max-w-[86%] overflow-hidden ${outgoing ? 'rounded-[1.25rem] rounded-br-md bg-port-accent text-white' : 'rounded-[1.25rem] rounded-bl-md bg-port-border/55 text-port-text'} ${selected ? 'ring-2 ring-port-accent/80 ring-offset-2 ring-offset-port-card' : ''}`}>
        <button
          type="button"
          onClick={() => onSelect(event.eventId)}
          aria-current={selected ? 'true' : undefined}
          aria-label={`${eventLabel(event.kind)} · ${formatDateTime(event.at)}`}
          className="block w-full whitespace-pre-wrap break-words px-3.5 py-2.5 text-left text-[15px] leading-5"
        >
          {content}
        </button>
        <MessageImages images={safeMessageImages(event)} compact />
        {thoughts.length > 0 && (
          <details className={`border-t ${outgoing ? 'border-white/20' : 'border-port-text/10'}`}>
            <summary className="cursor-pointer px-3.5 py-2 text-xs font-medium opacity-75 hover:opacity-100">
              {thoughts.length} {thoughts.length === 1 ? 'thought' : 'thoughts'}
            </summary>
            <div className={`space-y-1.5 border-t px-2 py-2 ${outgoing ? 'border-white/20' : 'border-port-text/10'}`}>
              {thoughts.map((thought) => (
                <button
                  key={thought.eventId}
                  type="button"
                  onClick={() => onSelect(thought.eventId)}
                  aria-current={thought.eventId === selectedEventId ? 'true' : undefined}
                  aria-label={`${eventLabel(thought.kind)} · ${formatDateTime(thought.at)}`}
                  className={`block w-full rounded-xl px-2 py-1.5 text-left text-xs leading-5 opacity-75 hover:bg-black/10 hover:opacity-100 ${thought.eventId === selectedEventId ? 'ring-1 ring-current' : ''}`}
                >
                  {eventText(thought) || thought.kind}
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
      <time className={`mt-1 px-2 text-[10px] text-port-text-muted ${outgoing ? 'text-right' : 'text-left'}`} dateTime={event.at}>{formatDateTime(event.at)}</time>
    </li>
  );
}

export function MindImage({ image, className = '' }) {
  const [missing, setMissing] = useState(false);
  if (missing || !image?.path) {
    return <span role="img" aria-label={`${image?.originalName || 'Image'} is unavailable`} className={`flex items-center justify-center bg-port-bg p-1 text-center text-[10px] text-port-text-muted ${className}`}>Image unavailable</span>;
  }
  return <img src={image.path} alt={image.originalName || 'Attached image'} onError={() => setMissing(true)} className={className} />;
}

export function MessageImages({ images, compact = false }) {
  if (images.length === 0) return null;
  return (
    <ul aria-label={`${images.length} attached image${images.length === 1 ? '' : 's'}`} className={`flex flex-wrap gap-2 ${compact ? 'border-t border-white/20 px-3.5 py-2.5' : 'mt-3'}`}>
      {images.map((image) => (
        <li key={image.attachmentId} className={compact ? 'h-20 w-20 overflow-hidden rounded-lg bg-port-bg/20' : 'overflow-hidden rounded-lg border border-port-border bg-port-bg'}>
          <MindImage image={image} className={compact ? 'h-full w-full object-cover' : 'max-h-64 max-w-full object-contain'} />
          {!compact && <p className="border-t border-port-border px-2 py-1 text-xs text-port-text-muted">{image.originalName}</p>}
        </li>
      ))}
    </ul>
  );
}

export function ActionButton({ label, icon: Icon, pending = false, disabled = false, onClick }) {
  return (
    <button type="button" disabled={pending || disabled} onClick={onClick} className="flex min-h-[36px] items-center gap-2 rounded border border-port-border px-3 py-1.5 text-sm text-port-text hover:bg-port-border/30 disabled:cursor-not-allowed disabled:opacity-50">
      <Icon size={16} className={pending ? 'animate-spin' : ''} aria-hidden="true" /> {pending ? `${label}…` : label}
    </button>
  );
}
