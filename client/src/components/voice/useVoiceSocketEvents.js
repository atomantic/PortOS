import { useEffect } from 'react';
import {
  captureVisionFrame,
  isCapturing,
  isContinuous,
  isVisionCaptureEnabled,
  isWebSpeechCapturing,
  onProactiveSpeech,
  onVoiceEvent,
  sendScreenshotResult,
  whenVoiceTurnAudioDrained,
} from '../../services/voiceClient';
import { markVoiceTiming } from '../../services/voiceTimingDebug';
import { doClick, doFill, doSelect, doSetCheckbox } from '../../services/uiInteract';
import { pushUiIndexAfterAction } from './useVoiceUiSync';
import toast from '../ui/Toast';

/**
 * Subscribes `VoiceWidget` to server-pushed `voice:*` events, DOM-action
 * commands, screenshot frame requests, and proactive CoS speech while voice is
 * enabled.
 */
export function useVoiceSocketEvents({
  enabled,
  navigate,
  disposedRef,
  handleStartRef,
  handleStopRef,
  activeStages,
  appendHistory,
  appendAssistantDelta,
  clearHistory,
  setStage,
  setDictationActive,
  setVisionEnabled,
}) {
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    const isLive = () => active && !disposedRef.current;

    const restState = () => {
      if (isWebSpeechCapturing()) return 'listening';
      if (isContinuous()) return 'handsfree';
      return 'idle';
    };

    const runUiAction = (res, failureMessage) => {
      if (!res.ok) toast.error(failureMessage);
      else pushUiIndexAfterAction();
    };

    const offs = [
      onVoiceEvent('voice:transcript', (d) => {
        // In web-speech mode, user text is already appended client-side when
        // onFinal fires. Server echoes it back with source='text' — skip the
        // duplicate append but still advance the stage.
        if (d.text && d.source !== 'text') appendHistory({ role: 'user', text: d.text });
        setStage('thinking');
      }),
      // A cold local model: the server saw it was not resident before sending
      // the request, so the wait is a load, not the model thinking.
      onVoiceEvent('voice:llm:loading', () => {
        setStage((current) => (current === 'thinking' ? 'loading' : current));
      }),
      onVoiceEvent('voice:llm:delta', (d) => {
        if (d.delta) appendAssistantDelta(d.delta);
        setStage((current) => (current === 'loading' ? 'thinking' : current));
      }),
      onVoiceEvent('voice:tts:audio', () => {
        // 'handsfree' is intentionally NOT preserved here — the arrival of
        // TTS audio means the bot is speaking, so stage must advance.
        setStage((current) => (
          current === 'listening' || current === 'capturing' ? current : 'speaking'
        ));
      }),
      onVoiceEvent('voice:idle', (d) => {
        if (!isLive()) return;
        // voice:idle fires when the server finishes *sending* TTS; local
        // playback may still be running. Wait for drain so stage doesn't
        // flip off 'speaking' while audio is still playing.
        if (d?.reason === 'reset') clearHistory();
        whenVoiceTurnAudioDrained().then(() => {
          if (!isLive()) return;
          if (d?.reason === 'turn-complete') markVoiceTiming('audio.drained (turn end)');
          setStage((current) => (activeStages.has(current) ? current : restState()));
        });
      }),
      onVoiceEvent('voice:error', (d) => {
        if (!isLive()) return;
        toast.error(`Voice: ${d.message}`);
        setStage(restState());
      }),
      onVoiceEvent('voice:navigate', (d) => {
        if (d?.path && typeof d.path === 'string') navigate(d.path);
      }),
      onVoiceEvent('voice:dictation', (d) => {
        const next = !!d?.enabled;
        setDictationActive((prev) => (prev === next ? prev : next));
        // Auto-start the mic when dictation begins so Daily Log's Dictate button
        // actually captures speech; mirror stop on the way out. Read handlers
        // through refs so we always invoke the latest closure.
        if (next) {
          setTimeout(() => {
            if (isLive()) handleStartRef.current?.();
          }, 0);
        } else if (isWebSpeechCapturing() || isCapturing() || isContinuous()) {
          handleStopRef.current?.();
        }
      }),
      onVoiceEvent('voice:dailyLog:appended', (d) => {
        if (d?.text) {
          const preview = d.text.length > 60 ? `${d.text.slice(0, 60)}…` : d.text;
          toast(`📓 +"${preview}"`);
        }
      }),
      onVoiceEvent('voice:ui:click', (d) => runUiAction(
        doClick(d?.target),
        `Voice: couldn't click "${d?.target?.label || d?.target?.ref}"`,
      )),
      onVoiceEvent('voice:ui:fill', (d) => runUiAction(
        doFill(d?.target, d?.value),
        `Voice: couldn't fill "${d?.target?.label || d?.target?.ref}"`,
      )),
      onVoiceEvent('voice:ui:select', (d) => runUiAction(
        doSelect(d?.target, d?.option),
        `Voice: couldn't select "${d?.option}" on "${d?.target?.label}"`,
      )),
      onVoiceEvent('voice:ui:check', (d) => runUiAction(
        doSetCheckbox(d?.target, d?.checked),
        `Voice: couldn't toggle "${d?.target?.label}"`,
      )),
      // Server asks for a frame of the authorized screen-capture stream. Always
      // reply so the server-side waiter resolves rather than timing out.
      onVoiceEvent('voice:screenshot:request', async (payload) => {
        if (!isLive()) return;
        const requestId = payload && typeof payload === 'object' ? payload.requestId : undefined;
        if (!isVisionCaptureEnabled()) {
          toast('Voice: click the screen button in the voice controls so I can see your screen.', { icon: '🖥️' });
          setVisionEnabled(false);
          sendScreenshotResult(requestId, null);
          return;
        }
        const captureStart = Date.now();
        const frame = await captureVisionFrame();
        if (!isLive()) return;
        markVoiceTiming(`vision.frame ${frame ? 'ok' : 'none'} ${Date.now() - captureStart}ms`);
        if (!frame) {
          toast('Voice: screen capture was unavailable.', { icon: '📷' });
          setVisionEnabled(isVisionCaptureEnabled());
        }
        sendScreenshotResult(requestId, frame);
      }),
    ];
    return () => {
      active = false;
      offs.forEach((off) => off());
    };
  }, [
    enabled,
    navigate,
    disposedRef,
    handleStartRef,
    handleStopRef,
    activeStages,
    appendHistory,
    appendAssistantDelta,
    clearHistory,
    setStage,
    setDictationActive,
    setVisionEnabled,
  ]);

  // Proactive CoS speech — surface a transient toast so the user has visual
  // context for unexpected speech, and append to history.
  useEffect(() => {
    if (!enabled) return undefined;
    return onProactiveSpeech(({ sentence, priority }) => {
      if (disposedRef.current) return;
      appendHistory({ role: 'assistant', text: sentence, proactive: true });
      const icon = priority === 'high' ? '🔔' : '🤖';
      toast(`${icon} ${sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence}`);
    });
  }, [enabled, disposedRef, appendHistory]);
}
