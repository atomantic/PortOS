import { useSyncExternalStore } from 'react';
import { Film } from 'lucide-react';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';

// A viewer preference shared by the live composition and storyboard previews.
export const PREVIEW_FILM_LOOK_KEY = 'portos-mv-preview-film-look';

const subscribers = new Set();
// When storage is blocked, retain the choice in memory across preview mounts.
let unsavedChoice = null;
const snapshot = () => unsavedChoice ?? (safeReadStorage(PREVIEW_FILM_LOOK_KEY) === 'on');
const serverSnapshot = () => false;
const notify = () => { for (const subscriber of subscribers) subscriber(); };
const onStorage = (event) => {
  if (event.key !== PREVIEW_FILM_LOOK_KEY && event.key !== null) return;
  unsavedChoice = null;
  notify();
};
const subscribe = (subscriber) => {
  subscribers.add(subscriber);
  if (subscribers.size === 1 && typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(subscriber);
    if (!subscribers.size && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
};
const toggle = () => {
  const next = !snapshot();
  const value = next ? 'on' : 'off';
  safeWriteStorage(PREVIEW_FILM_LOOK_KEY, value);
  unsavedChoice = safeReadStorage(PREVIEW_FILM_LOOK_KEY) === value ? null : next;
  notify();
};

export function usePreviewFilmLook() {
  return [useSyncExternalStore(subscribe, snapshot, serverSnapshot), toggle];
}

export default function PreviewFilmLook({ enabled, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      title={enabled ? 'Film look enabled for this preview' : 'Film look hidden in this preview; the render still applies it'}
      className={`flex min-h-[44px] shrink-0 items-center gap-1 rounded border px-2 text-xs pointer-fine:sm:min-h-0 sm:py-1 ${enabled ? 'border-port-accent text-port-accent' : 'border-port-border text-port-text-muted'}`}
    >
      <Film size={14} aria-hidden="true" /> Film look
    </button>
  );
}
