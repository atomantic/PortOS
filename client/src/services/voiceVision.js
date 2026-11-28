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
// captureVisionFrame grabs a frame from it on demand without re-prompting.
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

// Tell the server whether a tab is being shared: while it is, every voice turn
// attaches a fresh frame (when the screen changed), so the agent sees what the
// user is asking about without having to decide to call a tool. Re-sent on
// reconnect because the server keeps it per socket.
const reportSharing = () => socket.emit('voice:vision:state', { live: isVisionCaptureEnabled() });
let reconnectReportBound = false;
const bindReconnectReport = () => {
  if (reconnectReportBound) return;
  reconnectReportBound = true;
  socket.on('connect', () => { if (isVisionCaptureEnabled()) reportSharing(); });
};

const clearVisionStream = ({ notify = true } = {}) => {
  visionGeneration += 1;
  const stream = visionStream;
  const wasSharing = !!stream;
  // Null the global BEFORE stopping tracks: t.stop() synchronously fires the
  // track 'ended' handler, and that handler no-ops unless `visionStream === its
  // own stream` — so clearing first keeps a caller-initiated stop (notify:false)
  // from re-entering via the 'ended' path and firing onVisionCaptureEnded.
  visionStream = null;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (wasSharing) reportSharing();
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
  bindReconnectReport();
  reportSharing();
  return true;
};

// Stop and release the authorized capture stream (widget teardown / user
// toggle-off). Caller-initiated, so it does NOT fire onVisionCaptureEnded — the
// caller already owns the state change (and on unmount the cb is gone).
export const disableVisionCapture = () => clearVisionStream({ notify: false });

// Long edge of an image sent for description. Vision models downscale large
// inputs anyway; this keeps frames and photos well under the socket cap.
const MAX_IMAGE_EDGE = 1600;
// Side of the grayscale thumbnail the server compares to skip an unchanged
// screen (16x16 = the server's FRAME_SIGNATURE_LENGTH).
const SIGNATURE_SIDE = 16;

const fitWithin = (w, h) => {
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
};

// Draw a source (video frame or image) scaled to fit, as a JPEG data URL.
const encodeScaled = (source, w, h) => {
  const { width, height } = fitWithin(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const cctx = canvas.getContext('2d');
  if (!cctx) return null;
  cctx.drawImage(source, 0, 0, width, height);
  return { canvas, dataUrl: canvas.toDataURL('image/jpeg', 0.8) };
};

const frameSignature = (canvas) => {
  const small = document.createElement('canvas');
  small.width = SIGNATURE_SIDE;
  small.height = SIGNATURE_SIDE;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  if (!sctx?.getImageData) return null;
  sctx.drawImage(canvas, 0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
  const { data } = sctx.getImageData(0, 0, SIGNATURE_SIDE, SIGNATURE_SIDE);
  const out = [];
  for (let i = 0; i < data.length; i += 4) out.push(Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]));
  return out;
};

// Grab one frame from the authorized stream as { dataUrl, signature }, or null
// when no stream is authorized or the grab failed, so the server degrades to
// "I can't see your screen" rather than crashing.
export const captureVisionFrame = async () => {
  if (typeof document === 'undefined' || !isVisionCaptureEnabled()) return null;
  const video = document.createElement('video');
  video.srcObject = visionStream;
  video.muted = true;
  const playing = await video.play().then(() => true).catch(() => false);
  if (!playing) return null;
  // One frame is enough; give the decoder a tick to paint dimensions.
  await sleep(120);
  const encoded = encodeScaled(video, video.videoWidth || 1280, video.videoHeight || 720);
  video.pause();
  if (!encoded) return null;
  return { dataUrl: encoded.dataUrl, signature: frameSignature(encoded.canvas) };
};

// Read an image file the user picked as a scaled JPEG data URL, or null when
// the browser can't decode it.
export const imageFileToDataUrl = async (file) => {
  if (typeof document === 'undefined' || !file) return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    const loaded = await img.decode().then(() => true).catch(() => false);
    if (!loaded) return null;
    return encodeScaled(img, img.naturalWidth || 1, img.naturalHeight || 1)?.dataUrl || null;
  } finally {
    URL.revokeObjectURL(url);
  }
};

let imageSeq = 0;
// Queue an image for the voice agent's next turn. The server describes it with
// a vision model and reports progress on `voice:image`. Returns the chip id.
export const attachVoiceImage = ({ dataUrl, source = 'upload', name }) => {
  imageSeq += 1;
  const id = `img_${Date.now().toString(36)}_${imageSeq}`;
  socket.emit('voice:image:attach', { id, dataUrl, source, name });
  return id;
};

export const removeVoiceImage = (id) => socket.emit('voice:image:remove', { id });

// Reply to a server voice:screenshot:request. Always emits a result (frame
// or null) so the server-side waiter resolves instead of timing out. Echo the
// requestId so the server resolves the matching waiter and a late reply can't
// satisfy a newer capture.
export const sendScreenshotResult = (requestId, frame) => {
  const dataUrl = typeof frame === 'string' ? frame : frame?.dataUrl;
  const ok = typeof dataUrl === 'string' && dataUrl.length <= MAX_VOICE_AUDIO_BYTES;
  socket.emit('voice:screenshot:result', {
    requestId,
    dataUrl: ok ? dataUrl : null,
    ...(ok && Array.isArray(frame?.signature) ? { signature: frame.signature } : {}),
  });
};
