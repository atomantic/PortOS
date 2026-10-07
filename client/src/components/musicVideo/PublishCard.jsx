import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage.js';

const STORAGE_KEY = 'portos.musicVideo.publishCards';

/** Open/closed choices the director made on this device, per project and card. */
function rememberedOpen(projectId, cardId) {
  const saved = safeReadJsonStorage(STORAGE_KEY, {}) || {};
  const value = saved[projectId]?.[cardId];
  return typeof value === 'boolean' ? value : null;
}

function rememberOpen(projectId, cardId, open) {
  const saved = safeReadJsonStorage(STORAGE_KEY, {}) || {};
  safeWriteJsonStorage(STORAGE_KEY, { ...saved, [projectId]: { ...(saved[projectId] || {}), [cardId]: open } });
}

/**
 * One card on the Publish page that folds to its header, so the director can
 * get past the finished ones to the step they need. `defaultOpen` is the
 * card's own sense of whether it still needs attention; a toggle is
 * remembered on this device per project. `summary` shows beside a folded
 * title (e.g. "7 of 9 done"). `actions` (a button, say) sit beside the title,
 * outside the fold toggle.
 */
export default function PublishCard({ projectId, cardId, label, icon: Icon, summary = '', defaultOpen = true, actions = null, className = '', children }) {
  const [open, setOpen] = useState(() => rememberedOpen(projectId, cardId) ?? defaultOpen);
  const bodyId = `mv-publish-card-${cardId}`;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (projectId) rememberOpen(projectId, cardId, next);
  };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={label} className={`rounded-lg border border-port-border bg-port-card p-3 space-y-2 text-xs ${className}`.trim()}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium min-w-0 flex-1">
          <button type="button" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggle}
            className="flex w-full items-center gap-1.5 min-h-[44px] sm:min-h-0">
            <Chevron size={14} className="shrink-0" />
            {Icon && <Icon size={14} className="shrink-0" />}
            <span className="shrink-0">{label}</span>
            {summary && <span className="min-w-0 truncate text-xs font-normal text-port-text-muted">{summary}</span>}
          </button>
        </h3>
        {actions}
      </div>
      {open && <div id={bodyId} className="space-y-2">{children}</div>}
    </section>
  );
}
