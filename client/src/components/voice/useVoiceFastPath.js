import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  interrupt,
  isVisionCaptureEnabled,
  isWebSpeechCapturing,
  speakSynthesized,
  whenPlaybackDrained,
} from '../../services/voiceClient';
import { resolveTurn, buildRouterSystemPrompt, TIER } from '../../services/voiceFastPath';
import { warmNano } from '../../services/browserLlm';
import { getPaletteManifest } from '../../services/apiPalette';

/**
 * On-device fast-resolution cascade (trigger → Chrome Nano → server fallback).
 * Owns nav manifest prefetch/retry, Nano session pre-warming, and local TTS
 * reply playback so `VoiceWidget` only invokes `runFastPath(text)`.
 */
export function useVoiceFastPath({
  enabled,
  fastPath,
  personality,
  tts,
  dictationActive,
  history,
  pendingImagesRef,
  disposedRef,
  turnGenerationRef,
  activeStages,
  navigate,
  appendHistory,
  setStage,
}) {
  // Mirrored into refs so the routeFinal closure bound at capture start always
  // triages against current settings without re-binding the recognizer.
  const fastPathRef = useRef(fastPath);
  const personalityRef = useRef(personality);
  const ttsRef = useRef(tts);
  const dictationActiveRef = useRef(dictationActive);
  const lastAssistantReplyRef = useRef('');
  const navEntriesRef = useRef([]);
  const navFetchRef = useRef(null);

  useLayoutEffect(() => {
    fastPathRef.current = fastPath;
    personalityRef.current = personality;
    ttsRef.current = tts;
  }, [fastPath, personality, tts]);

  useLayoutEffect(() => {
    dictationActiveRef.current = dictationActive;
  }, [dictationActive]);

  // Track the most recent completed assistant reply so the cascade can detect a
  // destructive-confirmation follow-up ("yes"/"cancel" after a gate prompt) and
  // route it to the server instead of the on-device model.
  useEffect(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === 'assistant') {
        lastAssistantReplyRef.current = history[i].text || '';
        return;
      }
    }
  }, [history]);

  // Load the palette nav manifest so tier-1 trigger navigation ("go to tasks")
  // can resolve against the same routes ⌘K uses. Memoized + self-healing: a
  // failed fetch clears the in-flight promise so the next turn retries.
  const ensureNavEntries = useCallback(async () => {
    if (navEntriesRef.current.length) return;
    if (!navFetchRef.current) {
      navFetchRef.current = getPaletteManifest({ silent: true })
        .then((data) => { navEntriesRef.current = Array.isArray(data?.nav) ? data.nav : []; })
        .catch(() => { navFetchRef.current = null; });
    }
    await navFetchRef.current;
  }, []);

  // Prefetch the manifest when the trigger tier is active so the first "go to X"
  // doesn't pay the fetch (falls back to the lazy retry in runFastPath on failure).
  useEffect(() => {
    if (!enabled || !fastPath?.enabled || !fastPath?.triggers) return;
    ensureNavEntries();
  }, [enabled, fastPath?.enabled, fastPath?.triggers, ensureNavEntries]);

  // Pre-warm the on-device model when the browser-LLM tier is active so the
  // first spoken turn doesn't pay session-creation latency. Use the SAME router
  // system prompt real turns use, so the warmed session isn't torn down and
  // rebuilt on the first turn (the session cache is keyed by the prompt). No-op
  // unless Nano is already downloaded (we never kick off a download here).
  useEffect(() => {
    if (!enabled || !fastPath?.enabled || !fastPath?.browserLlm) return;
    warmNano({
      systemPrompt: buildRouterSystemPrompt(personalityRef.current || {}),
      temperature: fastPath?.browser?.temperature ?? 0.7,
      topK: fastPath?.browser?.topK ?? 3,
    }).catch(() => {});
    // personalityRef is read inside, so the fields that shape the router prompt
    // are listed explicitly to re-warm Nano when they change.
  }, [
    enabled,
    fastPath?.enabled,
    fastPath?.browserLlm,
    personality?.name,
    personality?.speechStyle,
    fastPath?.browser?.temperature,
    fastPath?.browser?.topK,
  ]);

  // Triages one client transcript through trigger → Nano → server and, when a
  // fast tier owns it, executes locally. Returns true when handled; false means
  // "send to the server pipeline as usual".
  const runFastPath = useCallback(async (text) => {
    if (disposedRef.current) return false;
    const generation = turnGenerationRef.current;
    const fp = fastPathRef.current;
    if (!fp?.enabled) return false;
    // The on-device tiers can't see: a turn about a shared tab or a queued
    // image goes to the server, which attaches the image descriptions.
    if (isVisionCaptureEnabled() || pendingImagesRef.current.length) return false;
    if (fp.triggers) await ensureNavEntries();
    let decision;
    try {
      decision = await resolveTurn(text, {
        fastPath: fp,
        personality: personalityRef.current || {},
        navEntries: navEntriesRef.current,
        dictationActive: dictationActiveRef.current,
        lastAssistantReply: lastAssistantReplyRef.current,
      });
    } catch {
      return false;
    }
    if (disposedRef.current || generation !== turnGenerationRef.current) return true;
    if (decision.tier === TIER.SERVER) return false;

    // A fast tier owns this turn. Stop any lingering playback, speak the reply
    // through the same queue as server TTS, and settle the stage on drain.
    const speak = (line) => {
      if (disposedRef.current) return;
      interrupt();
      appendHistory({ role: 'assistant', text: line });
      setStage('speaking');
      speakSynthesized(line, { ...ttsRef.current, animate: true })
        .catch(() => {})
        .finally(() => whenPlaybackDrained().then(() => {
          if (disposedRef.current) return;
          setStage((current) => (
            activeStages.has(current) ? current : (isWebSpeechCapturing() ? 'listening' : 'idle')
          ));
        }));
    };

    if (decision.tier === TIER.TRIGGER && decision.kind === 'navigate') {
      navigate(decision.path);
      speak(`Opening ${decision.label}.`);
      return true;
    }
    if (decision.tier === TIER.NANO) {
      speak(decision.reply);
      return true;
    }
    return false;
  }, [navigate, ensureNavEntries, appendHistory, setStage, activeStages, disposedRef, turnGenerationRef, pendingImagesRef]);

  return { runFastPath, fastPathRef };
}
