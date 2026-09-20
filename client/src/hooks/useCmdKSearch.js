import { useState, useEffect } from 'react';

export const CMD_K_SEARCH_OPEN_EVENT = 'portos:open-command-palette';

export function openCmdKSearch() {
  document.dispatchEvent(new Event(CMD_K_SEARCH_OPEN_EVENT));
}

export function useCmdKSearch() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.repeat) {
        e.preventDefault();
        setOpen(prev => !prev);
      }
    };
    const openHandler = () => setOpen(true);
    document.addEventListener('keydown', handler);
    document.addEventListener(CMD_K_SEARCH_OPEN_EVENT, openHandler);
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener(CMD_K_SEARCH_OPEN_EVENT, openHandler);
    };
  }, []);

  return { open, setOpen };
}
