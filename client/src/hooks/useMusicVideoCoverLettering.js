import { useCallback, useEffect, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  deleteMusicVideoArtistStyle,
  deleteMusicVideoCoverFont,
  getMusicVideoArtistStyles,
  getMusicVideoCoverFonts,
  saveMusicVideoArtistStyle,
  uploadMusicVideoCoverFont,
} from '../services/apiMusicVideo.js';

/**
 * What the cover Lettering controls draw on besides the song itself (#10345):
 * the typefaces the director uploaded and the saved style per artist. Both are
 * install-wide server records, loaded whenever `enabled` (the Lettering
 * section is open); each mutation applies the server's answer at
 * once. `fonts` / `styles` are null until loaded. Failures toast through the
 * shared request layer and leave the lists as they were.
 */
export default function useMusicVideoCoverLettering({ enabled = true } = {}) {
  const [fonts, setFonts] = useState(null);
  const [styles, setStyles] = useState(null);
  const [uploading, setUploading] = useState(false);

  // Loaded each time the section opens (the lists are small), so a font or style saved on another device shows up.
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    getMusicVideoCoverFonts({ silent: true }).then((res) => { if (active) setFonts(res?.fonts || []); }).catch(() => { if (active) setFonts((prev) => prev || []); });
    getMusicVideoArtistStyles({ silent: true }).then((res) => { if (active) setStyles(res?.styles || []); }).catch(() => { if (active) setStyles((prev) => prev || []); });
    return () => { active = false; };
  }, [enabled]);

  const uploadFont = useCallback(async (file) => {
    setUploading(true);
    const res = await uploadMusicVideoCoverFont(file).catch(() => null);
    setUploading(false);
    if (!res) return null;
    setFonts(res.fonts || []);
    toast.success(`Added the font ${res.font?.family || ''}`.trim());
    return res.font;
  }, []);

  const removeFont = useCallback(async (id) => {
    const res = await deleteMusicVideoCoverFont(id).catch(() => null);
    if (res) setFonts(res.fonts || []);
    return Boolean(res);
  }, []);

  const saveStyle = useCallback(async ({ name, design }) => {
    const res = await saveMusicVideoArtistStyle({ name, design }).catch(() => null);
    if (!res?.style) return null;
    setStyles((prev) => [...(prev || []).filter((s) => s.key !== res.style.key), res.style].sort((a, b) => a.name.localeCompare(b.name)));
    toast.success(`Saved the style for ${res.style.name}`);
    return res.style;
  }, []);

  const removeStyle = useCallback(async (name) => {
    const res = await deleteMusicVideoArtistStyle(name).catch(() => null);
    if (res) setStyles((prev) => (prev || []).filter((s) => s.name !== name));
    return Boolean(res);
  }, []);

  return { fonts, styles, uploading, uploadFont, removeFont, saveStyle, removeStyle };
}
