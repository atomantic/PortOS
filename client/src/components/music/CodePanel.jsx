/**
 * CodePanel — the Music Designer's "Code" engine.
 *
 * The chosen AI provider writes the track as Strudel code (strudel.cc). The code
 * lands in an editable box, and Play runs it in a sandboxed player frame
 * (`strudelFrame.js`): an opaque-origin `<iframe sandbox="allow-scripts">`
 * whose CSP blocks all network access. LLM code therefore never runs in the
 * PortOS origin, and an error it throws is reported back and shown inline
 * without breaking the page.
 *
 * "Save as take" records the code in the frame for the chosen length and
 * uploads the WAV into the track's render history (`engine: 'code'`).
 *
 * The LLM call fires only from the Write/Revise buttons (no cold-bootstrap LLM
 * calls). The latest code is remembered per viewer in localStorage so a reload
 * doesn't lose it.
 */

import { useEffect, useRef, useState } from 'react';
import { Code2, Loader2, Play, Save, Square, Wand2 } from 'lucide-react';
import toast from '../ui/Toast';
import useMounted from '../../hooks/useMounted';
import { safeReadJsonStorage, safeWriteJsonStorage } from '../../lib/safeStorage.js';
import { clamp, formatTimecode } from '../../utils/formatters';
import { FIELD_CLASS, GHOST_BTN, LABEL_CLASS, PRIMARY_BTN } from './designerStyles';
import { renderTrackCode, writeMusicCode } from '../../services/api';
import { CODE_FRAME_SOURCE, STRUDEL_VERSION, buildStrudelFrameDoc } from './strudelFrame';

const CODE_KEY = 'portos.musicDesigner.strudelCode';
// Mirrors MUSIC_CODE_MAX in server/services/musicCode.js.
const CODE_MAX = 20000;
// Recording length. At 120s a 48 kHz stereo WAV is ~23 MB, under the 50 MB
// music upload cap.
const TAKE_SEC = { MIN: 4, MAX: 120, DEFAULT: 30 };
const FRAME_DOC = buildStrudelFrameDoc();

// Only the most recent code is kept (one key, tagged with its draft track).
const readStoredCode = (trackId) => {
  const stored = safeReadJsonStorage(CODE_KEY);
  return trackId && stored?.trackId === trackId && typeof stored.code === 'string' ? stored.code : '';
};

export default function CodePanel({
  trackId, disabled = false, description = '', lyrics = '', title = '',
  providerId, model, effort, providerPicker, onRendered,
}) {
  const mountedRef = useMounted();
  const frameRef = useRef(null);
  const [code, setCode] = useState(() => readStoredCode(trackId));
  const [guidance, setGuidance] = useState('');
  // Raw field text, clamped only when used (same as the waveform panel).
  const [lengthInput, setLengthInput] = useState(String(TAKE_SEC.DEFAULT));
  const [writing, setWriting] = useState(null); // 'fresh' | 'revise' | null
  const [frameReady, setFrameReady] = useState(false);
  const [frameState, setFrameState] = useState('stopped'); // 'stopped' | 'playing' | 'recording' | 'blocked'
  const [frameError, setFrameError] = useState('');
  // null → not saving; 'recording' → the frame is capturing; 'uploading' → sending the WAV.
  const [savePhase, setSavePhase] = useState(null);
  const [recordedSec, setRecordedSec] = useState(0);
  const [takeSec, setTakeSec] = useState(TAKE_SEC.DEFAULT);
  const saveContextRef = useRef({});
  saveContextRef.current = { trackId, description, title, onRendered };

  const post = (msg) => frameRef.current?.contentWindow?.postMessage(msg, '*');

  const uploadTake = async (wav, durationSec) => {
    const { trackId: id, description: prompt, title: takeTitle, onRendered: done } = saveContextRef.current;
    setSavePhase('uploading');
    const form = new FormData();
    form.append('track', new Blob([wav], { type: 'audio/wav' }), 'code-take.wav');
    if (prompt.trim()) form.append('prompt', prompt.trim());
    if (takeTitle.trim()) form.append('title', takeTitle.trim());
    const res = await renderTrackCode(id, form, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not save the take'); return null; });
    if (!mountedRef.current) return;
    setSavePhase(null);
    if (!res?.track) return;
    toast.success(`Saved the code take (${res.durationSec ?? Math.round(durationSec)}s)`);
    done?.(res.track);
  };

  // Everything the frame says arrives here. Only messages from OUR frame's
  // window with the protocol tag count; anything else on the page is ignored.
  useEffect(() => {
    const onMessage = (event) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.source !== CODE_FRAME_SOURCE) return;
      if (msg.type === 'ready') setFrameReady(true);
      else if (msg.type === 'state') setFrameState(msg.state);
      else if (msg.type === 'progress') setRecordedSec(Number(msg.seconds) || 0);
      else if (msg.type === 'error') {
        setFrameError(String(msg.message || 'The code failed to run'));
        setSavePhase((phase) => (phase === 'recording' ? null : phase));
      } else if (msg.type === 'recorded' && msg.wav instanceof ArrayBuffer) {
        uploadTake(msg.wav, Number(msg.durationSec) || 0);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
    // Subscribed once; uploadTake reads the latest props through saveContextRef.
  }, []);

  const rememberCode = (next) => safeWriteJsonStorage(CODE_KEY, { trackId, code: next });

  const write = async (mode) => {
    if (!description.trim()) { toast.error('Write the musical description first'); return; }
    setWriting(mode);
    const res = await writeMusicCode({
      description: description.trim(),
      lyrics: lyrics.trim() || undefined,
      guidance: guidance.trim() || undefined,
      ...(mode === 'revise' && code.trim() ? { current: code } : {}),
      language: 'strudel',
      providerId: providerId || undefined,
      model: model || undefined,
      effort: effort || undefined,
    }, { silent: true }).catch((err) => { toast.error(err?.message || 'Could not write the music code'); return null; });
    if (!mountedRef.current) return;
    setWriting(null);
    if (!res?.code) return;
    setCode(res.code);
    setFrameError('');
    rememberCode(res.code);
  };

  const play = () => {
    setFrameError('');
    post({ type: 'play', code });
  };
  // Stop also cancels a recording (or one waiting on the audio unlock).
  const stop = () => {
    post({ type: 'stop' });
    setSavePhase((phase) => (phase === 'recording' ? null : phase));
  };

  const save = () => {
    if (!code.trim() || !trackId) return;
    const seconds = clamp(Number(lengthInput) || TAKE_SEC.DEFAULT, TAKE_SEC.MIN, TAKE_SEC.MAX);
    setTakeSec(seconds);
    setFrameError('');
    setRecordedSec(0);
    setSavePhase('recording');
    post({ type: 'record', code, seconds });
  };

  const busy = !!writing || !!savePhase;
  const hasCode = !!code.trim();
  const playing = frameState === 'playing';

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        No audio model: the AI writes the piece as <a href="https://strudel.cc" target="_blank" rel="noreferrer" className="text-port-accent hover:underline">Strudel</a> code, and your browser plays it in a sandboxed player. Edit the code freely, then save a recording of it as a take.
      </p>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label htmlFor="music-code-guidance" className="block">
          <span className={LABEL_CLASS}>Code guidance (optional)</span>
          <input
            id="music-code-guidance"
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            disabled={disabled}
            maxLength={4000}
            placeholder={hasCode ? 'Double the hats and add a filter sweep on the bass…' : 'Four-on-the-floor, a supersaw lead, 124 BPM…'}
            className={FIELD_CLASS}
          />
        </label>
        <label htmlFor="music-code-length" className="block">
          <span className={LABEL_CLASS}>Take length (sec)</span>
          <input
            id="music-code-length"
            type="number"
            min={TAKE_SEC.MIN}
            max={TAKE_SEC.MAX}
            value={lengthInput}
            onChange={(event) => setLengthInput(event.target.value)}
            disabled={disabled || busy}
            className={`${FIELD_CLASS} sm:w-28`}
          />
        </label>
      </div>

      <div className="rounded border border-port-border bg-port-bg/60 p-3">
        <span className={LABEL_CLASS}>AI provider</span>
        {providerPicker}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => write('fresh')} disabled={disabled || busy || !description.trim()} className={hasCode ? GHOST_BTN : PRIMARY_BTN}>
          {writing === 'fresh' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Code2 className="h-4 w-4" />}
          <span>{writing === 'fresh' ? 'Writing…' : hasCode ? 'Write from scratch' : 'Write the code'}</span>
        </button>
        {hasCode && (
          <button type="button" onClick={() => write('revise')} disabled={disabled || busy || !description.trim()} className={PRIMARY_BTN}>
            {writing === 'revise' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            <span>{writing === 'revise' ? 'Revising…' : 'Revise code'}</span>
          </button>
        )}
      </div>

      <label htmlFor="music-code-editor" className="block">
        <span className={LABEL_CLASS}>Strudel code</span>
        <textarea
          id="music-code-editor"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onBlur={() => rememberCode(code)}
          disabled={disabled || !!writing}
          rows={12}
          maxLength={CODE_MAX}
          spellCheck={false}
          placeholder={'setcps(0.5)\nstack(\n  note("<c3 ab2 f2 g2>").s("sawtooth").lpf(600),\n  s("sbd*4"),\n)'}
          className={`${FIELD_CLASS} font-mono text-xs leading-relaxed`}
        />
      </label>

      {frameError && (
        <p role="alert" className="whitespace-pre-wrap break-words rounded border border-port-error/50 bg-port-error/10 px-3 py-2 font-mono text-xs text-port-error">
          {frameError}
        </p>
      )}

      <div className="space-y-2">
        <iframe
          ref={frameRef}
          title={`Strudel ${STRUDEL_VERSION} player`}
          // Opaque origin (no allow-same-origin): the LLM's code gets no access
          // to PortOS cookies, storage, or DOM. Do not widen this.
          sandbox="allow-scripts"
          allow="autoplay"
          srcDoc={FRAME_DOC}
          className="h-10 w-full rounded border border-port-border bg-port-bg"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={play} disabled={!frameReady || !hasCode || !!savePhase} className={GHOST_BTN}>
            <Play className="h-4 w-4" />
            <span>{playing ? 'Re-run' : 'Play'}</span>
          </button>
          <button type="button" onClick={stop} disabled={!frameReady || savePhase === 'uploading' || !(playing || frameState === 'blocked' || savePhase === 'recording')} className={GHOST_BTN}>
            <Square className="h-4 w-4" />
            <span>Stop</span>
          </button>
          <button type="button" onClick={save} disabled={disabled || busy || !frameReady || !hasCode || !trackId} className={PRIMARY_BTN}>
            {savePhase ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            <span>{savePhase === 'recording' ? 'Recording…' : savePhase === 'uploading' ? 'Saving…' : 'Save as take'}</span>
          </button>
          {savePhase === 'recording' && (
            <span className="text-xs font-mono tabular-nums text-gray-500">
              {formatTimecode(recordedSec)}{' / '}{formatTimecode(takeSec)}
            </span>
          )}
        </div>
        {frameState === 'blocked' && (
          <p className="text-xs text-port-warning">The browser is holding audio back. Click “Enable audio” in the player above.</p>
        )}
        <p className="text-xs text-gray-500">
          Saving plays the code in real time while it records, so a {clamp(Number(lengthInput) || TAKE_SEC.DEFAULT, TAKE_SEC.MIN, TAKE_SEC.MAX)}s take takes that long.
        </p>
      </div>
    </div>
  );
}
