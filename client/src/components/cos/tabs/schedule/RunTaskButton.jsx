import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Play, ChevronDown, Package } from 'lucide-react';
import { triggerButtonClass } from './scheduleConstants';
import useClickOutside from '../../../../hooks/useClickOutside.js';
import usePopoverPosition, { VIEWPORT_PADDING } from '../../../../hooks/usePopoverPosition.js';

const MENU_WIDTH = 256; // w-64

// Trigger an on-demand run. When the task targets managed apps, opens a picker
// so the run carries app context; otherwise fires a plain global run. Shared by
// the schedule card and the drawer's global-config controls so both stay in sync.
//
// `disabledReason` is the one gate: a non-empty string disables the button and
// becomes its tooltip (improvement switched off, a pin still being saved, …).
// A named boolean per reason would mean every new reason edits this component,
// and — as the pin-saving gate showed — reaching only whichever call site the
// author had in mind.
export default function RunTaskButton({ taskType, apps, onTrigger, disabledReason = '' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const activeApps = apps?.filter(app => !app.archived) || [];
  const disabled = !!disabledReason;

  // The app list is portaled to <body> and placed in viewport coordinates. This
  // button sits mid-row on a task card, so the old `absolute bottom-full left-0`
  // panel ran off the right edge on a phone — `max-w` only narrowed it, it never
  // moved it back on-screen. The hook clamps into the viewport and flips below
  // the trigger when there is no room above. The rendered app count changes the
  // panel height, so it re-measures via contentDeps.
  const { triggerRef, popoverRef, style: menuStyle } = usePopoverPosition({
    open: open && !disabled,
    width: MENU_WIDTH,
    minWidth: 200,
    position: 'above',
    contentDeps: [activeApps.length]
  });

  // Both refs: the panel lives outside the trigger's subtree once portaled, so a
  // trigger-only containment check would read clicks on the panel as outside.
  useClickOutside([ref, popoverRef], open, () => setOpen(false));

  // Without this, an open dropdown survives a flip to disabled and pops back open when re-enabled.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (activeApps.length === 0) {
    return (
      <span title={disabledReason || 'Run this task immediately (bypasses schedule)'} className="inline-block">
        <button
          type="button"
          onClick={() => !disabled && onTrigger(taskType)}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          className={triggerButtonClass(disabled)}
        >
          <Play size={14} />
          Run Now
        </button>
      </span>
    );
  }

  return (
    <div ref={ref}>
      {/* Tooltip on the wrapper, not the button: most browsers skip hover events on disabled controls. */}
      <span title={disabledReason || 'Run this task on a specific app'} className="inline-block">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => !disabled && setOpen(o => !o)}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-expanded={open}
          className={triggerButtonClass(disabled)}
        >
          <Play size={14} />
          Run on App
          <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </span>
      {open && !disabled && createPortal(
        <div
          ref={popoverRef}
          className="port-menu-surface fixed z-[100] max-h-64 overflow-y-auto border border-port-border rounded-lg shadow-lg"
          style={{
            left: menuStyle?.left ?? `${VIEWPORT_PADDING}px`,
            top: menuStyle?.top ?? `${VIEWPORT_PADDING}px`,
            width: menuStyle?.width ?? `${MENU_WIDTH}px`,
            visibility: menuStyle ? 'visible' : 'hidden'
          }}
        >
          <div className="p-2 border-b border-port-border">
            <span className="text-xs text-gray-400">Select an app to run {taskType} on:</span>
          </div>
          <div className="py-1">
            {activeApps.map(app => (
              <button
                key={app.id}
                type="button"
                onClick={() => { onTrigger(taskType, app.id); setOpen(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-port-border/50 flex items-center gap-2 min-h-[40px]"
              >
                <Package size={14} className="text-gray-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-white truncate">{app.name}</div>
                  {app.repoPath && <div className="text-xs text-gray-500 truncate">{app.repoPath}</div>}
                </div>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
