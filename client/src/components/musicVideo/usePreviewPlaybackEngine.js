import { useCallback, useEffect, useRef, useState } from 'react';

export default function usePreviewPlaybackEngine({
  preview, audioUrl, seekRequest, mounted,
}) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const reportedAudioError = useRef(false);
  const intent = useRef(0);
  const wantsPlay = useRef(false);
  const nativePlaying = useRef(false);
  const playbackSession = useRef(null);
  const audioStartWait = useRef(null);
  const playFromRef = useRef(null);
  const resyncs = useRef([]);
  const [preparing, setPreparing] = useState(false);
  const [audioError, setAudioError] = useState('');
  useEffect(() => { reportedAudioError.current = false; setAudioError(''); }, [audioUrl]);
  const appliedSeek = useRef(null);
  const duration = preview.durationSec || 0;
  const fps = preview.fps || 24;
  const cancelAudioStart = useCallback(() => {
    const waiting = audioStartWait.current;
    if (!waiting) return;
    audioStartWait.current = null;
    cancelAnimationFrame(waiting.frame);
    clearTimeout(waiting.timer);
  }, []);
  const stopPlayback = useCallback((time = audioRef.current?.currentTime || 0, { ended = false } = {}) => {
    const next = Math.min(Math.max(0, time), Math.max(0, duration - 1 / fps));
    cancelAudioStart();
    intent.current += 1;
    wantsPlay.current = false;
    nativePlaying.current = false;
    audioRef.current?.pause?.();
    preview.pausePlayback(next);
    // Keep the media clock at the actual end so the timeline can detect its Out boundary.
    if (!ended && audioRef.current && audioRef.current.currentTime !== next) audioRef.current.currentTime = next;
    setPreparing(false);
    setPlaying(false);
    setT(next);
  }, [duration, fps, preview.pausePlayback, cancelAudioStart]);

  const handleAudioError = (event) => {
    if (reportedAudioError.current || event.currentTarget !== audioRef.current) return;
    reportedAudioError.current = true;
    const kind = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported' }[event.currentTarget.error?.code] || 'unknown';
    console.error(`❌ Generated preview audio failed (${kind})`);
    stopPlayback();
    setAudioError('The song audio could not be played. Check the file or connection, then retry the preview.');
  };

  const playFrom = useCallback((time) => {
    const audio = audioRef.current;
    if (!audio || !preview.ready) return;
    cancelAudioStart();
    const generation = ++intent.current;
    const live = () => mounted.current && generation === intent.current && wantsPlay.current;
    wantsPlay.current = true;
    setAudioError('');
    const failed = (error, stage) => {
      if (!live()) return;
      console.error(`❌ Generated preview failed during ${stage}`);
      stopPlayback(audio.currentTime || time);
      setAudioError(error?.message || 'Audio playback could not start. Retry the preview.');
    };
    const startAudio = (native) => {
      if (!live()) return;
      const clockWindow = [];
      const waiting = native ? { frame: 0, timer: 0 } : null;
      if (waiting) {
        audioStartWait.current = waiting;
        waiting.timer = setTimeout(() => {
          if (audioStartWait.current !== waiting) return;
          cancelAudioStart();
          failed(new Error('The audio clock did not start. Retry the preview.'), 'audio-clock');
        }, 3000);
      }
      const started = audio.play?.();
      if (!native) { setPreparing(false); setPlaying(true); }
      Promise.resolve(started).then(() => {
        if (!live()) return;
        if (!native) { setPlaying(true); return; }
        // play() can resolve while the media clock is still held at startup.
        // Anchor only after its latest 100ms window advances steadily at 1x.
        if (audioStartWait.current !== waiting) return;
        const observe = () => {
          if (audioStartWait.current !== waiting) return;
          if (!live()) { cancelAudioStart(); return; }
          const actualTime = audio.currentTime;
          const observedAt = performance.now();
          const previous = clockWindow.at(-1);
          if (audio.paused || audio.seeking || !Number.isFinite(actualTime) || (previous && actualTime < previous.t)) {
            clockWindow.length = 0;
          } else {
            clockWindow.push({ t: actualTime, at: observedAt });
            // Retain the newest window that still spans at least 100ms.
            while (clockWindow.length > 1 && observedAt - clockWindow[1].at >= 100) clockWindow.shift();
            const spanMs = observedAt - clockWindow[0].at;
            if (spanMs >= 100) {
              let advances = 0;
              for (let i = 1; i < clockWindow.length; i += 1) {
                if (clockWindow[i].t > clockWindow[i - 1].t) advances += 1;
              }
              const slope = (actualTime - clockWindow[0].t) / (spanMs / 1000);
              if (advances >= 2 && slope >= 0.95 && slope <= 1.05) {
                cancelAudioStart();
                nativePlaying.current = true;
                preview.startPlayback(actualTime);
                setPreparing(false);
                setPlaying(true);
                return;
              }
            }
          }
          waiting.frame = requestAnimationFrame(observe);
        };
        observe();
      }).catch((error) => failed(error, 'audio-start'));
    };
    if (preview.playback) {
      audio.pause?.();
      nativePlaying.current = false;
      setPlaying(false);
      setPreparing(true);
      preview.preparePlayback(time).then((native) => { if (live() && native !== null) startAudio(native); }).catch((error) => failed(error, 'native-prepare'));
    } else startAudio(false);
  }, [mounted, preview.ready, preview.playback, preview.preparePlayback, preview.startPlayback, stopPlayback, cancelAudioStart]);
  playFromRef.current = playFrom;

  const seek = useCallback((time) => {
    const next = Math.min(Math.max(0, time), Math.max(0, duration - 1 / fps));
    const restart = preview.playback && wantsPlay.current;
    if (restart) {
      intent.current += 1;
      audioRef.current?.pause?.();
      nativePlaying.current = false;
      setPlaying(false);
    }
    setT(next);
    preview.seek(next);
    if (audioRef.current && audioRef.current.currentTime !== next) audioRef.current.currentTime = next;
    if (restart) playFromRef.current?.(next);
  }, [duration, fps, preview.seek, preview.playback]);

  useEffect(() => {
    if (preview.ready && playbackSession.current === preview.sessionId) return;
    playbackSession.current = preview.sessionId;
    cancelAudioStart();
    intent.current += 1;
    wantsPlay.current = false;
    nativePlaying.current = false;
    audioRef.current?.pause?.();
    setPreparing(false);
    setPlaying(false);
  }, [preview.ready, preview.sessionId, cancelAudioStart]);

  useEffect(() => {
    if (!seekRequest || duration <= 0 || appliedSeek.current === seekRequest.n) return;
    appliedSeek.current = seekRequest.n;
    stopPlayback(seekRequest.t);
    if (seekRequest.play) playFromRef.current?.(audioRef.current?.currentTime || 0);
  }, [seekRequest, duration, stopPlayback]);

  useEffect(() => {
    if (!playing) return undefined;
    let handle = 0;
    let posted = -1;
    let anchored = performance.now();
    const tick = () => {
      if (!wantsPlay.current) return;
      const time = audioRef.current?.currentTime || 0;
      const frameIndex = Math.floor(time * fps + 1e-9);
      if (frameIndex !== posted) {
        posted = frameIndex;
        setT(time);
        if (!nativePlaying.current) preview.seek(time, { playing: true });
      }
      if (nativePlaying.current && performance.now() - anchored >= 250) {
        anchored = performance.now();
        preview.syncPlayback(time);
      }
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, fps, preview.seek, preview.syncPlayback]);


  useEffect(() => {
    if (!preview.playbackResync || !wantsPlay.current) return;
    if (preview.playbackResyncReason !== 'controls') {
      const now = performance.now();
      resyncs.current = resyncs.current.filter((at) => now - at < 10000);
      if (resyncs.current.length >= 3) {
        console.error('❌ Generated preview repeatedly lost audio synchronization');
        stopPlayback();
        setAudioError('Native preview repeatedly lost synchronization. Retry the preview.');
        return;
      }
      resyncs.current.push(now);
    }
    playFromRef.current?.(audioRef.current?.currentTime || 0);
  }, [preview.playbackResync, preview.playbackResyncReason, stopPlayback]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden' && wantsPlay.current) stopPlayback(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAudioStart();
      intent.current += 1;
      wantsPlay.current = false;
      audioRef.current?.pause?.();
    };
  }, [stopPlayback, cancelAudioStart]);

  const togglePlay = () => {
    if (playing || preparing) stopPlayback();
    else {
      if (audioRef.current?.ended) stopPlayback();
      playFrom(audioRef.current?.currentTime || 0);
    }
  };

  const retryPreview = () => {
    stopPlayback();
    const audio = audioRef.current;
    const reloadAudio = reportedAudioError.current && audio;
    reportedAudioError.current = false;
    setAudioError('');
    if (reloadAudio) {
      const position = audio.currentTime;
      audio.load();
      // Setting currentTime before metadata arrives preserves the requested start position.
      audio.currentTime = position;
    }
    preview.resume();
  };
  return { duration, fps, t, playing, preparing, audioError, stopPlayback, seek, togglePlay,
    retryPreview, audioRef, handleAudioError };
}
