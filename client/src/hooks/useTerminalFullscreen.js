import { useEffect, useRef } from 'react';
import useFocusTrap from './useFocusTrap.js';

// Modal behavior for the Shell / iTerm fullscreen overlay: focus moves in and
// is trapped while `isFullscreen`, Escape exits, and focus returns to the
// fullscreen toggle on exit. The toggle is unmounted while fullscreen (the
// header is hidden), so useFocusTrap's own restore hits a detached node —
// `toggleRef` is re-attached on exit and focused here instead.
//
// Escape typed INSIDE the terminal is left alone: xterm forwards it to the
// program (vim, TUIs), and exiting fullscreen on every such keypress would
// break them. Shift+Tab leaves the terminal, after which Escape exits.
export default function useTerminalFullscreen(isFullscreen, exitFullscreen) {
  const containerRef = useRef(null);
  const toggleRef = useRef(null);
  const wasFullscreen = useRef(false);

  useFocusTrap(isFullscreen, containerRef);
  const exitRef = useRef(exitFullscreen);
  exitRef.current = exitFullscreen;
  // Own listener rather than useEscapeKey: that hook drops the event, and the
  // target decides whether this Escape is ours.
  useEffect(() => {
    if (!isFullscreen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.target?.closest?.('.xterm, [data-testid="iterm-terminal"]')) return;
      exitRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  useEffect(() => {
    if (wasFullscreen.current && !isFullscreen) toggleRef.current?.focus();
    wasFullscreen.current = isFullscreen;
  }, [isFullscreen]);

  return { containerRef, toggleRef };
}
