import { useEffect, useRef, useState } from 'react';

const STT_STAGES = new Set(['listening', 'capturing']);
const LLM_STAGES = new Set(['loading', 'thinking']);

export function formatTurnLatency(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
}

/**
 * Tracks the active voice pipeline phase (`stt` → `llm` → `tts`) and measures real
 * client-observed time-to-first-audio (ms) across each turn for the transceiver LCD.
 */
export default function useVoiceTurnProgress(stage) {
  const turnStartRef = useRef(null);
  const hadSttRef = useRef(false);
  const recordedForTurnRef = useRef(false);
  const [latencyMs, setLatencyMs] = useState(null);

  useEffect(() => {
    if (STT_STAGES.has(stage)) {
      hadSttRef.current = true;
      turnStartRef.current = null;
      recordedForTurnRef.current = false;
      return;
    }
    if (LLM_STAGES.has(stage)) {
      if (turnStartRef.current === null) {
        turnStartRef.current = Date.now();
        recordedForTurnRef.current = false;
      }
      return;
    }
    if (stage === 'speaking') {
      if (turnStartRef.current !== null && !recordedForTurnRef.current) {
        recordedForTurnRef.current = true;
        setLatencyMs(Math.max(1, Date.now() - turnStartRef.current));
      }
      return;
    }
    // Returning to idle / handsfree resets turn tracking while keeping the last latency readout.
    turnStartRef.current = null;
    hadSttRef.current = false;
    recordedForTurnRef.current = false;
  }, [stage]);

  const activeStep = STT_STAGES.has(stage)
    ? 'stt'
    : LLM_STAGES.has(stage)
      ? 'llm'
      : stage === 'speaking'
        ? 'tts'
        : null;

  const sttDone = (activeStep === 'llm' || activeStep === 'tts') && hadSttRef.current;
  const llmDone = activeStep === 'tts';

  return {
    activeStep,
    sttDone,
    llmDone,
    latencyMs,
    latencyLabel: formatTurnLatency(latencyMs),
  };
}
