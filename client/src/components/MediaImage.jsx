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
 *   thumbnail?: boolean          — show a gallery PNG's 512px WebP derivative first, `src` as its fallback
 *   fallbackSrc?: string|string[] — originals to try in order if `src` fails (e.g. a thumbnail)
 *   fallbackVideoSrc?: string    — video to preview if its poster is unavailable
 *   assetSrc?: string            — original URL whose filename peer sync reports
 *   alt: string                  — same as <img>
 *   className?: string           — applies to BOTH the live <img> and the placeholder wrapper
 *   placeholderClassName?: string — extra classes for the placeholder only
 *   ...rest                       — forwarded to <img>
 *
 * After every supplied image/video source fails, show a "Syncing" placeholder.
 * Image errors don't expose HTTP status, so the component cannot distinguish
 * a missing file from a network drop. An asset-arrived event retries the sources.
 */

import { useEffect, useRef, useState } from 'react';
import { Cloud } from 'lucide-react';
import socket from '../services/socket';
import { imageThumbnailSrc } from '../lib/imageThumbnailSrc';

// Peer sync reports the decoded on-disk name, so decode an encoded URL segment.
function basenameOf(src) {
  if (typeof src !== 'string') return null;
  const last = src.split('/').pop();
  const bare = last ? last.split(/[?#]/)[0] : '';
  if (!bare) return null;
  try { return decodeURIComponent(bare); } catch { return bare; }
}

function cacheBust(src, nonce) {
  if (!nonce) return src;
  const [path, ...fragment] = src.split('#');
  return `${path}${path.includes('?') ? '&' : '?'}_t=${nonce}${fragment.length ? `#${fragment.join('#')}` : ''}`;
}

export default function MediaImage({
  src,
  thumbnail = false,
  fallbackSrc,
  fallbackVideoSrc,
  assetSrc = src,
  alt = '',
  className = '',
  placeholderClassName = '',
  ...rest
}) {
  const [errored, setErrored] = useState(false);
  const [showVideo, setShowVideo] = useState(false);
  // -1 = `src`; otherwise the index into `fallbacks` currently shown.
  const [fallbackIndex, setFallbackIndex] = useState(-1);
  const thumbSrc = thumbnail ? imageThumbnailSrc(src) : null;
  const firstSrc = thumbSrc || src;
  const fallbacks = [thumbSrc ? src : null, fallbackSrc].flat().filter((f) => typeof f === 'string' && f && f !== firstSrc);
  // Bumping `nonce` forces the <img> to re-fetch (cache-busted) when the
  // socket says our asset arrived — without it the browser would serve the
  // cached 404 forever.
  const [nonce, setNonce] = useState(0);
  // Only a served `/data/` asset (local or on a peer's origin) can arrive from a
  // peer; an external or inline URL that fails keeps the browser's broken image.
  const tracksPeerAsset = typeof assetSrc === 'string' && /^(?:https?:\/\/[^/]+)?\/data\//i.test(assetSrc);
  const filename = tracksPeerAsset ? basenameOf(assetSrc) : null;
  const filenameRef = useRef(filename);
  filenameRef.current = filename;

  // Reset the error flag when `src` changes — a new record may reference a
  // different filename that we DO have locally.
  useEffect(() => {
    setErrored(false);
    setShowVideo(false);
    setFallbackIndex(-1);
    setNonce(0);
  }, [src, assetSrc, fallbackVideoSrc]);

  // Listen for the receiver's asset-arrived event. Match on filename only
  // (kind is implicit from the directory in the src URL) so the listener
  // doesn't need to know which `/data/{images,image-refs,videos}/` slot the
  // src belongs to.
  useEffect(() => {
    if (!filename) return;
    const handler = (payload) => {
      if (payload?.filename === filenameRef.current) {
        setErrored(false);
        setShowVideo(false);
        setFallbackIndex(-1);
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

  if (fallbackVideoSrc && (showVideo || !src)) {
    const videoSrc = cacheBust(fallbackVideoSrc, nonce);
    return (
      <video
        src={videoSrc.includes('#') ? videoSrc : `${videoSrc}#t=0.001`}
        aria-label={alt}
        className={className}
        preload="metadata"
        muted
        playsInline
        onError={() => setErrored(true)}
      />
    );
  }

  // The cache-buster appears only after the first arrival event; the very
  // first load (before any 404) uses the bare src so HTTP caching still
  // works the way the rest of the UI expects.
  const displaySrc = fallbacks[fallbackIndex] ?? firstSrc;
  const cacheBustedSrc = cacheBust(displaySrc, nonce);
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
        // A peer running an older release may reject poster requests while
        // still allowing the original image or video to be streamed.
        if (fallbackIndex + 1 < fallbacks.length) setFallbackIndex(fallbackIndex + 1);
        else if (fallbackVideoSrc) setShowVideo(true);
        else if (tracksPeerAsset) setErrored(true);
        callerOnError?.(e);
      }}
    />
  );
}
