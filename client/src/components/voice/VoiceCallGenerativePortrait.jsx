import { useEffect, useRef, useState } from 'react';
import portraitUrl from './call-portrait.webp';
import { bindVoiceOutputVisualizer } from '../../services/voiceClient';
import { streamVoiceAvatar } from '../../services/apiVoiceAvatar';
import {
  PORTRAIT_SIZE,
  createIdleMotionState,
  stepIdleMotion,
  renderLivingPortrait,
} from './avatarIdleAnimator';

function animateWav(canvas, wav, onStop, onUnavailable) {
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
    const target = Math.floor(clock() * 25);
    const index = Math.min(target, latest);
    if (target - drawn > 5) canvas.style.visibility = 'hidden';
    if (!loading && index > drawn && target - index <= 3 && frames.has(index)) {
      const image = new Image();
      loading = true;
      image.src = 'data:image/jpeg;base64,' + frames.get(index);
      image.decode().then(() => {
        if (ended || Math.floor(clock() * 25) - index > 5) return;
        canvas.getContext('2d')?.drawImage(image, 0, 0, 512, 512);
        canvas.style.visibility = 'visible';
        drawn = index;
        for (const key of frames.keys()) if (key <= index) frames.delete(key);
      }).catch(() => {}).finally(() => { loading = false; });
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
      canvas.style.visibility = 'hidden';
      onStop();
    },
  };
}

export default function VoiceCallGenerativePortrait({ running, fill = false, stage = 'idle' }) {
  const imgRef = useRef(null);
  const idleCanvas = useRef(null);
  const canvas = useRef(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const speechActiveRef = useRef(false);
  const [unavailable, setUnavailable] = useState(false);

  // Living idle portrait loop: breathing, periodic sighs, natural blinking,
  // subtle eye gaze saccades, and stage-aware posture while not actively
  // streaming AvatarForcing speech frames. Respects prefers-reduced-motion.
  useEffect(() => {
    const target = idleCanvas.current;
    const img = imgRef.current;
    if (!target || !img) return undefined;
    const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const ctx = target.getContext?.('2d');
    if (!ctx) return undefined;

    const idleState = createIdleMotionState();
    let rafId = 0;
    let lastTs = 0;
    let disposed = false;

    const stopLoop = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      lastTs = 0;
    };

    const tick = (ts) => {
      if (disposed) return;
      if (motion?.matches) {
        target.style.visibility = 'hidden';
        stopLoop();
        return;
      }
      if (!document.hidden && !speechActiveRef.current && img.complete && img.naturalWidth > 0) {
        const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0.016;
        lastTs = ts;
        const pose = stepIdleMotion(idleState, dt, stageRef.current);
        renderLivingPortrait(ctx, img, pose);
        if (target.style.visibility !== 'visible') target.style.visibility = 'visible';
      } else {
        lastTs = ts;
      }
      rafId = requestAnimationFrame(tick);
    };

    const syncMotion = () => {
      if (disposed) return;
      if (motion?.matches) {
        target.style.visibility = 'hidden';
        stopLoop();
      } else if (!rafId) {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onLoad = () => syncMotion();
    img.addEventListener('load', onLoad);
    motion?.addEventListener?.('change', syncMotion);
    syncMotion();

    return () => {
      disposed = true;
      stopLoop();
      img.removeEventListener('load', onLoad);
      motion?.removeEventListener?.('change', syncMotion);
    };
  }, []);

  // AvatarForcing live speech frame stream layered above the living idle canvas
  useEffect(() => {
    if (!running) {
      speechActiveRef.current = false;
      return undefined;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation;
    const detach = bindVoiceOutputVisualizer(wav => {
      setUnavailable(false);
      if (motion.matches) return undefined;
      animation?.stop();
      speechActiveRef.current = true;
      animation = animateWav(
        canvas.current,
        wav,
        () => {
          animation = undefined;
          speechActiveRef.current = false;
        },
        () => {
          speechActiveRef.current = false;
          setUnavailable(true);
        },
      );
      return animation;
    });
    const reduce = () => { if (motion.matches) animation?.stop(); };
    motion.addEventListener('change', reduce);
    return () => {
      detach();
      motion.removeEventListener('change', reduce);
      animation?.stop();
      speechActiveRef.current = false;
    };
  }, [running]);

  return <div className={fill ? 'w-full max-w-full' : 'w-[min(64vw,15rem)] max-w-full'}>
    <div className={`relative aspect-square overflow-hidden bg-port-card ${fill ? 'w-full' : 'rounded-lg shadow-lg'}`}>
      <img ref={imgRef} src={portraitUrl} alt="Radio operator portrait" className="block size-full object-cover" />
      <canvas ref={idleCanvas} role="presentation" data-idle-portrait width={PORTRAIT_SIZE} height={PORTRAIT_SIZE} style={{ visibility: 'hidden' }} className="pointer-events-none absolute inset-0 size-full" />
      <canvas ref={canvas} role="presentation" width={512} height={512} style={{ visibility: 'hidden' }} className="pointer-events-none absolute inset-0 size-full" />
    </div>
    {running && unavailable && <p role="status" className="px-2 pt-1.5 pb-1 text-center font-mono text-[11px] text-port-text-muted">
      No avatar frames arrived. Voice audio still works.
    </p>}
  </div>;
}
