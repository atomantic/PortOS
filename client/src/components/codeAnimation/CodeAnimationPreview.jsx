import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Download, FileCode2, LoaderCircle, Save } from 'lucide-react';
import { Link } from 'react-router';
import toast from '../ui/Toast';
import { uploadGalleryVideo } from '../../services/api';
import { readFileAsBase64 } from '../../utils/fileUpload';
import { downloadBlob } from '../../lib/downloadBlob';

// Seconds past the film's own duration before a silent recording is abandoned
// (a page that never answers the handshake must not leave Record spinning).
const RECORD_GRACE_SECONDS = 30;

const BUTTON_PRIMARY = 'inline-flex items-center gap-2 rounded-lg bg-port-accent px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40';
const BUTTON_SECONDARY = 'inline-flex items-center gap-2 rounded-lg border border-port-border px-3 py-1.5 text-sm text-gray-200 hover:border-port-accent disabled:cursor-not-allowed disabled:opacity-40';

const slug = (text) => (text || 'code-animation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'code-animation';

// Set the audio global BEFORE any page script runs: right after <head>, or at
// the very top when the document has none. `<` is escaped so no value can
// close the script element early.
const scriptLiteral = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
const ANIMATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join('; ');

export function prepareAnimationHtml(html, globalName, audioDataUrl) {
  if (!html) return html;
  const policy = `<meta http-equiv="Content-Security-Policy" content="${ANIMATION_CSP}">`;
  const audio = audioDataUrl
    ? `<script>window[${scriptLiteral(globalName)}] = ${scriptLiteral(audioDataUrl)};</script>`
    : '';
  const head = html.match(/<head[^>]*>/i);
  if (!head) return `${policy}${audio}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${policy}${audio}${html.slice(at)}`;
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Failed to read the audio track'));
  reader.readAsDataURL(blob);
});

/**
 * Runs a generated code animation in an opaque-origin sandboxed iframe. Its
 * CSP permits the inline code and local media the film needs, while blocking
 * network-backed subresources, fetch/websocket, and form submissions. Browser
 * sandboxing still permits the frame to navigate itself, so this is not a
 * complete network isolation boundary for arbitrary hostile HTML. It also drives
 * the prompt's recording handshake: Record posts `messages.record`, the page
 * answers with the WebM Blob, which can be downloaded or saved to the shared
 * video gallery.
 *
 * The opaque-origin frame cannot fetch `/api/uploads/*` itself, so the audio
 * track is read here and handed over as a data URL through the audio global.
 */
export default function CodeAnimationPreview({ html, audioUrl, messages, audioGlobal, frame, title }) {
  const iframeRef = useRef(null);
  // A generated page receives the selected track only after an explicit choice.
  // Tie that choice to the URL so a changed track needs fresh consent.
  const [audioDecision, setAudioDecision] = useState(() => ({
    url: audioUrl,
    choice: audioUrl ? null : 'none',
  }));
  const audioChoice = audioDecision.url === audioUrl
    ? audioDecision.choice
    : (audioUrl ? null : 'none');
  // status: consent | none | loading | ready | failed; dataUrl is set only when ready.
  const [audio, setAudio] = useState({ status: audioUrl ? 'consent' : 'none', dataUrl: null });
  const [meta, setMeta] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  const [video, setVideo] = useState(null);
  const [saving, setSaving] = useState(false);
  const recordTimerRef = useRef(null);

  useEffect(() => {
    let active = true;
    if (!audioUrl) {
      setAudio({ status: 'none', dataUrl: null });
      return () => { active = false; };
    }
    if (audioChoice !== 'with-audio') {
      setAudio({ status: audioChoice === 'without-audio' ? 'none' : 'consent', dataUrl: null });
      return () => { active = false; };
    }
    setAudio({ status: 'loading', dataUrl: null });
    fetch(audioUrl, { credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error(`Audio track unavailable (${res.status})`);
        return res.blob();
      })
      .then(blobToDataUrl)
      .then((dataUrl) => {
        if (active) setAudio({ status: 'ready', dataUrl });
      })
      .catch((error) => {
        if (!active) return;
        setAudio({ status: 'failed', dataUrl: null });
        toast.error(error.message);
      });
    return () => { active = false; };
  }, [audioUrl, audioChoice]);

  // Hold the frame back until the audio is in hand so the page boots once,
  // with its audio global already set.
  const srcDoc = useMemo(() => {
    if (!html || audioChoice == null || audio.status === 'loading') return null;
    return prepareAnimationHtml(html, audioGlobal, audio.dataUrl);
  }, [html, audioGlobal, audioChoice, audio]);

  useEffect(() => {
    clearTimeout(recordTimerRef.current);
    setMeta(null);
    setRecording(false);
    setVideo(null);
  }, [srcDoc]);

  // Keyed on the URL, not the object: marking a video saved replaces the
  // object but keeps its URL alive.
  const videoUrl = video?.url;
  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => () => clearTimeout(recordTimerRef.current), []);

  useEffect(() => {
    if (!messages) return undefined;
    const onMessage = (event) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === messages.ready) setMeta(data.meta && typeof data.meta === 'object' ? data.meta : {});
      if (data.type === messages.progress && Number.isFinite(data.t)) setRecordProgress(data.t);
      if (data.type === messages.recorded && data.blob instanceof Blob) {
        clearTimeout(recordTimerRef.current);
        setRecording(false);
        setVideo({ blob: data.blob, url: URL.createObjectURL(data.blob), saved: false });
      }
      if (data.type === messages.error) {
        clearTimeout(recordTimerRef.current);
        setRecording(false);
        toast.error(`Animation error: ${String(data.message || 'unknown error').slice(0, 300)}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [messages]);

  const duration = Number(meta?.duration) || frame?.durationSeconds || 0;
  const fileBase = slug(title);

  const handleRecord = () => {
    const target = iframeRef.current?.contentWindow;
    if (!target || recording) return;
    setRecording(true);
    setRecordProgress(0);
    target.postMessage({ type: messages.record }, '*');
    clearTimeout(recordTimerRef.current);
    recordTimerRef.current = setTimeout(() => {
      setRecording(false);
      toast.error('The animation never returned a recording — its code may not implement the record handshake.');
    }, (duration + RECORD_GRACE_SECONDS) * 1_000);
  };

  const handleSave = async () => {
    if (!video || video.saved || saving) return;
    setSaving(true);
    const base64 = await readFileAsBase64(video.blob).catch(() => null);
    const saved = base64
      ? await uploadGalleryVideo(base64, `${fileBase}.webm`, { silent: true }).catch((error) => {
        toast.error(error.message || 'Failed to save the video');
        return null;
      })
      : null;
    setSaving(false);
    if (saved?.id) {
      setVideo((current) => (current?.blob === video.blob ? { ...current, saved: true } : current));
      toast.success('Saved to Media History');
    }
  };

  if (!html) return null;

  const aspect = frame?.width && frame?.height ? `${frame.width} / ${frame.height}` : '16 / 9';

  return (
    <section className="space-y-3" aria-label="Animation preview">
      <div className="overflow-hidden rounded-lg border border-port-border bg-black" style={{ aspectRatio: aspect, maxHeight: '70vh' }}>
        {srcDoc ? (
          <iframe
            ref={iframeRef}
            title="Code animation preview"
            // No allow-same-origin: generated code has an opaque origin. The
            // injected CSP also blocks network resource and connection APIs.
            sandbox="allow-scripts allow-downloads"
            allow="autoplay"
            srcDoc={srcDoc}
            className="h-full w-full border-0"
          />
        ) : audioChoice == null ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
            <h3 className="text-base font-semibold text-white">Preview paused</h3>
            <p className="max-w-xl text-sm text-gray-200">
              Choose whether to run this generated animation with its selected audio track. The preview is paused until you choose.
              The animation can navigate itself, so its code could send that track outside PortOS. Continue only if you trust it.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => setAudioDecision({ url: audioUrl, choice: 'without-audio' })}
                className={BUTTON_SECONDARY}
              >
                Preview without audio
              </button>
              <button
                type="button"
                onClick={() => setAudioDecision({ url: audioUrl, choice: 'with-audio' })}
                className={BUTTON_PRIMARY}
              >
                Run with audio
              </button>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-400">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading audio track…
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleRecord}
          disabled={!srcDoc || recording}
          className="inline-flex items-center gap-2 rounded-lg bg-port-error/90 px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {recording ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Circle className="h-4 w-4 fill-current" />}
          {recording ? `Recording ${Math.floor(recordProgress)}s / ${Math.round(duration)}s` : 'Record video'}
        </button>
        <button
          type="button"
          onClick={() => downloadBlob(html, `${fileBase}.html`, 'text/html')}
          className={BUTTON_SECONDARY}
        >
          <FileCode2 className="h-4 w-4" /> Download HTML
        </button>
        <span className="text-xs text-gray-500">
          {meta ? 'Animation ready' : 'Waiting for the animation to report ready…'}
          {audio.status === 'failed' ? ' · audio track failed to load' : ''}
        </span>
      </div>

      {video && (
        <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
          <video src={video.url} controls className="max-h-80 w-full rounded bg-black" aria-label="Recorded animation" />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => downloadBlob(video.blob, `${fileBase}.webm`)}
              className={BUTTON_SECONDARY}
            >
              <Download className="h-4 w-4" /> Download WebM
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || video.saved}
              className={BUTTON_PRIMARY}
            >
              {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {video.saved ? 'Saved' : 'Save to Media History'}
            </button>
            {video.saved && (
              <Link to="/media/history" className="text-xs text-port-accent hover:underline">Open Media History</Link>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
