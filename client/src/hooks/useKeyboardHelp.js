/**
 * Esc closes, even from inputs/textareas.
 *
 * Use when: Help/cheatsheet modals.
 */

import { useState, useEffect } from 'react';

export function useKeyboardHelp(disabled = false) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (disabled) return undefined;
    const handler = (e) => {
      // Escape always closes, even from inputs/textareas
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }

      // ? toggle — check key before modifiers so AltGr layouts (ctrlKey+altKey) still work
      if (e.key === '?' && !e.repeat) {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [disabled]);

  return { open, setOpen };
}
