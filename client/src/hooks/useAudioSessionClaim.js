// useAudioSessionClaim — hold the document's iOS audio session for a surface
// that owns its OWN AudioContext or `getUserMedia` stream, rather than driving
// the shared lookahead transport (output-only players get the same behavior for
// free by passing `audioSession: 'playback'` to `createLookaheadTransport`).
//
// What the session is and why it is arbitrated rather than assigned is in the
// audio-session note in `lib/audioContext.js`. This hook is just the React
// lifecycle around one `acquireAudioSession` claim:
//
// - ONE claim slot per hook instance. `claim()` hands back whatever this
//   instance was already holding before taking a fresh one, so a re-entered
//   play/capture can't strand a holder in the arbiter and pin the document.
// - `release()` is idempotent, so every teardown path can call it without
//   coordinating (the same contract `acquireAudioSession`'s release has).
// - The claim is released on UNMOUNT too. That is the backstop for a lifecycle
//   that ends without its normal teardown — a per-mount AudioContext close()d
//   out from under an in-flight play never fires the `onended` that would
//   otherwise release, and a stranded holder pins the page output-only (or
//   record-capable) for the rest of the SPA session.
//
// Both callbacks are referentially stable, so they are safe in an effect dep
// list and in a `useCallback` that must not re-create per render.

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
