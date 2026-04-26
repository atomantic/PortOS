import { useState, useEffect, useRef, useCallback } from 'react';
import socket from '../services/socket';

// Tracks live diffusion progress for an image-gen call. Returns:
//   { progress, begin, end }
// Wrap your generateImage() invocation between begin() and end() so the
// hook can match incoming socket events to the active generation by id.
export function useImageGenProgress() {
  const [progress, setProgress] = useState(null);
  const activeRef = useRef(false);
  const generationIdRef = useRef(null);

  useEffect(() => {
    const onStarted = (data) => {
      if (activeRef.current && !generationIdRef.current) {
        generationIdRef.current = data.generationId;
      }
    };
    const onProgress = (data) => {
      if (activeRef.current && data.generationId === generationIdRef.current) {
        setProgress(data);
      }
    };
    const onDone = (data) => {
      if (activeRef.current && data.generationId === generationIdRef.current) {
        setProgress(null);
      }
    };
    socket.on('image-gen:started', onStarted);
    socket.on('image-gen:progress', onProgress);
    socket.on('image-gen:completed', onDone);
    socket.on('image-gen:failed', onDone);
    return () => {
      socket.off('image-gen:started', onStarted);
      socket.off('image-gen:progress', onProgress);
      socket.off('image-gen:completed', onDone);
      socket.off('image-gen:failed', onDone);
    };
  }, []);

  const begin = useCallback(() => {
    activeRef.current = true;
    generationIdRef.current = null;
    setProgress(null);
  }, []);

  const end = useCallback(() => {
    activeRef.current = false;
    generationIdRef.current = null;
    setProgress(null);
  }, []);

  return { progress, begin, end };
}
