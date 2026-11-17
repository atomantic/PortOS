// `useAudioSessionClaim(type)` returns `{ claim, release }` to hold one arbitrated iOS audio session
// slot for surfaces owning their own AudioContext or mic stream.
//
// One `acquireAudioSession(type)` slot with a React lifecycle, for a surface owning its OWN `AudioContext` (MorseTrainer, the Security monitor) or `getUserMedia` stream (`useSingToScore`/`useSingToVerify`);
// output-only players pass `audioSession: 'playback'` to `createLookaheadTransport` instead. Why the session is arbitrated is in the audio-session note in `lib/audioContext.js`.
// - ONE claim slot per hook instance: `claim()` releases whatever this instance held before taking a fresh one, so a re-entered play/capture can't strand a holder and pin the document.
// - `release()` is idempotent, so every teardown path can call it.
// - Unmount releases too, the backstop for a lifecycle ending without its normal teardown (a per-mount AudioContext close()d mid-play never fires the `onended` that would release).
// Both callbacks are referentially stable, safe in effect dep lists.

import { useCallback, useEffect, useRef } from 'react';
import { acquireAudioSession } from '../lib/audioContext.js';

/**
 * @param {'playback'|'play-and-record'} type — `'playback'` for an output-only
 *   surface (the iPhone ring/silent switch can't mute it, but it REFUSES
 *   capture); `'play-and-record'` for the window a mic stream is open.
 * @returns {{ claim: () => void, release: () => void }}
 */
export default function useAudioSessionClaim(type) {
  const releaseRef = useRef(null);

  const release = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const claim = useCallback(() => {
    release();
    releaseRef.current = acquireAudioSession(type);
  }, [release, type]);

  // `release` is stable, so this cleanup runs exactly once, on unmount.
  useEffect(() => release, [release]);

  return { claim, release };
}
