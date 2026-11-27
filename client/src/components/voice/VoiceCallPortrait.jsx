import { useEffect, useId, useRef } from 'react';
import { getVoiceOutputLevel } from '../../services/voiceClient';
import portraitUrl from './call-portrait.webp';

// The lower lip in this test portrait has fixed landmarks. Keep the idle
// image intact; move just that lip and open the painted mouth beneath it.
// This follows playback amplitude, not phonemes or a generative renderer.
export default function VoiceCallPortrait({ speaking }) {
  const id = useId();
  const aperture = useRef(null);
  const lip = useRef(null);
  useEffect(() => {
    if (!speaking || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const mouth = aperture.current;
    const lowerLip = lip.current;
    let frame;
    const draw = () => {
      const level = getVoiceOutputLevel();
      const height = level < 0.02 ? 0 : level * 14;
      mouth.setAttribute('transform', `translate(0 352) scale(1 ${height.toFixed(2)})`);
      lowerLip.setAttribute('transform', `translate(0 ${(height * 0.8).toFixed(2)})`);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      mouth.setAttribute('transform', 'translate(0 352) scale(1 0)');
      lowerLip.removeAttribute('transform');
    };
  }, [speaking]);

  return (
    <svg role="img" aria-label="Original radio operator test portrait" viewBox="0 0 640 640"
      className="block aspect-square h-auto w-[min(64vw,15rem)] max-w-full rounded-lg bg-port-card shadow-lg">
      <defs>
        <clipPath id={id}>
          <path d="M279 352 Q301 355 325 352 Q353 355 375 351 Q360 373 326 375 Q300 375 279 352Z" />
        </clipPath>
      </defs>
      <image href={portraitUrl} width="640" height="640" />
      <path ref={aperture} d="M280 0 Q303 0 326 0 Q348 0 374 0 Q361 .55 348 .82 Q324 1.2 304 .77 Q291 .52 280 0Z"
        fill="#341b1b" transform="translate(0 352) scale(1 0)" />
      <g ref={lip}>
        <image href={portraitUrl} width="640" height="640" clipPath={`url(#${id})`} />
      </g>
    </svg>
  );
}
