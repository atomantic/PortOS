// Per-install state for the built-in Music Video character styles
// (server/lib/musicVideoCharacterStyles.js): which gallery image is each
// style's character sheet on this install. Stored in settings because gallery
// images are local to an install and the catalog itself is static code.

import { getSettings, updateSettingsWith } from '../settings.js';
import {
  MUSIC_VIDEO_CHARACTER_STYLES, getMusicVideoCharacterStyle, musicVideoCharacterSheetPrompt,
  summarizeMusicVideoCharacterStyle,
} from '../../lib/musicVideoCharacterStyles.js';

const SETTINGS_KEY = 'musicVideoCharacterStyles';

export async function getCharacterStyleReferenceImage(id) {
  const settings = await getSettings();
  return settings?.[SETTINGS_KEY]?.[id]?.referenceImageId || null;
}

export async function listCharacterStyles() {
  const stored = (await getSettings())?.[SETTINGS_KEY] || {};
  return MUSIC_VIDEO_CHARACTER_STYLES.map((style) => ({
    ...summarizeMusicVideoCharacterStyle(style),
    sheetPrompt: musicVideoCharacterSheetPrompt(style),
    referenceImageId: stored[style.id]?.referenceImageId || null,
  }));
}

export async function getCharacterStyleDetail(id) {
  const style = getMusicVideoCharacterStyle(id);
  if (!style) return null;
  return { ...style, sheetPrompt: musicVideoCharacterSheetPrompt(style), referenceImageId: await getCharacterStyleReferenceImage(id) };
}

/** Sets (or clears, with null) the install's character sheet for a style. */
export async function setCharacterStyleReferenceImage(id, imageId) {
  await updateSettingsWith((current) => {
    const all = { ...(current[SETTINGS_KEY] || {}) };
    if (imageId) all[id] = { ...(all[id] || {}), referenceImageId: imageId };
    else delete all[id];
    return { ...current, [SETTINGS_KEY]: all };
  });
  return getCharacterStyleDetail(id);
}
