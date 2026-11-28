/**
 * Whether the saved Voice LLM is resident in memory, kept current from the loaded-models socket room, turn ends and the live "loading" call stage.
 */

import { useEffect, useRef } from 'react';
import { getVoiceLlmResidency } from '../services/apiVoice';
import { useSocketResource } from './useSocketResource';

// The second event marks a warm-up starting or finishing a model load.
const LOADED_EVENTS = ['loaded-models:changed', 'voice:llm:residency:changed'];
const TURN_STAGES = new Set(['loading', 'thinking', 'speaking']);

/**
 * @param {{ provider: string, model: string, stage?: string, enabled?: boolean }} args
 * @returns {'loaded'|'loading'|'unloaded'|'offline'|'unknown'|null} null until the first read lands.
 */
export default function useVoiceLlmResidency({ provider, model, stage, enabled = true }) {
  const { data, refetch } = useSocketResource(
    ({ signal }) => getVoiceLlmResidency({ silent: true, signal }),
    { namespace: 'loaded-models', events: LOADED_EVENTS, resourceKey: `${provider}|${model}`, enabled },
  );

  // A finished turn is the moment a cold model became (or stopped being) resident;
  // llama.cpp's idle release is not on the loaded-models room, so re-read here.
  const prevStageRef = useRef(stage);
  useEffect(() => {
    const prev = prevStageRef.current;
    prevStageRef.current = stage;
    if (enabled && TURN_STAGES.has(prev) && !TURN_STAGES.has(stage)) refetch();
  }, [stage, enabled, refetch]);

  if (!enabled) return null;
  if (stage === 'loading') return 'loading';
  return data?.state ?? null;
}
