import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Clapperboard, Download, FileCode2, LoaderCircle } from 'lucide-react';
import { Link } from 'react-router';
import toast from '../ui/Toast';
import { cancelCodeAnimationExport, exportCodeAnimation, getCodeAnimationPackage, getCodeAnimationThreeVendor } from '../../services/api';
import { useSseProgress } from '../../hooks/useSseProgress';
import { downloadBlob } from '../../lib/downloadBlob';
import { importsThree, inlineThreeVendor } from '../../lib/threeVendorImportMap';
import { formatLoudness } from '../../utils/formatters';
import useGeneratedPreview from '../../hooks/useGeneratedPreview.js';
import CodeAnimationTransport from './CodeAnimationTransport';

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

// The vendored three.js modules, read once per session: they are fixed for the
// installed three version.
let threeVendorLoad = null;
const loadThreeVendor = () => {
  threeVendorLoad ??= getCodeAnimationThreeVendor({ silent: true }).then(({ files }) => files).catch((error) => {
    threeVendorLoad = null;
    throw error;
  });
  return threeVendorLoad;
};

// `vendorFiles` (a three-renderer film) inlines the vendored modules as data:
// URLs behind an import map, so the CSP gains `data:` for scripts and nothing else.
export function prepareAnimationHtml(html, globalName, audioDataUrl, vendorFiles = null) {
  if (!html) return html;
  const csp = vendorFiles ? ANIMATION_CSP.replace("script-src 'unsafe-inline'", "script-src 'unsafe-inline' data:") : ANIMATION_CSP;
  const page = vendorFiles ? inlineThreeVendor(html, vendorFiles) : html;
  const policy = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const audio = audioDataUrl
    ? `<script>window[${scriptLiteral(globalName)}] = ${scriptLiteral(audioDataUrl)};</script>`
    : '';
  const head = page.match(/<head[^>]*>/i);
  if (!head) return `${policy}${audio}${page}`;
  const at = head.index + head[0].length;
  return `${page.slice(0, at)}${policy}${audio}${page.slice(at)}`;
}

/**
 * Shows a generated code animation as inert frames from the OS-isolated
 * preview worker. Record asks that worker to run the page's handshake and
 * returns the WebM in slices. Download HTML still inlines three.js for a
 * standalone file; that file is not what the preview executes.
 */
export default function CodeAnimationPreview({ html, audioUrl, messages, audioGlobal, frame, title, jobId }) {
  // A generated page receives the selected track only after an explicit choice.
  // Tie that choice to the URL so a changed track needs fresh consent.
  const [audioDecision, setAudioDecision] = useState(() => ({
    url: audioUrl,
    choice: audioUrl ? null : 'none',
  }));
  const audioChoice = audioDecision.url === audioUrl
    ? audioDecision.choice
    : (audioUrl ? null : 'none');
  const [meta, setMeta] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordProgress, setRecordProgress] = useState(0);
  // The recording as saved to Media History: { id, filename, url }.
  const [video, setVideo] = useState(null);
  const [savingRecording, setSavingRecording] = useState(false);
  const [packageDownloading, setPackageDownloading] = useState(false);
  const recordTimerRef = useRef(null);
  const recordingSessionRef = useRef(null);
  // Frame-exact export runs server-side on the media queue; its progress and
  // result stream from the composition job's SSE channel.
  const [exportJob, setExportJob] = useState(null);
  const [exportNotes, setExportNotes] = useState([]);
  const [exportStarting, setExportStarting] = useState(false);
  const exportRequestRef = useRef(0);
  const exportUrl = exportJob ? `/api/html-composition/${encodeURIComponent(exportJob)}/events` : null;
  const { latest: exportFrame } = useSseProgress(exportUrl, { enabled: !!exportUrl });
  const exportResult = exportFrame?.type === 'complete' ? exportFrame.result : null;
  const exportError = exportFrame?.type === 'error' ? exportFrame.error : null;
  const exporting = !!exportJob && !exportResult && !exportError && exportFrame?.type !== 'canceled';
  const exportPercent = exportFrame?.type === 'progress' ? Math.round((exportFrame.progress || 0) * 100) : 0;

  useEffect(() => {
    if (exportError) toast.error(`Export failed: ${String(exportError).slice(0, 300)}`);
  }, [exportError]);

  useEffect(() => {
    setExportJob(null);
    setExportNotes([]);
    setExportStarting(false);
    return () => { exportRequestRef.current += 1; };
  }, [jobId]);

  // A three-renderer film still needs the vendored modules inlined for Download HTML.
  const needsThree = useMemo(() => importsThree(html), [html]);
  const [threeVendor, setThreeVendor] = useState({ status: 'idle', files: null });
  useEffect(() => {
    let active = true;
    if (!needsThree) {
      setThreeVendor({ status: 'idle', files: null });
      return () => { active = false; };
    }
    setThreeVendor({ status: 'loading', files: null });
    loadThreeVendor()
      .then((files) => { if (active) setThreeVendor({ status: 'ready', files }); })
      .catch((error) => {
        if (!active) return;
        setThreeVendor({ status: 'failed', files: null });
        toast.error(error.message || 'Failed to load the three.js modules');
      });
    return () => { active = false; };
  }, [needsThree]);

  const vendorFiles = needsThree ? threeVendor.files : null;
  const request = useMemo(() => {
    if (!html || audioChoice == null) return null;
    const body = {
      kind: 'code-animation',
      withAudio: audioChoice === 'with-audio',
      audioGlobal,
      revision: `${jobId || 'pasted'}:${audioChoice}:${html.length}`,
    };
    if (jobId) body.jobId = jobId;
    else body.html = html;
    if (audioChoice === 'with-audio' && audioUrl) body.audioUrl = audioUrl;
    // Fit the renderer's bounds with one scale so portrait and square canvases
    // retain their composition instead of stretching each axis independently.
    const scale = Math.min(1, 1920 / (frame?.width || 1920), 1080 / (frame?.height || 1080));
    if (frame?.width) body.width = Math.round(frame.width * scale);
    if (frame?.height) body.height = Math.round(frame.height * scale);
    return body;
  }, [html, audioChoice, audioGlobal, jobId, audioUrl, frame]);
  const preview = useGeneratedPreview({ active: !!request, request });

  useEffect(() => {
    clearTimeout(recordTimerRef.current);
    setMeta(null);
    setRecording(false);
    setSavingRecording(false);
    setVideo(null);
  }, [request]);

  useEffect(() => () => clearTimeout(recordTimerRef.current), []);

  useEffect(() => {
    if (!recording || (preview.ready && preview.sessionId === recordingSessionRef.current)) return;
    clearTimeout(recordTimerRef.current);
    setRecording(false);
    toast.error('The preview stopped before recording finished. Start a new recording to try again.');
  }, [recording, preview.ready, preview.sessionId]);

  useEffect(() => {
    const event = preview.lastEvent;
    if (!event || !messages) return;
    if (event.type === messages.ready) setMeta(event.meta && typeof event.meta === 'object' ? event.meta : {});
    if (event.type === messages.progress && Number.isFinite(event.t)) setRecordProgress(event.t);
    if (event.type === messages.error) {
      clearTimeout(recordTimerRef.current);
      setRecording(false);
      toast.error(`Animation error: ${String(event.message || 'unknown error').slice(0, 300)}`);
    }
  }, [preview.lastEvent, messages]);

  useEffect(() => {
    const saved = preview.recording;
    if (!saved) { setSavingRecording(false); return; }
    clearTimeout(recordTimerRef.current);
    setRecording(false);
    setSavingRecording(saved.status === 'saving');
    if (saved.status === 'saved') setVideo(saved.video);
    if (saved.status === 'failed') toast.error(saved.message);
  }, [preview.recording]);

  const duration = Number(meta?.duration) || frame?.durationSeconds || 0;
  const fps = Number(meta?.fps) || frame?.fps || 24;
  const fileBase = slug(title);

  const handleRecord = () => {
    if (!preview.ready || recording || savingRecording || !messages?.record) return;
    recordingSessionRef.current = preview.sessionId;
    setRecording(true);
    setRecordProgress(0);
    preview.command('record', { message: { type: messages.record }, title: title || '' });
    clearTimeout(recordTimerRef.current);
    recordTimerRef.current = setTimeout(() => {
      setRecording(false);
      toast.error('The animation never returned a recording — its code may not implement the record handshake.');
    }, (duration + RECORD_GRACE_SECONDS) * 1_000);
  };

  const handleExport = async () => {
    if (!jobId || exporting || exportStarting) return;
    const request = ++exportRequestRef.current;
    setExportStarting(true);
    const queued = await exportCodeAnimation(jobId, { silent: true }).catch((error) => {
      if (request === exportRequestRef.current) toast.error(error.message || 'Failed to start the export');
      return null;
    });
    if (request !== exportRequestRef.current) return;
    setExportStarting(false);
    if (!queued?.jobId) return;
    setExportNotes(queued.notes || []);
    for (const note of queued.notes || []) toast(note);
    setExportJob(queued.jobId);
  };

  const handleDownloadPackage = async () => {
    if (!jobId || packageDownloading) return;
    setPackageDownloading(true);
    const pkg = await getCodeAnimationPackage(jobId, { silent: true }).catch((error) => {
      toast.error(error.message || 'Failed to download the package');
      return null;
    });
    setPackageDownloading(false);
    if (pkg) downloadBlob(JSON.stringify(pkg, null, 2), `${fileBase}.code-animation.json`, 'application/json');
  };

  // A three film imports bare names the host's import map resolves, so the
  // saved file carries the vendored modules inline and runs on its own.
  const handleDownloadHtml = () => {
    if (needsThree && !vendorFiles) return toast.error('The three.js modules are still loading; try again in a moment.');
    downloadBlob(vendorFiles ? inlineThreeVendor(html, vendorFiles) : html, `${fileBase}.html`, 'text/html');
  };

  if (!html) return null;

  const aspect = frame?.width && frame?.height ? `${frame.width} / ${frame.height}` : '16 / 9';

  return (
    <section className="space-y-3" aria-label="Animation preview">
      <div className="overflow-hidden rounded-lg border border-port-border bg-black" style={{ aspectRatio: aspect, maxHeight: '70vh' }}>
        {request ? (
          preview.frameUrl ? (
            <img ref={preview.imageRef} onLoad={preview.onFrameLoad} title="Code animation preview" alt="" src={preview.frameUrl} className="h-full w-full border-0 object-contain" />
          ) : (
            <div className="flex h-full items-center justify-center gap-2 p-5 text-center text-sm text-gray-400">
              {preview.status === 'unavailable' || preview.status === 'error'
                ? (preview.reason || 'Isolated preview is unavailable on this host. Generated HTML is not run in this browser.')
                : <><LoaderCircle className="h-4 w-4 animate-spin" /> Building the isolated preview…</>}
            </div>
          )
        ) : audioChoice == null ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-5 text-center">
            <h3 className="text-base font-semibold text-white">Preview paused</h3>
            <p className="max-w-xl text-sm text-gray-200">
              Choose whether to run this generated animation with its selected audio track. The preview is paused until you choose.
              It runs in an isolated local renderer on this machine. Choosing audio does not publish the track.
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
            {needsThree && threeVendor.status === 'failed'
              ? 'The three.js modules could not be loaded; reload the page to retry.'
              : <><LoaderCircle className="h-4 w-4 animate-spin" /> Loading three.js…</>}
          </div>
        )}
      </div>

      {request && (
        <CodeAnimationTransport preview={preview} duration={duration} fps={fps} audioUrl={audioUrl}
          disabled={recording} label={title || ''} />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {request && preview.status === 'idle' && <button type="button" className={BUTTON_SECONDARY} onClick={preview.resume}>Resume preview</button>}
        <button
          type="button"
          onClick={handleRecord}
          disabled={!preview.ready || recording || savingRecording}
          className="inline-flex items-center gap-2 rounded-lg bg-port-error/90 px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {recording || savingRecording ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Circle className="h-4 w-4 fill-current" />}
          {recording ? `Recording ${Math.floor(recordProgress)}s / ${Math.round(duration)}s`
            : savingRecording ? 'Saving MP4…' : 'Record (real-time)'}
        </button>
        {jobId && (
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || exportStarting}
            title="Render every frame server-side through renderFrame(t) — no dropped frames, H.264 MP4 in Media History"
            className={BUTTON_PRIMARY}
          >
            {exporting || exportStarting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
            {exporting ? `Exporting ${exportPercent}%` : 'Export MP4 (frame-exact)'}
          </button>
        )}
        {exporting && (
          <button
            type="button"
            onClick={() => cancelCodeAnimationExport(exportJob, { silent: true }).catch((error) => toast.error(error.message || 'Failed to cancel the export'))}
            className={BUTTON_SECONDARY}
          >
            Cancel export
          </button>
        )}
        <button
          type="button"
          onClick={handleDownloadHtml}
          disabled={needsThree && !vendorFiles}
          className={BUTTON_SECONDARY}
        >
          <FileCode2 className="h-4 w-4" /> Download HTML
        </button>
        {jobId && (
          <button type="button" onClick={handleDownloadPackage} disabled={packageDownloading}
            title="Portable source and brief with integrity hashes; selected external audio is not included"
            className={BUTTON_SECONDARY}>
            {packageDownloading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Download package
          </button>
        )}
        <span className="text-xs text-gray-500">
          {meta ? 'Animation ready' : 'Waiting for the animation to report ready…'}
          {preview.audioStatus === 'unavailable' ? ' · selected audio could not be attached' : ''}
        </span>
      </div>

      {exportNotes.length > 0 && (
        <div role="status" aria-label="Export notes" className="space-y-1 rounded-lg border border-port-border bg-port-card p-3 text-sm text-gray-400">
          {exportNotes.map((note) => <p key={note}>{note}</p>)}
        </div>
      )}

      {exportResult?.path && (
        <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
          <video src={exportResult.path} controls className="max-h-80 w-full rounded bg-black" aria-label="Exported animation" />
          <div className="flex flex-wrap items-center gap-2">
            <a href={exportResult.path} download={`${fileBase}.mp4`} className={BUTTON_SECONDARY}>
              <Download className="h-4 w-4" /> Download MP4
            </a>
            {exportResult.loudness && <span className="text-xs text-gray-400">Audio: {formatLoudness(exportResult.loudness)}</span>}
            <Link to="/media/history" className="text-xs text-port-accent hover:underline">Saved to Media History</Link>
          </div>
        </div>
      )}

      {video && (
        <div className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
          <video src={video.url} controls playsInline className="max-h-80 w-full rounded bg-black" aria-label="Recorded animation" />
          <div className="flex flex-wrap items-center gap-2">
            <a href={video.url} download={`${fileBase}.${video.filename?.split('.').pop() || 'mp4'}`} className={BUTTON_SECONDARY}>
              <Download className="h-4 w-4" /> Download {video.filename?.endsWith('.webm') ? 'WebM' : 'MP4'}
            </a>
            <Link to="/media/history" className="text-xs text-port-accent hover:underline">Saved to Media History</Link>
          </div>
        </div>
      )}
    </section>
  );
}
