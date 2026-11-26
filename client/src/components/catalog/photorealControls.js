import { useState } from 'react';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage';

const clampInt = (value, min, max) => Math.min(max, Math.max(min, Math.round(Number(value) || min)));

// Raw text while a number field is focused so partial input ("1" on the way to
// "15") isn't clamped; the clamped value is committed on blur and used by render.
export function useDraftNumber({ committed, min, max, onCommit }) {
  const [draft, setDraft] = useState(null);
  const effective = draft === null ? committed : clampInt(draft, min, max);
  return {
    effective,
    inputProps: {
      value: draft ?? committed,
      onChange: (event) => setDraft(event.target.value),
      onBlur: () => {
        if (draft === null) return;
        setDraft(null);
        onCommit(effective);
      },
    },
  };
}

export const FLY_FPS = 24;
export const FLY_SECONDS = { min: 2, max: 60, default: 8 };
export const photorealActionButton = 'min-h-11 inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white focus-visible:outline-2 focus-visible:outline-port-accent disabled:opacity-40';

export const ENGINES = [
  { id: 'eevee', label: 'EEVEE preview', defaultSamples: 32, note: 'Seconds per camera on a GPU.' },
  { id: 'cycles', label: 'Cycles final', defaultSamples: 128, note: 'Path traced; minutes per camera.' },
];
export const MAX_SAMPLES = 1024;

const PREFS_KEY = 'portos.photoreal.render';
const readPrefs = () => {
  const stored = safeReadJsonStorage(PREFS_KEY);
  return stored && ENGINES.some((engine) => engine.id === stored.engine) ? stored : null;
};
const writePrefs = (prefs) => safeWriteJsonStorage(PREFS_KEY, prefs);

export function usePhotorealRenderSettings() {
  const [prefs] = useState(readPrefs);
  const [engine, setEngine] = useState(prefs?.engine || 'eevee');
  const [samples, setSamples] = useState(prefs?.samples ?? null);
  const [flySeconds, setFlySeconds] = useState(prefs?.flySeconds ?? FLY_SECONDS.default);
  const engineInfo = ENGINES.find((option) => option.id === engine);
  const sampleValue = samples ?? engineInfo.defaultSamples;
  const pickEngine = (id) => {
    setEngine(id);
    setSamples(null);
    writePrefs({ engine: id, samples: null, flySeconds });
  };
  const samplesField = useDraftNumber({
    committed: sampleValue, min: 1, max: MAX_SAMPLES,
    onCommit: (next) => { setSamples(next); writePrefs({ engine, samples: next, flySeconds }); },
  });

  const updateFlySeconds = (next) => {
    setFlySeconds(next);
    writePrefs({ engine, samples, flySeconds: next });
  };
  return { engine, engineNote: engineInfo.note, samplesField, flySeconds, pickEngine, updateFlySeconds };
}
