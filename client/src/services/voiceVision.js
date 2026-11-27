/** Manage user-authorized screen sharing and send requested screenshot frames to the voice server. */

import socket from './socket';
import { sleep } from '../utils/sleep.js';
import { MAX_VOICE_AUDIO_BYTES } from '../lib/audioRecorder.js';

// Persistent, user-authorized screen-capture stream for the voice agent's
// ui_describe_visually tool. getDisplayMedia is the only browser-native way to
// grab WebGL/canvas content (OpenWorld, charts) without a heavy DOM-to-canvas
// dependency — but browsers REQUIRE a transient user gesture to call it, and the
// screenshot request is server-initiated (mid voice turn), not a click. So the
// user authorizes a capture stream ONCE via a click (enableVisionCapture, which
// the VoiceWidget wires to a button), we keep that stream alive, and
// captureScreenForVision grabs a frame from it on demand without re-prompting.
let visionStream = null;
// Bumped by every enable/disable/dispose so a getDisplayMedia() picker that
// resolves AFTER teardown can detect it was superseded and release its stream
// (visionStream is still null while the picker is open, so clear can't see it).
let visionGeneration = 0;

export function invalidateVisionCapture() {
  visionGeneration += 1;
}
// Optional callback invoked whenever the authorized stream ends — either via
// disableVisionCapture() or because the user clicked "Stop sharing" in the
// browser's own chrome (track 'ended'). Lets the UI sync its toggle state
// instead of going stale until the next screenshot request.
let onVisionEndedCb = null;

const clearVisionStream = ({ notify = true } = {}) => {
  visionGeneration += 1;
  const stream = visionStream;
  // Null the global BEFORE stopping tracks: t.stop() synchronously fires the
  // track 'ended' handler, and that handler no-ops unless `visionStream === its
  // own stream` — so clearing first keeps a caller-initiated stop (notify:false)
  // from re-entering via the 'ended' path and firing onVisionCaptureEnded.
  visionStream = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (notify && typeof onVisionEndedCb === 'function') onVisionEndedCb();
};

// True when a live, user-authorized capture stream is available to grab frames.
export const isVisionCaptureEnabled = () => !!(visionStream && visionStream.active);

// Register a callback fired when the capture stream ends (user stops sharing via
// the browser, or disableVisionCapture runs). Pass null to clear. Returns an
// unsubscribe fn for symmetry with the other subscribe helpers.
export const onVisionCaptureEnded = (cb) => {
  onVisionEndedCb = typeof cb === 'function' ? cb : null;
  return () => { onVisionEndedCb = null; };
};

// Authorize a screen-capture stream. MUST be called from within a user gesture
// (a click handler) — getDisplayMedia rejects outside transient activation,
// which is exactly why the server-initiated screenshot path can't call it.
// Returns true once a live stream is authorized. The stream self-clears when the
// user stops sharing via the browser's own chrome (track 'ended') so the next
// enable re-prompts instead of grabbing a dead track.
export const enableVisionCapture = async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) return false;
  if (isVisionCaptureEnabled()) return true;
  const generation = ++visionGeneration;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'browser' },
    audio: false,
  }).catch(() => null);
  if (!stream) return false;
  if (generation !== visionGeneration) {
    stream.getTracks().forEach((t) => t.stop());
    return false;
  }
  visionStream = stream;
  // User-stopped (browser chrome) → clear + notify the UI so the toggle flips.
  // Guard on `visionStream === stream` so a late 'ended' from a SUPERSEDED
  // stream (quick disable→re-enable) can't tear down the newer capture session.
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => {
    if (visionStream === stream) clearVisionStream();
  }, { once: true }));
  return true;
};

// Stop and release the authorized capture stream (widget teardown / user
// toggle-off). Caller-initiated, so it does NOT fire onVisionCaptureEnded — the
// caller already owns the state change (and on unmount the cb is gone).
export const disableVisionCapture = () => clearVisionStream({ notify: false });

// Grab one frame from the authorized vision stream as a JPEG data URL. Returns
// null when no stream is authorized yet (the caller prompts the user to enable
// it) or on any frame-grab failure, so ui_describe_visually degrades to a clear
// "I can't see your screen" rather than crashing.
export const captureScreenForVision = async () => {
  if (typeof document === 'undefined' || !isVisionCaptureEnabled()) return null;
  const video = document.createElement('video');
  video.srcObject = visionStream;
  video.muted = true;
  const playing = await video.play().then(() => true).catch(() => false);
  if (!playing) return null;
  // One frame is enough; give the decoder a tick to paint dimensions.
  await sleep(120);
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cctx = canvas.getContext('2d');
  video.pause();
  if (!cctx) return null;
  cctx.drawImage(video, 0, 0, w, h);
  // JPEG @ 0.8 keeps normal tab captures below the encoded 8 MiB cap.
  return canvas.toDataURL('image/jpeg', 0.8);
};

// Reply to a server voice:screenshot:request. Always emits a result (data URL
// or null) so the server-side waiter resolves instead of timing out. Echo the
// requestId so the server resolves the matching waiter and a late reply can't
// satisfy a newer capture.
export const sendScreenshotResult = (requestId, dataUrl) => {
  socket.emit('voice:screenshot:result', { requestId, dataUrl: typeof dataUrl === 'string' && dataUrl.length <= MAX_VOICE_AUDIO_BYTES ? dataUrl : null });
};
