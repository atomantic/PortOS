/**
 * Drives both series-level default (`series.visualStyleDefault`) and per-stage
 * overrides (`issue.stages.<stageId>.visualStyleOverride`). Symmetric contract:
 *   value: { id, customPrompt } | null
 *   onChange(next | null)
 *
 * Menu is portalled to <body> with fixed positioning so it escapes
 * `overflow:auto` ancestors — z-index alone can't break out of an overflow clip.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Palette, X } from 'lucide-react';
import { listPipelineVisualStyles } from '../../services/apiPipeline';

const MENU_WIDTH = 320;
const MENU_MIN_WIDTH = 220;
const MENU_GAP = 4;
const VIEWPORT_PADDING = 8;

export default function VisualStylePicker({
  value,
  onChange,
  disabled = false,
  // Pass from per-stage callers; series-level callers leave undefined.
  inheritedLabel = null,
  // Compact shrinks the chip — used in stage headers where vertical space is tight.
  compact = false,
}) {
  const [styles, setStyles] = useState([]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuStyle, setMenuStyle] = useState(null);
  // Draft is only seeded when the menu opens — otherwise a parent re-render
  // that re-passes the same value reference would wipe in-progress typing.
  const [customDraft, setCustomDraft] = useState('');

  useEffect(() => {
    let cancelled = false;
    listPipelineVisualStyles()
      .then((res) => { if (!cancelled) setStyles(Array.isArray(res?.styles) ? res.styles : []); })
      .catch(() => { /* picker degrades to "no styles" rather than throwing */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(MENU_WIDTH, Math.max(MENU_MIN_WIDTH, viewportWidth - VIEWPORT_PADDING * 2));
    // Apply width imperatively before measuring height: on narrow viewports
    // the clamp differs from the JSX fallback, and React's batched commit
    // wouldn't reflect the right width by the time getBoundingClientRect runs.
    menu.style.width = `${width}px`;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    const maxLeft = viewportWidth - width - VIEWPORT_PADDING;
    const left = Math.min(
      Math.max(triggerRect.right - width, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, maxLeft),
    );

    const belowTop = triggerRect.bottom + MENU_GAP;
    const aboveTop = triggerRect.top - menuRect.height - MENU_GAP;
    const wouldOverflowBottom = belowTop + menuRect.height + VIEWPORT_PADDING > viewportHeight;
    const canFitAbove = aboveTop >= VIEWPORT_PADDING;
    let top = wouldOverflowBottom && canFitAbove ? aboveTop : belowTop;
    const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - menuRect.height - VIEWPORT_PADDING);
    top = Math.min(Math.max(top, VIEWPORT_PADDING), maxTop);

    setMenuStyle((prev) => {
      const next = { left: `${left}px`, top: `${top}px`, width: `${width}px` };
      if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width) return prev;
      return next;
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    setCustomDraft(value?.customPrompt || '');
    const onDoc = (e) => {
      const onTrigger = triggerRef.current?.contains(e.target);
      const onMenu = menuRef.current?.contains(e.target);
      if (!onTrigger && !onMenu) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    let rafId = null;
    const onReposition = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        updateMenuPosition();
      });
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
    // value?.customPrompt intentionally omitted — see comment on customDraft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, updateMenuPosition]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuStyle(null);
      return;
    }
    updateMenuPosition();
  }, [open, updateMenuPosition, styles.length]);

  const activeId = value?.id || null;
  const activeStyle = activeId ? styles.find((s) => s.id === activeId) : null;
  const hasValue = !!(value?.id || value?.customPrompt);

  const triggerLabel = hasValue
    ? (activeStyle?.name || 'Custom')
    : (inheritedLabel || 'Pick style');

  const choose = (id) => {
    onChange?.({ id, customPrompt: value?.customPrompt || null });
    setOpen(false);
  };

  const clear = () => {
    onChange?.(null);
    setOpen(false);
  };

  const applyCustom = () => {
    const trimmed = (customDraft || '').trim();
    if (!trimmed && !value?.id) {
      onChange?.(null);
    } else {
      onChange?.({ id: value?.id || null, customPrompt: trimmed || null });
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={`inline-flex items-center gap-1.5 rounded-md border bg-port-card text-xs disabled:opacity-50 disabled:cursor-not-allowed ${
          compact ? 'px-2 py-1' : 'px-2.5 py-1.5'
        } ${
          hasValue
            ? 'border-port-accent/50 text-white'
            : 'border-port-border text-gray-300 hover:text-white hover:border-port-accent/50'
        }`}
        title={hasValue
          ? `Visual style: ${triggerLabel}${value?.customPrompt ? ' (+ custom)' : ''}`
          : 'Pick a visual style preset for downstream image generation'}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Palette size={12} className="text-gray-500" />
        <span className="font-medium">{triggerLabel}</span>
        {value?.customPrompt && <span className="text-[10px] text-gray-500">+ custom</span>}
        <ChevronDown size={12} className="text-gray-500" />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed bg-port-card border border-port-border rounded-lg shadow-xl z-[100] p-1 overflow-y-auto"
          style={{
            left: menuStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: menuStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: menuStyle?.width ?? `${MENU_WIDTH}px`,
            maxHeight: `min(70vh, calc(100vh - ${VIEWPORT_PADDING * 2}px))`,
            visibility: menuStyle ? 'visible' : 'hidden',
          }}
        >
          {hasValue && (
            <button
              type="button"
              onClick={clear}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded text-xs text-gray-400 hover:bg-port-bg hover:text-white"
            >
              <X size={12} />
              <span>{inheritedLabel ? 'Reset to series default' : 'Clear style'}</span>
            </button>
          )}

          {styles.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-gray-500">Loading styles…</div>
          )}

          {styles.map((s) => {
            const active = activeId === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => choose(s.id)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs ${
                  active ? 'bg-port-accent/15 text-white' : 'text-gray-300 hover:bg-port-bg hover:text-white'
                }`}
              >
                <div className="font-medium">{s.name}</div>
                <div className="text-[10px] text-gray-500 mt-0.5">{s.description}</div>
              </button>
            );
          })}

          <div className="mt-1 pt-1 px-2 py-1.5 border-t border-port-border">
            <div className="text-[10px] text-gray-500 mb-1">
              Custom additions (appended to the preset fragment)
            </div>
            <textarea
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              placeholder="e.g. heavier ink weight, muted earth palette"
              rows={2}
              className="block w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs resize-y"
            />
            <button
              type="button"
              onClick={applyCustom}
              className="mt-1.5 w-full px-2 py-1 rounded bg-port-accent text-white text-xs font-medium hover:bg-port-accent/90"
            >
              Apply custom additions
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
