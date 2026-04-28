export const HIDDEN_KEY = 'portos.voice.hidden';
export const VISIBILITY_EVENT = 'portos:voice:visibility';
export const ENGAGE_EVENT = 'portos:voice:engage';
export const DISENGAGE_EVENT = 'portos:voice:disengage';

// Sentinel '0' = explicitly engaged. Anything else (including key absent)
// means hidden — keeps legacy users hidden by default after the flip.
export const readVoiceHidden = () => {
  if (typeof window === 'undefined') return true;
  return window.localStorage.getItem(HIDDEN_KEY) !== '0';
};

export const writeVoiceHidden = (hidden) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(HIDDEN_KEY, hidden ? '1' : '0');
  window.dispatchEvent(new Event(VISIBILITY_EVENT));
};

// Storage events fire for every localStorage write in any tab; gate to our key
// (or null = clear) so unrelated writes don't churn voice components.
export const isVoiceHiddenStorageEvent = (event) =>
  !event || event.key === HIDDEN_KEY || event.key === null;
