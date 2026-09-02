import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, ChevronDown, Loader2, Package, Play } from 'lucide-react';
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
export default function RunTaskButton({ taskType, apps, onTrigger, installWide = false, disabledReason = '' }) {
  const [open, setOpen] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [lastRequest, setLastRequest] = useState('');
  const ref = useRef(null);
  const triggerSeqRef = useRef(0);
  const triggerInFlightRef = useRef(false);
  const activeApps = apps?.filter(app => !app.archived) || [];
  const disabled = !!disabledReason || triggering;

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

  // The drawer reuses this component when the selected task changes. Do not
  // carry the previous task's receipt across that prop swap, and ignore any
  // stale response that settles after the swap.
  useEffect(() => {
    triggerSeqRef.current += 1;
    triggerInFlightRef.current = false;
    setTriggering(false);
    setLastRequest('');
  }, [taskType]);

  const triggerTask = (app = null) => {
    if (disabledReason || triggerInFlightRef.current) return;
    triggerInFlightRef.current = true;
    const requestSeq = ++triggerSeqRef.current;
    setTriggering(true);
    setLastRequest('');

    const settle = (result) => {
      if (requestSeq !== triggerSeqRef.current) return;
      triggerInFlightRef.current = false;
      setTriggering(false);
      if (!result) return;
      setLastRequest(app?.name
        ? `Request sent to ${app.name}`
        : installWide ? 'Request sent for all apps' : 'Request sent');
    };

    // ScheduleTab owns error feedback and always resolves to null on failure.
    // Keep synchronous test/embedding callbacks synchronous too; forcing an
    // `await` around a non-Promise schedules an unnecessary follow-up render.
    const result = app ? onTrigger(taskType, app.id) : onTrigger(taskType);
    if (result && typeof result.then === 'function') result.then(settle, () => settle(null));
    else settle(result);
  };

  const requestStatus = (
    <span
      role="status"
      title={lastRequest || undefined}
      className={lastRequest
        ? 'mt-1 flex min-w-0 max-w-48 items-center gap-1 text-[11px] text-port-success'
        : 'sr-only'}
    >
      {lastRequest && <CheckCircle2 size={12} className="shrink-0" />}
      <span className={lastRequest ? 'min-w-0 flex-1 truncate' : ''}>{triggering ? 'Sending request' : lastRequest}</span>
    </span>
  );

  // An install-wide task sweeps every managed app in ONE dispatch, so its real
  // run is the app-less one. Without this the picker would be the only way to
  // start it on any install that has apps, and every click would send an appId —
  // silently reducing an install-wide sweep to a single repo.
  if (activeApps.length === 0 || installWide) {
    return (
      <span className="inline-flex min-w-0 flex-col items-start">
        <span
          title={triggering ? 'Sending run request' : disabledReason || (installWide
            ? 'Run this task across every managed app in one sweep'
            : 'Run this task immediately (bypasses schedule)')}
          className="inline-block"
        >
          <button
            type="button"
            onClick={() => !disabled && triggerTask()}
            disabled={disabled}
            aria-disabled={disabled || undefined}
            aria-busy={triggering || undefined}
            className={triggerButtonClass(disabled)}
          >
            {triggering ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {triggering ? 'Sending…' : installWide ? 'Run on All Apps' : 'Run Now'}
          </button>
        </span>
        {requestStatus}
      </span>
    );
  }

  return (
    <div ref={ref} className="min-w-0">
      {/* Tooltip on the wrapper, not the button: most browsers skip hover events on disabled controls. */}
      <span title={triggering ? 'Sending run request' : disabledReason || 'Run this task on a specific app'} className="inline-block">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => !disabled && setOpen(o => !o)}
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-busy={triggering || undefined}
          aria-expanded={open}
          className={triggerButtonClass(disabled)}
        >
          {triggering ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {triggering ? 'Sending…' : 'Run on App'}
          {!triggering && <ChevronDown size={12} className={`transition-transform ${open ? 'rotate-180' : ''}`} />}
        </button>
      </span>
      {requestStatus}
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
                onClick={() => { setOpen(false); triggerTask(app); }}
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
