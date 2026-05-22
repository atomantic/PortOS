/**
 * <MediaImage> — wraps <img> with graceful handling for assets that haven't
 * arrived yet from a federated peer.
 *
 * When a peer pushes us a universe / series, we accept the record immediately
 * but background-pull the referenced assets via HTTP from the sender's static
 * mount (see server/services/sharing/peerSync.js `pullMissingAssetsFromPeer`).
 * Until each asset lands, `<img src="/data/images/uuid.png">` 404s. This
 * component intercepts that 404 and shows a "syncing" placeholder instead of
 * the browser's broken-image icon, then auto-swaps to the live image the
 * moment the receiver's worker reports it arrived (via the
 * `peerSync:asset-arrived` socket event).
 *
 * Props:
 *   src: string                  — same as <img>; expected to be `/data/...`
 *   alt: string                  — same as <img>
 *   className?: string           — applies to BOTH the live <img> and the placeholder wrapper
 *   placeholderClassName?: string — extra classes for the placeholder only
 *   ...rest                       — forwarded to <img>
 *
 * The component renders the "Syncing" placeholder on ANY image load failure
 * — the browser's <img onError> doesn't expose the HTTP status, so we can't
 * actually distinguish a 404 from a network drop. That's intentional: the
 * placeholder accurately describes the user-visible state ("this asset is
 * not loadable right now") whether the cause is "peer hasn't pushed it yet"
 * or "network is down." The `peerSync:asset-arrived` listener still gates
 * the swap-back, so a permanent network error doesn't lock the placeholder
 * on forever — the live image returns whenever the path is reachable again
 * (e.g. on the next push that triggers a re-fetch via the socket event).
 */

import { useEffect, useRef, useState } from 'react';
import { Cloud } from 'lucide-react';
import socket from '../services/socket';

function basenameOf(src) {
  if (typeof src !== 'string') return null;
  const last = src.split('/').pop();
  if (!last) return null;
  return last.split('?')[0] || null;
}

export default function MediaImage({
  src,
  alt = '',
  className = '',
  placeholderClassName = '',
  ...rest
}) {
  const [errored, setErrored] = useState(false);
  // Bumping `nonce` forces the <img> to re-fetch (cache-busted) when the
  // socket says our asset arrived — without it the browser would serve the
  // cached 404 forever.
  const [nonce, setNonce] = useState(0);
  const filename = basenameOf(src);
  const filenameRef = useRef(filename);
  filenameRef.current = filename;

  // Reset the error flag when `src` changes — a new record may reference a
  // different filename that we DO have locally.
  useEffect(() => {
    setErrored(false);
    setNonce(0);
  }, [src]);

  // Listen for the receiver's asset-arrived event. Match on filename only
  // (kind is implicit from the directory in the src URL) so the listener
  // doesn't need to know which `/data/{images,image-refs,videos}/` slot the
  // src belongs to.
  useEffect(() => {
    if (!filename) return;
    const handler = (payload) => {
      if (payload?.filename === filenameRef.current) {
        setErrored(false);
        setNonce((n) => n + 1);
      }
    };
    socket.on('peerSync:asset-arrived', handler);
    return () => socket.off('peerSync:asset-arrived', handler);
  }, [filename]);

  if (errored) {
    return (
      <div
        className={`flex items-center justify-center bg-port-bg border border-port-border/40 rounded text-gray-500 ${className} ${placeholderClassName}`}
        title={`Asset pending: ${filename || src}`}
      >
        <Cloud size={16} className="opacity-50" />
        <span className="ml-2 text-[10px] uppercase tracking-wider">Syncing</span>
      </div>
    );
  }

  // The cache-buster appears only after the first arrival event; the very
  // first load (before any 404) uses the bare src so HTTP caching still
  // works the way the rest of the UI expects.
  const cacheBustedSrc = nonce > 0 ? `${src}${src.includes('?') ? '&' : '?'}_t=${nonce}` : src;
  // Spread `rest` FIRST so the explicit `onError` below wins over a caller-
  // provided one — we still forward the event by capturing the caller's
  // handler before composing. Putting {...rest} last would silently override
  // setErrored and the placeholder would never appear.
  const callerOnError = rest.onError;
  const { onError: _ignore, ...passthrough } = rest;
  return (
    <img
      {...passthrough}
      src={cacheBustedSrc}
      alt={alt}
      className={className}
      onError={(e) => {
        // The browser doesn't expose the HTTP status to onError, so any load
        // failure flips into the placeholder. The `peerSync:asset-arrived`
        // listener still gates the swap-back, so a permanent network error
        // doesn't lock the placeholder on forever — user-visible state then
        // accurately reflects "asset not loadable right now."
        setErrored(true);
        callerOnError?.(e);
      }}
    />
  );
}
