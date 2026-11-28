import { useCallback, useEffect, useState } from 'react';
import {
  isVoiceTimingDebug,
  onVoiceTiming,
  onVoiceTimingDebugChange,
  setVoiceTimingDebug,
} from '../../services/voiceTimingDebug';

const MAX_TIMING_LINES = 300;

/**
 * Timing debug state for the Voice Call Transmission log: the persisted toggle and the timing lines
 * received while this view is mounted.
 */
export function useVoiceTimingLog() {
  const [enabled, setEnabled] = useState(isVoiceTimingDebug);
  const [lines, setLines] = useState([]);

  useEffect(() => onVoiceTimingDebugChange(setEnabled), []);
  useEffect(() => {
    if (!enabled) return undefined;
    return onVoiceTiming((line) => setLines((prev) => [...prev, line].slice(-MAX_TIMING_LINES)));
  }, [enabled]);

  const toggle = useCallback(() => setVoiceTimingDebug(!isVoiceTimingDebug()), []);
  const clear = useCallback(() => setLines([]), []);

  return { enabled, lines, toggle, clear };
}

/**
 * Interleave conversation turns and timing lines by time. Turns without `at` keep their place
 * ahead of any later timing line.
 */
export function mergeTimingLines(history, lines) {
  if (!lines.length) return history.map((turn) => ({ turn }));
  const rows = [];
  let j = 0;
  for (const turn of history) {
    while (j < lines.length && Number.isFinite(turn.at) && lines[j].at < turn.at) rows.push({ timing: lines[j++] });
    rows.push({ turn });
  }
  while (j < lines.length) rows.push({ timing: lines[j++] });
  return rows;
}
