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
        // Seed with totalSteps from the started event so the status row
        // can show "Step 0/N" immediately instead of falling back to
        // "Waiting for first preview..." on the first poll cycle.
        setProgress({
          generationId: data.generationId,
          progress: 0,
          step: 0,
          totalSteps: data.totalSteps ?? null,
          eta: null,
          currentImage: null
        });
      }
    };
    // Merge fields rather than replacing — the server throttles
    // `currentImage` (every ~2s) and the SD API may omit step/totalSteps
    // on some polls. Replacing on every event makes the preview flicker
    // back to "Waiting for first preview..." between frames.
    const onProgress = (data) => {
      if (!activeRef.current || data.generationId !== generationIdRef.current) return;
      setProgress(prev => ({
        ...(prev || {}),
        generationId: data.generationId,
        progress: data.progress ?? prev?.progress ?? 0,
        eta: data.eta ?? prev?.eta ?? null,
        step: data.step ?? prev?.step ?? 0,
        totalSteps: data.totalSteps ?? prev?.totalSteps ?? null,
        currentImage: data.currentImage ?? prev?.currentImage ?? null
      }));
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

  // Resume tracking an in-flight job spawned before this hook mounted.
  // Seeds state from the server snapshot (last frame + step) so the user
  // sees current progress immediately after navigating back.
  const resume = useCallback((activeJob) => {
    if (!activeJob?.generationId) return;
    activeRef.current = true;
    generationIdRef.current = activeJob.generationId;
    setProgress({
      generationId: activeJob.generationId,
      progress: activeJob.progress ?? 0,
      step: activeJob.step ?? 0,
      totalSteps: activeJob.totalSteps ?? null,
      eta: activeJob.eta ?? null,
      currentImage: activeJob.currentImage ?? null,
    });
  }, []);

  return { progress, begin, end, resume };
}
