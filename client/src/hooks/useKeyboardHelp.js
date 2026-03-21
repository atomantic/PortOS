import { useState, useEffect } from 'react';

export function useKeyboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      // Escape always closes, even from inputs/textareas
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }

      // Don't trigger shortcuts when typing in inputs/textareas/contenteditable
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      // Don't trigger with modifier keys
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '?' && !e.repeat) {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return { open, setOpen };
}
