import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

// Hover-revealed tooltip variant — wraps its trigger and renders the popover
// through a portal to <body> with fixed positioning, anchored below-right of
// the trigger. The portal escapes the horizontally-scrolling button row's
// `overflow` clipping and any ancestor stacking context (a plain
// `absolute`/`z-index` popover got clipped and painted under the nav). The
// `id` is exposed so the trigger can wire `aria-describedby` for screen readers.
export default function VerifyScopeTooltip({ scope, id, children }) {
  const anchorRef = useRef(null);
  const [pos, setPos] = useState(null);

  const show = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, []);
  const hide = useCallback(() => setPos(null), []);

  return (
    <div
      ref={anchorRef}
      className="relative"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos && createPortal(
        <div
          id={id}
          role="tooltip"
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="w-80 max-w-[calc(100vw-1rem)] bg-port-card border border-port-border rounded-lg shadow-lg p-3 z-[60] text-left normal-case tracking-normal pointer-events-none"
        >
          <p className="text-[10px] text-gray-300 font-medium mb-1 flex items-center gap-1">
            <Info size={10} /> What this checks
          </p>
          <p className="text-[10px] text-gray-400 italic mb-2">{scope.depth}</p>
          <ul className="list-disc pl-4 space-y-0.5 text-[10px] text-gray-400">
            {scope.checks.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </div>
  );
}
