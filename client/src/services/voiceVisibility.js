/**
 * Voice UI state manager.
 */

import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';

const HIDDEN_KEY = 'portos.voice.hidden';
const VISUAL_MODE_KEY = 'portos.voice.visualMode';
export const VISIBILITY_EVENT = 'portos:voice:visibility';
export const VISUAL_MODE_EVENT = 'portos:voice:visualMode';
export const ENGAGE_EVENT = 'portos:voice:engage';
export const DISENGAGE_EVENT = 'portos:voice:disengage';

// Sentinel '0' = explicitly engaged. Anything else (including key absent)
// means hidden — keeps legacy users hidden by default after the flip.
export const readVoiceHidden = () => safeReadStorage(HIDDEN_KEY) !== '0';

export const writeVoiceHidden = (hidden) => {
  safeWriteStorage(HIDDEN_KEY, hidden ? '1' : '0');
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(VISIBILITY_EVENT));
};

// Storage events fire for every localStorage write in any tab; gate to our key
// (or null = clear) so unrelated writes don't churn voice components.
export const isVoiceHiddenStorageEvent = (event) =>
  !event || event.key === HIDDEN_KEY || event.key === null;

// Sentinel 'compact' = user explicitly hid the full transceiver handset and
// prefers the compact voice bar. Default (absent or 'full') starts in full
// visual sat-phone mode whenever voice mode is launched.
export const readVoiceVisualMode = () => (safeReadStorage(VISUAL_MODE_KEY) === 'compact' ? 'compact' : 'full');

export const writeVoiceVisualMode = (mode) => {
  const next = mode === 'compact' ? 'compact' : 'full';
  safeWriteStorage(VISUAL_MODE_KEY, next);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(VISUAL_MODE_EVENT));
};

export const isVoiceVisualModeStorageEvent = (event) =>
  !event || event.key === VISUAL_MODE_KEY || event.key === null;
