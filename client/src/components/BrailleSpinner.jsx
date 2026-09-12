import { useState, useEffect } from 'react';
import usePrefersReducedMotion from '../hooks/usePrefersReducedMotion.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export default function BrailleSpinner({ text, className = '' }) {
  const [frame, setFrame] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  const accessibleLabel = text || 'Loading...';

  useEffect(() => {
    if (reducedMotion) {
      setFrame(0);
      return undefined;
    }
    const id = setInterval(() => setFrame(f => (f + 1) % FRAMES.length), INTERVAL_MS);
    return () => clearInterval(id);
  }, [reducedMotion]);

  return (
    <span
      className={`text-port-accent ${className}`}
      role="status"
      aria-live="polite"
      aria-label={accessibleLabel}
    >
      <span aria-hidden="true">{FRAMES[reducedMotion ? 0 : frame]}</span>
      {text ? ` ${text}` : <span className="sr-only">Loading...</span>}
    </span>
  );
}
