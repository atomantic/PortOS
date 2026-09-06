import { useEffect, useRef } from 'react';
import socket from '../services/socket';

export function useMediaCompletionRefresh({ onImageCompleted, onVideoCompleted, delay = 250 } = {}) {
  const imageCallbackRef = useRef(onImageCompleted);
  const videoCallbackRef = useRef(onVideoCompleted);
  const timersRef = useRef({ image: null, video: null });

  useEffect(() => { imageCallbackRef.current = onImageCompleted; }, [onImageCompleted]);
  useEffect(() => { videoCallbackRef.current = onVideoCompleted; }, [onVideoCompleted]);

  useEffect(() => {
    const schedule = (kind, callbackRef) => {
      if (!callbackRef.current) return;
      if (timersRef.current[kind]) clearTimeout(timersRef.current[kind]);
      timersRef.current[kind] = setTimeout(() => {
        timersRef.current[kind] = null;
        callbackRef.current?.();
      }, delay);
    };

    const onImageDone = () => schedule('image', imageCallbackRef);
    const onVideoDone = () => schedule('video', videoCallbackRef);
    // A batch can save usable videos before a later render fails or is canceled.
    const onVideoFailed = (event) => {
      if (Array.isArray(event?.results) && event.results.length > 0) onVideoDone();
    };

    socket.on('image-gen:completed', onImageDone);
    socket.on('video-gen:completed', onVideoDone);
    socket.on('video-gen:failed', onVideoFailed);

    return () => {
      socket.off('image-gen:completed', onImageDone);
      socket.off('video-gen:completed', onVideoDone);
      socket.off('video-gen:failed', onVideoFailed);
      Object.values(timersRef.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
      timersRef.current = { image: null, video: null };
    };
  }, [delay]);
}
