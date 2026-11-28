import { useEffect, useRef, useState } from 'react';
import portraitUrl from './call-portrait.webp';
import MediaImage from '../MediaImage';
import { avatarImageSrc } from './useAvatarLibrary';
import { bindVoiceOutputVisualizer } from '../../services/voiceClient';
import { streamVoiceAvatar, streamVoiceAvatarIdle } from '../../services/apiVoiceAvatar';

const IDLE_STAGES = new Set(['idle', 'listening', 'thinking']);
const FRAME_INTERVAL_MS = 40; // 25 fps
const MAX_IDLE_QUEUE = 20;

const normalizeIdleStage = (stage) => (IDLE_STAGES.has(stage) ? stage : 'idle');

function decodeAndPaint(canvas, jpeg, isStillValid, onPainted) {
  const image = new Image();
  image.src = 'data:image/jpeg;base64,' + jpeg;
  return image.decode().then(() => {
    if (!isStillValid()) return;
    canvas.getContext('2d')?.drawImage(image, 0, 0, 512, 512);
    canvas.style.visibility = 'visible';
    onPainted?.();
  }).catch(() => {});
}

function animateWav(canvas, wav, { stopForReducedMotion, keepFrameOnStop, onPainted, onStop, onUnavailable }) {
  const abort = new AbortController();
  const frames = new Map();
  const { promise: ready, resolve: primed } = Promise.withResolvers();
  let frame;
  let latest = -1;
  let drawn = -1;
  let loading = false;
  let ended = false;
  streamVoiceAvatar(wav, { signal: abort.signal, onFrame: ({ index, jpeg }) => {
    if (Number.isInteger(index) && index >= 0 && index < 400 && typeof jpeg === 'string' && index > drawn) {
      frames.set(index, jpeg);
      latest = index;
      primed();
    }
  } }).catch(() => {}).finally(() => {
    if (!ended && latest < 0) onUnavailable();
    primed();
  });

  const draw = (clock) => {
    if (stopForReducedMotion()) return;
    const target = Math.floor(clock() * 25);
    const index = Math.min(target, latest);
    if (target - drawn > 5 && !keepFrameOnStop()) canvas.style.visibility = 'hidden';
    if (!loading && index > drawn && target - index <= 3 && frames.has(index)) {
      loading = true;
      decodeAndPaint(
        canvas,
        frames.get(index),
        () => !ended && !stopForReducedMotion() && Math.floor(clock() * 25) - index <= 5,
        () => {
          drawn = index;
          onPainted?.();
          for (const key of frames.keys()) if (key <= index) frames.delete(key);
        },
      ).finally(() => { loading = false; });
    }
    frame = requestAnimationFrame(() => draw(clock));
  };

  return {
    ready,
    start(clock) { if (!ended) draw(clock); },
    stop() {
      if (ended) return;
      ended = true;
      abort.abort();
      primed();
      cancelAnimationFrame(frame);
      if (!keepFrameOnStop()) canvas.style.visibility = 'hidden';
      onStop();
    },
  };
}

export default function VoiceCallGenerativePortrait({ running, fill = false, stage = 'idle', avatarFilename = null }) {
  const canvas = useRef(null);
  const idleStage = normalizeIdleStage(stage);
  const idleStageRef = useRef(idleStage);
  const lastStartedStageRef = useRef(idleStage);
  idleStageRef.current = idleStage;
  const [unavailable, setUnavailable] = useState(false);

  // Drive continuous real AvatarForcing neural frames whenever the model is
  // running (idle, listening, thinking, and speaking) on the same 512x512 canvas.
  // Speech immediately preempts idle and resumes continuous idle seamlessly
  // afterward with zero snap back to the static placeholder image.
  useEffect(() => {
    const target = canvas.current;
    if (!running || !target) {
      setUnavailable(false);
      if (target) target.style.visibility = 'hidden';
      return undefined;
    }

    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let speechAnimation;
    let idleAbort;
    let idleRetryTimer;
    let idleRaf = 0;
    let idleLoading = false;
    let lastIdleDrawAt = 0;
    let hasPaintedFrame = false;
    const idleQueue = [];

    const stopIdlePlayback = () => {
      if (idleRaf) {
        cancelAnimationFrame(idleRaf);
        idleRaf = 0;
      }
      idleQueue.length = 0;
      idleLoading = false;
    };

    const stopIdleStream = () => {
      clearTimeout(idleRetryTimer);
      idleRetryTimer = undefined;
      if (idleAbort) {
        idleAbort.abort();
        idleAbort = undefined;
      }
      stopIdlePlayback();
    };

    // Paint and decode callbacks can observe the preference before its change event.
    const stopForReducedMotion = () => {
      if (!motion?.matches) return false;
      stopIdleStream();
      speechAnimation?.stop();
      hasPaintedFrame = false;
      target.style.visibility = 'hidden';
      return true;
    };

    const paintIdleTick = (now) => {
      if (disposed || speechAnimation || stopForReducedMotion() || document.hidden) {
        idleRaf = 0;
        return;
      }
      if (!idleLoading && idleQueue.length > 0 && now - lastIdleDrawAt >= FRAME_INTERVAL_MS - 4) {
        const jpeg = idleQueue.shift();
        idleLoading = true;
        lastIdleDrawAt = now;
        decodeAndPaint(
          target,
          jpeg,
          () => !disposed && !speechAnimation && !stopForReducedMotion(),
          () => { hasPaintedFrame = true; },
        ).finally(() => { idleLoading = false; });
      }
      if (idleAbort || idleQueue.length > 0) {
        idleRaf = requestAnimationFrame(paintIdleTick);
      } else {
        idleRaf = 0;
      }
    };

    const startIdleStream = () => {
      if (disposed || speechAnimation || stopForReducedMotion() || document.hidden) return;
      stopIdleStream();
      const abort = new AbortController();
      idleAbort = abort;
      let receivedAny = false;
      if (!idleRaf) idleRaf = requestAnimationFrame(paintIdleTick);

      streamVoiceAvatarIdle({
        stage: idleStageRef.current,
        signal: abort.signal,
        onFrame: ({ jpeg }) => {
          if (abort.signal.aborted || typeof jpeg !== 'string') return;
          receivedAny = true;
          setUnavailable(false);
          if (idleQueue.length >= MAX_IDLE_QUEUE) idleQueue.shift();
          idleQueue.push(jpeg);
          if (!idleRaf) idleRaf = requestAnimationFrame(paintIdleTick);
        },
      }).then(() => {
        if (disposed || abort.signal.aborted || speechAnimation || motion?.matches || document.hidden) return;
        idleAbort = undefined;
        // Wait for queued frames to play out before chaining the next idle chunk
        // so short/fast chunks never spin in a tight fetch loop.
        const nextDelayMs = receivedAny
          ? Math.max(350, idleQueue.length * FRAME_INTERVAL_MS)
          : 1200;
        idleRetryTimer = setTimeout(startIdleStream, nextDelayMs);
      }).catch(() => {
        if (disposed || abort.signal.aborted || speechAnimation || motion?.matches || document.hidden) return;
        idleAbort = undefined;
        idleRetryTimer = setTimeout(startIdleStream, 2000);
      });
    };

    const canKeepCanvas = () => !disposed && !motion?.matches && hasPaintedFrame;

    const detach = bindVoiceOutputVisualizer(wav => {
      setUnavailable(false);
      if (stopForReducedMotion()) return undefined;
      speechAnimation?.stop();
      stopIdleStream();
      const anim = animateWav(target, wav, {
        stopForReducedMotion,
        keepFrameOnStop: canKeepCanvas,
        onPainted: () => { hasPaintedFrame = true; },
        onStop: () => {
          if (speechAnimation === anim) speechAnimation = undefined;
          if (!disposed && !motion?.matches && !document.hidden) {
            startIdleStream();
          }
        },
        onUnavailable: () => {
          setUnavailable(true);
        },
      });
      speechAnimation = anim;
      return anim;
    });

    const onMotionChange = () => {
      if (!stopForReducedMotion() && !speechAnimation && !document.hidden) {
        startIdleStream();
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopIdleStream();
      } else if (!speechAnimation && !motion?.matches) {
        startIdleStream();
      }
    };

    const onStageChange = () => {
      if (!speechAnimation && !motion?.matches && !document.hidden) {
        startIdleStream();
      }
    };

    target._restartIdleStage = onStageChange;
    lastStartedStageRef.current = idleStageRef.current;
    motion?.addEventListener?.('change', onMotionChange);
    document.addEventListener('visibilitychange', onVisibilityChange);
    if (!motion?.matches && !document.hidden) {
      startIdleStream();
    } else {
      target.style.visibility = 'hidden';
    }

    return () => {
      disposed = true;
      delete target._restartIdleStage;
      detach();
      motion?.removeEventListener?.('change', onMotionChange);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      stopIdleStream();
      speechAnimation?.stop();
      target.style.visibility = 'hidden';
    };
  }, [running]);

  // Restart continuous idle with updated posture/guidance only when stage
  // actually transitions between idle, listening, and thinking.
  useEffect(() => {
    if (!running || lastStartedStageRef.current === idleStage) return;
    lastStartedStageRef.current = idleStage;
    canvas.current?._restartIdleStage?.();
  }, [running, idleStage]);

  return <div className={fill ? 'w-full max-w-full' : 'w-[min(64vw,15rem)] max-w-full'}>
    <div className={`relative aspect-square overflow-hidden bg-port-card ${fill ? 'w-full' : 'rounded-lg shadow-lg'}`}>
      {avatarFilename
        ? <MediaImage src={avatarImageSrc(avatarFilename)} fallbackSrc={portraitUrl} alt="Channel avatar portrait" className="block size-full object-cover" />
        : <img src={portraitUrl} alt="Radio operator portrait" className="block size-full object-cover" />}
      <canvas ref={canvas} role="presentation" width={512} height={512} style={{ visibility: 'hidden' }} className="pointer-events-none absolute inset-0 size-full motion-reduce:invisible!" />
    </div>
    {running && unavailable && <p role="status" className="px-2 pt-1.5 pb-1 text-center font-mono text-[11px] text-port-text-muted">
      No avatar frames arrived. Voice audio still works.
    </p>}
  </div>;
}
