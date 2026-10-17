import { useEffect, useRef } from 'react';

/** Native playback, with the same sRGB decoded surface as Save frame when paused. */
export default function PreviewVideo({ videoRef, audioRef, active = true, className, style, ...props }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!video || !canvas || !audio) return undefined;
    let handle = 0;
    const invalidate = () => {
      cancelAnimationFrame(handle);
      delete video.dataset.pausedFrame;
      canvas.style.visibility = 'hidden';
      video.style.visibility = audio.paused ? 'hidden' : '';
    };
    const paint = () => {
      if (!active || !audio.paused || video.seeking || video.readyState < 2) return;
      const scale = Math.min(1, Math.sqrt(16777216 / (video.videoWidth * video.videoHeight)));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (!video.videoWidth || !video.videoHeight) return;
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!ctx) { video.dataset.previewError = 'Frame capture unavailable'; return; }
      try {
        ctx.drawImage(video, 0, 0, width, height);
        delete video.dataset.previewError;
        video.dataset.pausedFrame = String(video.currentTime);
        canvas.style.visibility = '';
        video.style.visibility = 'hidden';
      } catch { invalidate(); video.dataset.previewError = 'Video frame unavailable'; }
    };
    const schedule = () => {
      invalidate();
      if (!active || !audio.paused) return;
      // seeked precedes presentation in Chromium; let the decoded frame reach
      // the compositor before drawing. A new seek cancels this pending paint.
      handle = requestAnimationFrame(() => { handle = requestAnimationFrame(paint); });
    };
    const events = ['loadeddata', 'seeked', 'pause'];
    for (const event of events) video.addEventListener(event, schedule);
    video.addEventListener('seeking', invalidate);
    video.addEventListener('emptied', invalidate);
    audio.addEventListener('play', invalidate);
    audio.addEventListener('pause', schedule);
    schedule();
    return () => {
      invalidate();
      for (const event of events) video.removeEventListener(event, schedule);
      video.removeEventListener('seeking', invalidate);
      video.removeEventListener('emptied', invalidate);
      audio.removeEventListener('play', invalidate);
      audio.removeEventListener('pause', schedule);
    };
  }, [videoRef, audioRef, active, props.src]);
  const fit = className.includes('object-cover') ? 'object-cover' : 'object-contain';
  return <div className={className} style={style}>
    <video {...props} ref={videoRef} data-preview-video="true" className={`h-full w-full ${fit}`} />
    <canvas ref={canvasRef} tabIndex={-1} aria-hidden="true" data-paused-video="true"
      className={`pointer-events-none absolute inset-0 h-full w-full ${fit}`} style={{ visibility: 'hidden' }} />
  </div>;
}
