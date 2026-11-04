import { useCallback, useEffect, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  deleteMusicVideoArtistStyle,
  deleteMusicVideoCoverFont,
  getMusicVideoArtistStyles,
  getMusicVideoCoverFonts,
  saveMusicVideoArtistStyle,
  uploadMusicVideoCoverFont,
} from '../services/apiMusicVideo.js';

const loadFonts = () => getMusicVideoCoverFonts({ silent: true }).then((res) => res?.fonts || []);
const loadStyles = () => getMusicVideoArtistStyles({ silent: true }).then((res) => res?.styles || []);

// A mutation supersedes any read already in flight. Keep the last list while
// refreshing so a mutation that finishes during a reopen can update it safely.
function useLetteringList(fetcher, enabled) {
  const [resource, setResource] = useState({ items: null, state: 'loading', error: null });
  const generation = useRef(0);
  const pending = useRef(false);
  const read = useCallback(() => {
    const current = ++generation.current;
    pending.current = true;
    setResource((previous) => ({ ...previous, state: 'loading', error: null }));
    return fetcher().then((items) => {
      if (generation.current === current) {
        pending.current = false;
        setResource({ items, state: 'ready', error: null });
      }
    }).catch((error) => {
      if (generation.current === current) {
        pending.current = false;
        setResource((previous) => ({ ...previous, state: 'error', error }));
      }
    });
  }, [fetcher]);

  useEffect(() => {
    if (!enabled) return undefined;
    read();
    return () => { generation.current += 1; pending.current = false; };
  }, [enabled, read]);

  const update = useCallback((updater) => {
    const reconcile = pending.current;
    generation.current += 1;
    pending.current = false;
    setResource((previous) => ({
      items: typeof updater === 'function' ? updater(previous.items || []) : updater,
      state: 'ready',
      error: null,
    }));
    // A discarded refresh may also contain changes made in another session.
    if (reconcile) read();
  }, [read]);
  return { ...resource, read, update };
}

/**
 * What the cover Lettering controls draw on besides the song itself (#10345):
 * the typefaces the director uploaded and the saved style per artist. Both are
 * install-wide server records, loaded whenever `enabled` (the Lettering
 * section is open); each mutation applies the server's answer at
 * once. Each list exposes loading and retryable error states separately from
 * a genuinely empty list.
 */
export default function useMusicVideoCoverLettering({ enabled = true } = {}) {
  const fonts = useLetteringList(loadFonts, enabled);
  const styles = useLetteringList(loadStyles, enabled);
  const [uploading, setUploading] = useState(false);

  const uploadFont = useCallback(async (file) => {
    setUploading(true);
    const res = await uploadMusicVideoCoverFont(file).catch(() => null);
    setUploading(false);
    if (!res) return null;
    fonts.update(res.fonts || []);
    toast.success(`Added the font ${res.font?.family || ''}`.trim());
    return res.font;
  }, [fonts.update]);

  const removeFont = useCallback(async (id) => {
    const res = await deleteMusicVideoCoverFont(id).catch(() => null);
    if (res) fonts.update(res.fonts || []);
    return Boolean(res);
  }, [fonts.update]);

  const saveStyle = useCallback(async ({ name, design }) => {
    const res = await saveMusicVideoArtistStyle({ name, design }).catch(() => null);
    if (!res?.style) return null;
    styles.update((prev) => [...prev.filter((s) => s.key !== res.style.key), res.style].sort((a, b) => a.name.localeCompare(b.name)));
    toast.success(`Saved the style for ${res.style.name}`);
    return res.style;
  }, [styles.update]);

  const removeStyle = useCallback(async (name) => {
    const res = await deleteMusicVideoArtistStyle(name).catch(() => null);
    if (res) styles.update((prev) => prev.filter((s) => s.name !== name));
    return Boolean(res);
  }, [styles.update]);

  return {
    fonts: fonts.items, fontState: fonts.state, fontError: fonts.error, retryFonts: fonts.read,
    styles: styles.items, styleState: styles.state, styleError: styles.error, retryStyles: styles.read,
    uploading, uploadFont, removeFont, saveStyle, removeStyle,
  };
}
