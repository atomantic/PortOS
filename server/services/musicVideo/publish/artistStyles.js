/**
 * Music Video artist styles (#10345): one saved cover design per artist.
 *
 * A single's lettering is drafted per song, so a run of singles drifts apart
 * unless the artist's look is kept somewhere. "Save as artist style" stores
 * the current design here under the artist's name; "Apply artist style" copies
 * it onto another song, and the cover-design draft for a new song starts from
 * it. Kept in the server-side publishing settings
 * (`settings.musicVideoPublishing.artistStyles`, beside `platforms`), so every
 * browser that opens this install sees the same styles. A song's own tweaks
 * stay on the song; nothing here changes a cover until it is applied.
 */
import { normalizeCoverDesign } from '../../../lib/musicVideoCoverOverlay.js';
import { ServerError } from '../../../lib/errorHandler.js';
import { getSettings, updateSettingsWith } from '../../settings.js';
import { listCoverFonts } from '../coverFonts.js';

const SETTINGS_KEY = 'musicVideoPublishing';
const MAX_STYLES = 100;
export const MAX_ARTIST_NAME = 60;

const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_ARTIST_NAME) : '');
/** The key an artist's style is stored under: their name, case and spacing aside. */
export const artistStyleKey = (name) => cleanName(name).toLowerCase();

const styleRows = (section) => (section?.artistStyles && typeof section.artistStyles === 'object' && !Array.isArray(section.artistStyles) ? section.artistStyles : {});

const present = (key, row, fonts) => ({
  key,
  name: cleanName(row?.name) || key,
  design: normalizeCoverDesign(row?.design, { fonts }),
  updatedAt: typeof row?.updatedAt === 'string' ? row.updatedAt : null,
});

/** Every saved artist style, by name. */
export async function listArtistStyles() {
  const [settings, fonts] = await Promise.all([getSettings().catch(() => ({})), listCoverFonts()]);
  return Object.entries(styleRows(settings?.[SETTINGS_KEY]))
    .map(([key, row]) => present(key, row, fonts))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The saved style for an artist, or null. */
export async function artistStyleFor(name) {
  const key = artistStyleKey(name);
  return key ? (await listArtistStyles()).find((s) => s.key === key) || null : null;
}

/** Save (or replace) the style for `name`; resolves the saved style. */
export async function saveArtistStyle({ name, design }) {
  const key = artistStyleKey(name);
  if (!key) throw new ServerError('Name the artist to save a style for', { status: 422, code: 'VALIDATION_ERROR' });
  const fonts = await listCoverFonts();
  let saved = null;
  await updateSettingsWith((current) => {
    const section = current?.[SETTINGS_KEY] && typeof current[SETTINGS_KEY] === 'object' ? current[SETTINGS_KEY] : {};
    const styles = { ...styleRows(section) };
    if (!styles[key] && Object.keys(styles).length >= MAX_STYLES) {
      throw new ServerError(`Remove an artist style first: at most ${MAX_STYLES} can be saved`, { status: 409, code: 'ARTIST_STYLE_LIMIT' });
    }
    styles[key] = { name: cleanName(name), design: normalizeCoverDesign(design, { fonts }), updatedAt: new Date().toISOString() };
    saved = present(key, styles[key], fonts);
    return { ...current, [SETTINGS_KEY]: { ...section, artistStyles: styles } };
  });
  console.log(`🎨 Music Video artist style saved (${key})`);
  return saved;
}

/** Remove an artist's saved style. */
export async function removeArtistStyle(name) {
  const key = artistStyleKey(name);
  let found = false;
  await updateSettingsWith((current) => {
    const section = current?.[SETTINGS_KEY] && typeof current[SETTINGS_KEY] === 'object' ? current[SETTINGS_KEY] : {};
    const { [key]: gone, ...rest } = styleRows(section);
    found = Boolean(gone);
    return found ? { ...current, [SETTINGS_KEY]: { ...section, artistStyles: rest } } : current;
  });
  if (!found) throw new ServerError('No saved style for that artist', { status: 404, code: 'NOT_FOUND' });
}
