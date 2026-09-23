import { useCallback, useEffect, useRef, useState } from 'react';
import { startMemoRecording } from '../lib/audioRecorder.js';
import useMounted from './useMounted.js';

/** Owns a memo recorder across permission prompts, repeated starts, and unmount. */
export default function useMemoRecorder() {
  const mountedRef = useMounted();
  const handleRef = useRef(null);
  const startingRef = useRef(false);
  const generationRef = useRef(0);
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [stream, setStream] = useState(null);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    startingRef.current = false;
    const handle = handleRef.current;
    handleRef.current = null;
    handle?.cancel();
    if (mountedRef.current) {
      setStarting(false);
      setRecording(false);
      setStream(null);
    }
  }, [mountedRef]);

  useEffect(() => () => { cancel(); }, [cancel]);

  const start = useCallback(async () => {
    if (!mountedRef.current || startingRef.current || handleRef.current) return null;
    startingRef.current = true;
    const generation = ++generationRef.current;
    setStarting(true);
    let handle;
    try {
      handle = await startMemoRecording();
    } catch (error) {
      if (generation === generationRef.current && mountedRef.current) {
        startingRef.current = false;
        setStarting(false);
        throw error;
      }
      return null;
    }
    if (generation !== generationRef.current || !mountedRef.current) {
      handle.cancel();
      return null;
    }
    startingRef.current = false;
    handleRef.current = handle;
    setStarting(false);
    setRecording(true);
    setStream(handle.stream || null);
    return handle;
  }, [mountedRef]);

  const stop = useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return null;
    handleRef.current = null;
    generationRef.current += 1;
    if (mountedRef.current) {
      setRecording(false);
      setStream(null);
    }
    return handle.stop();
  }, [mountedRef]);

  return { recording, starting, start, stop, cancel, stream };
}
