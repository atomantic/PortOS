import { useEffect, useRef, useState } from 'react';
import portraitUrl from './call-portrait.webp';
import { bindVoiceOutputVisualizer } from '../../services/voiceClient';
import { streamVoiceAvatar } from '../../services/apiVoiceAvatar';

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

export default function VoiceCallGenerativePortrait({ running }) {
  const canvas = useRef(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!running) return undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation;
    const detach = bindVoiceOutputVisualizer(wav => {
      setUnavailable(false);
      if (motion.matches) return undefined;
      animation?.stop();
      animation = animateWav(canvas.current, wav, () => { animation = undefined; }, () => setUnavailable(true));
      return animation;
    });
    const reduce = () => { if (motion.matches) animation?.stop(); };
    motion.addEventListener('change', reduce);
    return () => {
      detach();
      motion.removeEventListener('change', reduce);
      animation?.stop();
    };
  }, [running]);

  return <div className="w-[min(64vw,15rem)] max-w-full">
    <div className="relative aspect-square overflow-hidden rounded-lg bg-port-card shadow-lg">
      <img src={portraitUrl} alt="Radio operator portrait" className="block size-full object-cover" />
      <canvas ref={canvas} role="presentation" width={512} height={512} style={{ visibility: 'hidden' }} className="pointer-events-none absolute inset-0 size-full" />
    </div>
    {running && unavailable && <p role="status" className="pt-1 text-center text-xs text-port-text-muted">
      No avatar frames arrived. Voice audio still works.
    </p>}
  </div>;
}
