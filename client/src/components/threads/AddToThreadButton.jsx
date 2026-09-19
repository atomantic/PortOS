/**
 * AddToThreadButton — attach any PortOS record or external item to a Brain thread (#7664).
 *
 * A Brain *thread* is a tracked topic or commitment (an open loop in the bullet
 * journal sense), NOT a message thread (`messages/` owns that other sense of
 * the word).
 *
 * Renders a compact button opening an EntityCombobox over open threads with
 * match-or-create, POSTing `/api/brain/threads/attach`.
 */

import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ListTodo, X } from 'lucide-react';
import * as api from '../../services/api';
import toast from '../ui/Toast';
import EntityCombobox from '../EntityCombobox';
import useClickOutside from '../../hooks/useClickOutside';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../hooks/usePopoverPosition';
import { THREAD_ACTIVE_STATUSES } from '../../lib/brainThreads';

export default function AddToThreadButton({
  refItem,
  threadRef,
  kind,
  id,
  label,
  title,
  buttonText,
  className = '',
  disabled = false,
  size = 'md',
  onAttached,
  ariaLabel,
  tooltip
}) {
  const [open, setOpen] = useState(false);
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [query, setQuery] = useState('');

  const computedRef = useMemo(() => {
    const base = refItem || threadRef;
    const k = base?.kind || kind;
    const i = base?.id || id;
    const l = base?.label || label || title;
    if (!k || !i) return null;
    return {
      kind: k,
      id: String(i),
      ...(l ? { label: String(l).slice(0, 300) } : {})
    };
  }, [refItem, threadRef, kind, id, label, title]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    api.listThreads({ status: THREAD_ACTIVE_STATUSES.join(',') }, { silent: true })
      .then((res) => {
        if (!active) return;
        const list = Array.isArray(res?.threads) ? res.threads : Array.isArray(res) ? res : [];
        setThreads(list);
      })
      .catch(() => {
        if (active) setThreads([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [open]);

  const comboboxItems = useMemo(() => {
    return threads.map((t) => ({
      id: t.id,
      name: t.title || '(untitled)',
      subtitle: t.nextAction || (t.status !== 'open' ? t.status : undefined)
    }));
  }, [threads]);

  const { triggerRef, popoverRef, style: menuStyle } = usePopoverPosition({
    open,
    width: 320,
    minWidth: 260,
    position: 'below',
    contentDeps: [comboboxItems.length, loading, attaching]
  });

  useClickOutside([triggerRef, popoverRef], open, () => setOpen(false));

  const handlePick = async (item) => {
    if (!computedRef || attaching) return;
    setAttaching(true);
    try {
      const res = await api.attachToThread({ threadId: item.id, ref: computedRef });
      toast.success(`Attached to thread "${res?.thread?.title || item.name}"`);
      onAttached?.(res);
      setOpen(false);
      setQuery('');
    } catch (err) {
      toast.error(err?.message || 'Failed to attach to thread');
    } finally {
      setAttaching(false);
    }
  };

  const handleCreate = async () => {
    const trimmed = query.trim();
    if (!trimmed || !computedRef || attaching) return;
    setAttaching(true);
    try {
      const res = await api.attachToThread({ title: trimmed, ref: computedRef });
      toast.success(`Created thread "${res?.thread?.title || trimmed}"`);
      onAttached?.(res);
      setOpen(false);
      setQuery('');
    } catch (err) {
      toast.error(err?.message || 'Failed to create thread');
    } finally {
      setAttaching(false);
    }
  };

  const accessibleName = ariaLabel || (buttonText ? undefined : 'Add to Brain thread');
  const titleText = tooltip || (accessibleName || 'Add to Brain thread');
  const isDisabled = disabled || !computedRef;

  const defaultClasses = buttonText
    ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-port-border bg-port-bg text-gray-300 hover:text-white hover:border-port-accent/40 transition-colors disabled:opacity-50'
    : 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded-lg border border-port-border bg-port-bg text-gray-400 hover:text-port-accent hover:border-port-accent/40 transition-colors disabled:opacity-50';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={isDisabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={accessibleName}
        title={titleText}
        className={className || defaultClasses}
      >
        <ListTodo size={size === 'sm' ? 12 : 14} className="shrink-0" />
        {buttonText && <span>{buttonText}</span>}
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Add to Brain thread"
          style={{
            position: 'fixed',
            left: menuStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: menuStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: menuStyle?.width ?? '320px',
            visibility: menuStyle ? 'visible' : 'hidden',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="z-50 bg-port-card border border-port-border rounded-lg shadow-xl p-3 space-y-2 text-white"
        >
          <div className="flex items-center justify-between gap-2 pb-1 border-b border-port-border">
            <div className="flex items-center gap-1.5 text-xs font-medium text-white">
              <ListTodo size={14} className="text-port-accent shrink-0" />
              <span>Add to Brain thread</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-400 hover:text-white p-1 rounded transition-colors"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </div>

          {computedRef?.label && (
            <div className="text-[11px] text-gray-400 truncate">
              Attaching: <span className="text-gray-200 font-medium">{computedRef.label}</span>
            </div>
          )}

          <label htmlFor="add-to-thread-search" className="sr-only">Search threads</label>
          <EntityCombobox
            items={comboboxItems}
            value={query}
            onChange={setQuery}
            onPick={handlePick}
            onCreate={handleCreate}
            busy={loading || attaching}
            inputId="add-to-thread-search"
            noun="thread"
            placeholder="Search open threads or type name…"
            createPrefix="New thread"
            emptyNoItems="No open threads yet — type a name to create one."
            className="w-full"
          />
        </div>,
        document.body
      )}
    </>
  );
}
