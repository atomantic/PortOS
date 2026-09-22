import { useEffect, useRef } from 'react';
import usePrefersReducedMotion from '../../hooks/usePrefersReducedMotion';

/** Keep the row mounted until its successful deletion has collapsed its space.
 * Put row spacing INSIDE this wrapper (paddingBottom), never on the parent gap.
 */
export default function CollapsibleListItem({ removing, onExited, children, spacing = '0.5rem' }) {
  const elementRef = useRef(null);
  const exitRef = useRef(onExited);
  exitRef.current = onExited;
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (!removing) return undefined;
    const element = elementRef.current;
    if (element.contains(document.activeElement)) {
      const siblings = [...element.parentElement.children];
      const destination = siblings.slice(siblings.indexOf(element) + 1).find(sibling => !sibling.inert)
        || siblings.reverse().find(sibling => sibling !== element && !sibling.inert)
        || element.parentElement.closest('[tabindex]');
      destination?.focus({ preventScroll: true });
    }
    // A timer is also the fallback when transitions don't fire (hidden tabs).
    const timer = setTimeout(() => exitRef.current(), reducedMotion ? 0 : 200);
    return () => clearTimeout(timer);
  }, [removing, reducedMotion]);

  return (
    <div ref={elementRef} tabIndex={-1} inert={removing || undefined}
      className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
      style={{ gridTemplateRows: removing ? '0fr' : '1fr', opacity: removing ? 0 : 1 }}>
      <div className="min-h-0 overflow-hidden">
        <div style={{ paddingBottom: spacing }}>{children}</div>
      </div>
    </div>
  );
}
