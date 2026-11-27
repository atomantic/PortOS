import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveDynamicAvatar, STATE_MESSAGES, summarizeHealthIssues } from './constants';

// How long the avatar keeps "speaking" after an event that gives it something to
// say. Exported so tests drain the timer by this value rather than a literal —
// a hardcoded drain that no longer covers the timer lets a state update escape
// act() again.
export const SPEAKING_MS = 2000;

export default function useCosAvatarState({ status, statusRef, agentsRef, needsRef, healthRef }) {
  const [agentState, setAgentState] = useState('sleeping');
  const agentStateRef = useRef(agentState);
  agentStateRef.current = agentState;
  const [speaking, setSpeaking] = useState(false);
  // Socket events and manual checks share one visible speaking window. Each
  // burst owns a generation so a stale timer or request completion cannot end
  // a newer burst early.
  const speakingTimerRef = useRef(null);
  const speakingGenerationRef = useRef(0);
  const setSpeakingFor = useCallback((duration = SPEAKING_MS, generation) => {
    if (generation !== undefined && generation !== speakingGenerationRef.current) return null;
    if (speakingTimerRef.current !== null) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    const nextGeneration = generation ?? speakingGenerationRef.current + 1;
    speakingGenerationRef.current = nextGeneration;
    if (duration <= 0) {
      setSpeaking(false);
      return nextGeneration;
    }
    setSpeaking(true);
    speakingTimerRef.current = setTimeout(() => {
      if (speakingGenerationRef.current !== nextGeneration) return;
      speakingTimerRef.current = null;
      setSpeaking(false);
    }, duration);
    return nextGeneration;
  }, []);
  useEffect(() => () => {
    speakingGenerationRef.current += 1;
    if (speakingTimerRef.current !== null) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
  }, []);
  const [statusMessage, setStatusMessage] = useState("Idle - waiting for tasks...");
  const [activeAgentMeta, setActiveAgentMeta] = useState(null);

  // Derive avatar style from server config, with optional dynamic override
  const configAvatarStyle = status?.config?.avatarStyle || 'svg';
  const dynamicAvatarEnabled = status?.config?.dynamicAvatar || false;
  const dynamicStyle = dynamicAvatarEnabled ? resolveDynamicAvatar(activeAgentMeta) : null;
  const avatarStyle = dynamicStyle || configAvatarStyle;

  // Derive agent state from system status
  const currentAgentState = useCallback(() => {
    const statusData = statusRef.current;
    const agentsData = needsRef.current.agents ? agentsRef.current : [];
    const healthData = healthRef.current;
    if (!statusData?.running) return 'sleeping';
    if (statusData.paused) return 'sleeping';

    const activeAgents = agentsData.filter(a => a.status === 'running');
    if (activeAgents.length > 0 || statusData.activeAgents > 0) return 'coding';

    if (healthData?.issues?.length > 0) return 'investigating';

    // When running but idle, show as thinking (ready to work)
    return 'thinking';
  }, [statusRef, agentsRef, needsRef, healthRef]);

  // Derive the avatar state and its default message from the newest committed
  // status, agents and health. Every transition that changes one of those inputs
  // without a richer message of its own calls this, so no state depends on a tab
  // switch's full refresh to be corrected.
  // `ifChanged` is for reconciliation: it leaves the richer message of a socket
  // event (`Running: <task>`) alone unless the derived state actually differs.
  const settleAgentState = useCallback(({ ifChanged = false } = {}) => {
    const liveStatus = statusRef.current;
    const liveHealth = healthRef.current;
    const nextState = currentAgentState();
    if (ifChanged && nextState === agentStateRef.current) return;
    setAgentState(nextState);
    // Default state message — richer messages come from socket events. The one
    // state whose default is useless is `investigating`: only a health issue
    // gets us here, so name it rather than saying "Investigating issue..." next
    // to an Active count of 0 with no agent to inspect.
    setStatusMessage(liveStatus?.paused
      ? `Paused${liveStatus.pauseReason ? ` — ${liveStatus.pauseReason}` : ''}`
      : (nextState === 'investigating' && summarizeHealthIssues(liveHealth?.issues)) || STATE_MESSAGES[nextState]);
  }, [currentAgentState, statusRef, healthRef]);

  return {
    agentState, agentStateRef, speaking, statusMessage, configAvatarStyle, avatarStyle,
    currentAgentState, settleAgentState, setAgentState, setStatusMessage, setSpeakingFor, setActiveAgentMeta,
  };
}
