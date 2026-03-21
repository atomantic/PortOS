import { useState, useEffect } from 'react';

export function useKeyboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      // Don't trigger when typing in inputs/textareas/contenteditable
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
      // Don't trigger with modifier keys
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === '?' && !e.repeat) {
        e.preventDefault();
        setOpen(prev => !prev);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  return { open, setOpen };
}
