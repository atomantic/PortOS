/**
 * ReferenceAnalysis — analyze a round reference's attached audio (#2106).
 *
 * The workbench view behind `/rounds/:id?analyze=<refId>`: waveform + playback
 * of the reference audio, labeled time-range segments ("0:00–0:14 melody
 * alone"), per-segment offline pitch extraction (the solo-segment path — pure
 * local DSP through `referenceAnalysis.js`, zero LLM calls), and a
 * side-by-side review diff of the proposed part against a stored scorePart
 * with per-bar pitch-class mismatch highlighting. Nothing auto-applies:
 * "Apply" merges the proposed part into the parent's scoreParts DRAFT and the
 * user persists it with the editor's normal Save (the same explicit-save model
 * every other Rounds surface uses).
 *
 * Also exports `ReferenceAudioAttach` — the edit-tab controls that get audio
 * ONTO a reference in the first place: file upload (screen-record / download
 * with your own tools) or mic capture while the reference video plays (the
 * zero-dependency path). Both ride the same /api/uploads flow recordings use.
 *
 * State model: this component owns only ephemeral analysis state (decoded
 * PCM, the in-review proposal). All persisted fields (audioFilename,
 * segments) round-trip through the parent's draft via `onUpdateReference`,
 * so the header Save button persists everything at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, AudioLines, Flag, FlagOff, Loader2, Mic, Play, Plus, Square, Trash2, Upload, Wand2, X,
} from 'lucide-react';
import toast from '../ui/Toast';
import ScoreSheet from './ScoreSheet.jsx';
import { uploadFile, getUploadUrl } from '../../services/api';
import { startMemoRecording, arrayBufferToBase64 } from '../../lib/audioRecorder';
import { proposeSegmentScore, diffScoreBars, PITCH_CLASS_NAMES } from '../../lib/referenceAnalysis';
import { scoreHasMusic, parseScore } from '../../lib/scoreNotation';
import { harmonyPartLabel } from '../../lib/songCraft';

// Client-side guard for the base64-JSON upload path: the server body limit is
// 55 MB and base64 inflates ~4/3, so cap the raw file well under that.
const MAX_AUDIO_BYTES = 35 * 1024 * 1024;

// Mirror services/rounds.js REF_SEGMENTS_MAX / SCORE_PARTS_MAX — used only to
// disable adding more client-side; the server enforces the real bounds.
const REF_SEGMENTS_MAX = 24;

const msToSec = (ms) => (Math.max(0, ms) / 1000).toFixed(1);
const secToMs = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 1000)) : 0;
};

// Seconds input that commits on blur/Enter rather than per keystroke — a
// controlled `value={msToSec(...)}` reformats on every render, which fights
// sequential typing ("14" becomes "1.04"). Uncontrolled while focused; the
// caller passes a `key` tied to `valueMs` so an external update (the
// set-from-playhead flag buttons) remounts it with the fresh value.
function SecondsInput({ valueMs, onCommit, ariaLabel }) {
  return (
    <input
      type="number"
      min={0}
      step={0.1}
      defaultValue={msToSec(valueMs)}
      onBlur={(e) => onCommit(secToMs(e.target.value))}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      aria-label={ariaLabel}
      className="w-20 bg-port-bg border border-port-border rounded-lg px-2 py-1 text-xs text-white focus:border-port-accent focus:outline-none"
    />
  );
}

// --- Attach controls (edit-tab reference card) ------------------------------

/**
 * Upload-or-record controls for attaching audio to one reference. Calls
 * `onUpdate(key, value)` against the parent draft (same contract as the other
 * reference fields); the file itself is uploaded immediately so it exists,
 * matching the recordings flow (upload now, persist the filename on Save).
 */
export function ReferenceAudioAttach({ reference, onUpdate }) {
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef(null);
  const handleRef = useRef(null);

  // Never leave the mic open on unmount (deferred-work cleanup rule).
  useEffect(() => () => { handleRef.current?.cancel(); }, []);

  const saveUpload = useCallback(async (base64, name) => {
    setBusy(true);
    const result = await uploadFile(base64, name, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Failed to upload audio');
      return null;
    });
    setBusy(false);
    if (!result?.filename) return;
    onUpdate('audioFilename', result.filename);
    toast.success('Audio attached — Save the song to keep it');
  }, [onUpdate]);

  const onFile = useCallback(async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > MAX_AUDIO_BYTES) {
      toast.error(`Audio file too large (max ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB)`);
      return;
    }
    const bytes = await file.arrayBuffer();
    await saveUpload(arrayBufferToBase64(bytes), file.name || 'reference-audio');
  }, [saveUpload]);

  const startRecord = useCallback(async () => {
    const handle = await startMemoRecording().catch((err) => {
      toast.error(err?.message || 'Microphone access denied');
      return null;
    });
    if (!handle) return;
    handleRef.current = handle;
    setRecording(true);
  }, []);

  const stopRecord = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;
    setRecording(false);
    const take = await handle.stop().catch((err) => {
      toast.error(err?.message || 'Recording failed');
      return null;
    });
    if (!take) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await saveUpload(take.audioBase64, `ref-${ts}.wav`);
  }, [saveUpload]);

  if (reference.audioFilename) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-port-success">
          <AudioLines size={14} /> Audio attached
        </span>
        <audio controls preload="none" src={getUploadUrl(reference.audioFilename)} className="h-8 max-w-[180px]" />
        <button
          type="button"
          onClick={() => {
            // Segments are offsets into THIS audio — clear them with it so
            // stale ranges can't resurrect against a different recording.
            onUpdate('segments', []);
            onUpdate('audioFilename', '');
          }}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg border border-port-border text-gray-400 hover:text-port-error"
        >
          <X size={13} /> Remove audio
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input ref={fileRef} type="file" accept="audio/*" onChange={onFile} className="hidden" aria-label="Upload reference audio file" />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy || recording}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Upload audio
      </button>
      {recording ? (
        <button type="button" onClick={stopRecord} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90 animate-pulse">
          <Square size={14} /> Stop capture
        </button>
      ) : (
        <button
          type="button"
          onClick={startRecord}
          disabled={busy}
          title="Record through the mic while the reference video plays"
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
        >
          <Mic size={14} /> Capture from mic
        </button>
      )}
      <span className="text-xs text-gray-600">Upload a screen-recording’s audio, or capture the mic while the video plays.</span>
    </div>
  );
}

// --- Waveform ----------------------------------------------------------------

// Static min/max-peak waveform with segment bands. Click seeks; the playhead
// is an overlaid div driven by the <audio> timeupdate (no rAF loop needed).
function Waveform({ samples, durationMs, segments, playheadMs, onSeek }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !samples?.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // jsdom / non-canvas environments
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    // Segment bands under the peaks.
    for (const seg of segments || []) {
      const x0 = (seg.startMs / durationMs) * w;
      const x1 = (seg.endMs / durationMs) * w;
      ctx.fillStyle = 'rgba(59, 130, 246, 0.18)'; // port-accent @ low alpha
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    }
    // Min/max peaks per column.
    const per = Math.max(1, Math.floor(samples.length / w));
    ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
    for (let x = 0; x < w; x++) {
      let min = 1;
      let max = -1;
      const start = x * per;
      const end = Math.min(samples.length, start + per);
      for (let i = start; i < end; i++) {
        const v = samples[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) continue;
      const y0 = ((1 - max) / 2) * h;
      const y1 = ((1 - min) / 2) * h;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }, [samples, durationMs, segments]);

  const seek = (e) => {
    if (!durationMs || !onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * durationMs);
  };

  return (
    <div className="relative w-full cursor-pointer" onClick={seek} role="presentation">
      <canvas ref={canvasRef} width={800} height={96} className="w-full h-24 rounded-lg bg-port-bg border border-port-border" />
      {durationMs > 0 && playheadMs != null && (
        <div
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px bg-port-accent"
          style={{ left: `${Math.min(100, (playheadMs / durationMs) * 100)}%` }}
        />
      )}
    </div>
  );
}

// --- Analysis view -----------------------------------------------------------

// Sentinel compare/apply target for the round's BASE melody (song.score).
// A melody-layer proposal must update the base score, not grow a duplicate
// "Melody" entry in scoreParts (which the parts editor deliberately excludes).
const BASE_TARGET = '__base__';

export default function ReferenceAnalysis({
  reference, layers = [], scoreParts = [], baseScore = '', tempo = null, songKey = '',
  onUpdateReference, onApplyPart, onClose,
}) {
  const audioRef = useRef(null);
  const [decoded, setDecoded] = useState(null); // { samples, sampleRate, durationMs }
  const [decodeError, setDecodeError] = useState(null);
  const [playheadMs, setPlayheadMs] = useState(0);
  const playUntilRef = useRef(null); // stop time (ms) for "play segment"
  const [extracting, setExtracting] = useState(false);
  // The in-review proposal: { layerId, text } — text is user-editable.
  const [proposal, setProposal] = useState(null);
  const [compareId, setCompareId] = useState('');

  const segments = reference?.segments || [];
  const audioFilename = reference?.audioFilename || '';

  // Decode the attached audio once per filename — mono PCM for the extractor
  // and the waveform. Errors degrade to a message (segments stay editable).
  useEffect(() => {
    let cancelled = false;
    setDecoded(null);
    setDecodeError(null);
    if (!audioFilename) return undefined;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { setDecodeError('Web Audio is not available in this browser.'); return undefined; }
    (async () => {
      const res = await fetch(getUploadUrl(audioFilename));
      if (!res.ok) throw new Error(`Audio fetch failed (${res.status})`);
      const bytes = await res.arrayBuffer();
      const ctx = new Ctx();
      const buffer = await ctx.decodeAudioData(bytes).finally(() => { ctx.close().catch(() => {}); });
      if (cancelled) return;
      setDecoded({
        samples: buffer.getChannelData(0),
        sampleRate: buffer.sampleRate,
        durationMs: Math.round(buffer.duration * 1000),
      });
    })().catch((err) => {
      if (!cancelled) setDecodeError(err?.message || 'Could not decode the reference audio.');
    });
    return () => { cancelled = true; };
  }, [audioFilename]);

  const durationMs = decoded?.durationMs || 0;

  const setSegments = useCallback((next) => {
    onUpdateReference?.(reference.id, 'segments', next);
  }, [onUpdateReference, reference?.id]);

  const currentMs = () => Math.round((audioRef.current?.currentTime || 0) * 1000);

  const addSegment = useCallback(() => {
    const start = currentMs();
    const end = Math.min(durationMs || start + 8000, start + 8000);
    setSegments([...segments, { layerId: '', startMs: start, endMs: Math.max(end, start + 1000) }]);
  }, [segments, setSegments, durationMs]);

  const updateSegment = useCallback((idx, patch) => {
    setSegments(segments.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }, [segments, setSegments]);

  const removeSegment = useCallback((idx) => {
    setSegments(segments.filter((_, i) => i !== idx));
  }, [segments, setSegments]);

  const seekTo = useCallback((ms) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = ms / 1000;
    setPlayheadMs(ms);
  }, []);

  const playSegment = useCallback((seg) => {
    const el = audioRef.current;
    if (!el) return;
    playUntilRef.current = seg.endMs;
    el.currentTime = seg.startMs / 1000;
    el.play().catch(() => { /* browser autoplay policy — user can press play */ });
  }, []);

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const ms = el.currentTime * 1000;
    setPlayheadMs(ms);
    if (playUntilRef.current != null && ms >= playUntilRef.current) {
      playUntilRef.current = null;
      el.pause();
    }
  }, []);

  const layerLabel = useCallback((layerId) => {
    if (!layerId) return 'Unassigned';
    return layers.find((l) => l.id === layerId)?.label || layerId;
  }, [layers]);

  // Extract a proposed score from one solo-sung segment (pure local DSP).
  const extractSegment = useCallback((seg) => {
    if (!decoded) return;
    setExtracting(true);
    // Yield a frame so the button's busy state paints before the O(n·lag) DSP.
    setTimeout(() => {
      // Transcribe on the round's own meter — a 3/4 or 6/8 round quantized and
      // bar-grouped as 4/4 would diff the wrong measures and, when applied,
      // silently change the part's time signature. parseScore defaults to 4/4
      // when the base score declares none.
      const { beats: beatsPerBar, beatValue } = parseScore(baseScore).time;
      const { text } = proposeSegmentScore(decoded.samples, decoded.sampleRate, {
        startMs: seg.startMs,
        endMs: seg.endMs,
        bpm: Number.isFinite(tempo) && tempo > 0 ? tempo : undefined,
        key: songKey || 'C',
        beatsPerBar,
        beatValue,
      });
      setExtracting(false);
      if (!text) {
        toast.error('No clear sung pitch detected in that segment — try a tighter range around a solo voice.');
        return;
      }
      setProposal({ layerId: seg.layerId, text });
      // Default the comparison target. A melody segment targets the BASE
      // score (song.score) — the round's melody lives there, not in
      // scoreParts. Other layers match the stored part whose role equals the
      // segment's layer (layer ids double as harmony-part roles) — only when
      // the segment actually HAS a layer and the part a non-empty role, so an
      // unassigned segment ('' layerId) can't silently preselect a role-less
      // hand-added part as the overwrite target.
      if (seg.layerId === 'melody') {
        setCompareId(BASE_TARGET);
      } else {
        const match = seg.layerId ? scoreParts.find((p) => p.role && p.role === seg.layerId) : null;
        setCompareId(match?.id || '');
      }
    }, 30);
  }, [decoded, tempo, songKey, scoreParts, baseScore]);

  const comparePart = useMemo(() => {
    if (compareId === BASE_TARGET) {
      return { id: BASE_TARGET, label: 'Melody (base score)', role: 'melody', score: baseScore, isBase: true };
    }
    return scoreParts.find((p) => p.id === compareId) || null;
  }, [scoreParts, compareId, baseScore]);

  const diffRows = useMemo(() => {
    if (!proposal?.text || !comparePart?.score) return null;
    return diffScoreBars(proposal.text, comparePart.score);
  }, [proposal?.text, comparePart?.score]);

  const pcNames = (pcs) => (pcs && pcs.length ? pcs.map((pc) => PITCH_CLASS_NAMES[pc]).join(' ') : '—');

  const applyProposal = useCallback(() => {
    if (!proposal?.text || !scoreHasMusic(proposal.text)) {
      toast.error('The proposed part has no parseable notes to apply.');
      return;
    }
    if (comparePart?.isBase) {
      // Melody proposals write the BASE score, never a scoreParts entry.
      onApplyPart?.({ base: true, score: proposal.text });
      return;
    }
    onApplyPart?.({
      id: comparePart?.id || '',
      // Prefer the harmony-part vocabulary label; a custom layer id falls back
      // to the layer's own label (harmonyPartLabel returns '' for unknown ids).
      label: comparePart?.label
        || (proposal.layerId ? (harmonyPartLabel(proposal.layerId) || layerLabel(proposal.layerId)) : 'Extracted part'),
      // A melody-layer proposal explicitly applied as a NEW part must not mint
      // a pseudo-"melody" role in scoreParts (the parts editor excludes it).
      role: comparePart?.role ?? (proposal.layerId === 'melody' ? '' : proposal.layerId || ''),
      score: proposal.text,
    });
  }, [proposal, comparePart, onApplyPart, layerLabel]);

  // Deep-link fallbacks: stale ?analyze= id, or a reference with no audio yet.
  if (!reference) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-3">
        <p className="text-sm text-gray-400">That reference no longer exists on this round.</p>
        <button type="button" onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white">
          <ArrowLeft size={14} /> Back to round
        </button>
      </div>
    );
  }
  if (!audioFilename) {
    return (
      <div className="max-w-3xl mx-auto p-6 space-y-3">
        <p className="text-sm text-gray-400">This reference has no attached audio yet. Attach audio from the Edit tab’s reference card first.</p>
        <button type="button" onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white">
          <ArrowLeft size={14} /> Back to round
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="flex items-center gap-3 flex-wrap">
        <button type="button" onClick={onClose} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white" aria-label="Back to round">
          <ArrowLeft size={14} /> Back
        </button>
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <AudioLines size={15} className="text-port-accent" /> Analyze reference audio
        </h2>
        <span className="text-xs text-gray-500 truncate">{reference.label || reference.url}</span>
      </div>
      <p className="text-xs text-gray-500">
        Mark the time ranges where a voice sings alone, then extract each range into a proposed part on this
        round’s tempo and key grid. Everything here edits the draft — use the header Save to persist.
      </p>

      {/* Waveform + transport */}
      <section className="space-y-2">
        {decodeError ? (
          <p className="text-xs text-port-error">{decodeError}</p>
        ) : !decoded ? (
          <p className="flex items-center gap-2 text-xs text-gray-500"><Loader2 size={14} className="animate-spin" /> Decoding audio…</p>
        ) : (
          <Waveform
            samples={decoded.samples}
            durationMs={durationMs}
            segments={segments}
            playheadMs={playheadMs}
            onSeek={seekTo}
          />
        )}
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={getUploadUrl(audioFilename)}
          onTimeUpdate={onTimeUpdate}
          className="w-full h-9"
        />
      </section>

      {/* Segments */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Segments</h3>
          <button
            type="button"
            onClick={addSegment}
            disabled={segments.length >= REF_SEGMENTS_MAX}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-40"
          >
            <Plus size={14} /> Add segment at playhead
          </button>
        </div>
        {segments.length === 0 ? (
          <p className="text-xs text-gray-500">
            No segments yet. Play the audio, pause where a voice enters alone, and add a segment.
          </p>
        ) : (
          <ul className="space-y-2">
            {segments.map((seg, idx) => (
              <li key={idx} className="bg-port-card border border-port-border rounded-lg p-3 flex flex-wrap items-center gap-2">
                <select
                  value={seg.layerId || ''}
                  onChange={(e) => updateSegment(idx, { layerId: e.target.value })}
                  aria-label="Segment layer"
                  className="bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-xs text-white focus:border-port-accent focus:outline-none"
                >
                  <option value="">— Layer —</option>
                  {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
                <label className="flex items-center gap-1 text-xs text-gray-400">
                  <span>from</span>
                  <SecondsInput
                    key={`start-${seg.startMs}`}
                    valueMs={seg.startMs}
                    onCommit={(ms) => updateSegment(idx, { startMs: ms })}
                    ariaLabel="Segment start (seconds)"
                  />
                  <span>s</span>
                </label>
                <button type="button" onClick={() => updateSegment(idx, { startMs: currentMs() })} title="Set start from playhead" aria-label="Set segment start from playhead" className="p-1 text-gray-500 hover:text-port-accent">
                  <Flag size={14} />
                </button>
                <label className="flex items-center gap-1 text-xs text-gray-400">
                  <span>to</span>
                  <SecondsInput
                    key={`end-${seg.endMs}`}
                    valueMs={seg.endMs}
                    onCommit={(ms) => updateSegment(idx, { endMs: ms })}
                    ariaLabel="Segment end (seconds)"
                  />
                  <span>s</span>
                </label>
                <button type="button" onClick={() => updateSegment(idx, { endMs: currentMs() })} title="Set end from playhead" aria-label="Set segment end from playhead" className="p-1 text-gray-500 hover:text-port-accent">
                  <FlagOff size={14} />
                </button>
                <button type="button" onClick={() => playSegment(seg)} title="Play this segment" aria-label="Play segment" className="p-1 text-gray-500 hover:text-port-accent">
                  <Play size={14} />
                </button>
                <span className="text-xs text-gray-600 flex-1 min-w-[80px]">{layerLabel(seg.layerId)}</span>
                <button
                  type="button"
                  onClick={() => extractSegment(seg)}
                  disabled={!decoded || extracting || seg.endMs <= seg.startMs}
                  title={decoded ? 'Extract a proposed part from this range (local DSP)' : 'Waiting for audio to decode'}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-accent/50 text-port-accent hover:bg-port-accent/10 disabled:opacity-40"
                >
                  {extracting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Extract part
                </button>
                <button type="button" onClick={() => removeSegment(idx)} aria-label="Remove segment" className="p-1.5 text-gray-500 hover:text-port-error">
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-600">
          Layered builds usually expose each part solo right where it enters — mark that entrance loop.
          Extraction of a voice from a stacked mix isn’t supported yet; pick solo spans.
        </p>
      </section>

      {/* Proposal review + diff */}
      {proposal && (
        <section className="space-y-3 border-t border-port-border pt-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-white">Proposed part · {layerLabel(proposal.layerId)}</h3>
            <div className="flex items-center gap-2">
              <label htmlFor="ref-compare-part" className="text-xs text-gray-400">Compare / apply to</label>
              <select
                id="ref-compare-part"
                value={compareId}
                onChange={(e) => setCompareId(e.target.value)}
                className="bg-port-bg border border-port-border rounded-lg px-2 py-1.5 text-xs text-white focus:border-port-accent focus:outline-none"
              >
                <option value="">New part</option>
                <option value={BASE_TARGET}>Melody (base score)</option>
                {scoreParts.map((p) => <option key={p.id} value={p.id}>{p.label || p.role || p.id}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-port-accent">Proposed (from audio)</h4>
              <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto">
                <ScoreSheet text={proposal.text} />
              </div>
              <textarea
                value={proposal.text}
                onChange={(e) => setProposal((prev) => ({ ...prev, text: e.target.value }))}
                rows={4}
                aria-label="Proposed part notation"
                className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-xs text-white font-mono focus:border-port-accent focus:outline-none"
              />
            </div>
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                {comparePart ? `Current · ${comparePart.label || comparePart.role}` : 'No stored part selected'}
              </h4>
              {comparePart ? (
                <div className="bg-port-card border border-port-border rounded-lg p-3 overflow-x-auto">
                  <ScoreSheet text={comparePart.score} />
                </div>
              ) : (
                <p className="text-xs text-gray-500">Applying will add this as a new harmony part.</p>
              )}
            </div>
          </div>

          {/* Per-bar pitch-class diff */}
          {diffRows && (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-white">Bar-by-bar pitch classes</h4>
              <div className="flex flex-wrap gap-1.5">
                {diffRows.map((row) => (
                  <span
                    key={row.bar}
                    title={`Bar ${row.bar} — proposed: ${pcNames(row.proposed)} · current: ${pcNames(row.existing)}`}
                    className={`px-2 py-0.5 text-xs rounded border ${row.match
                      ? 'border-port-success/50 text-port-success'
                      : 'border-port-error/60 text-port-error'}`}
                  >
                    {row.bar}{row.match ? ' ✓' : ' ✕'}
                  </span>
                ))}
              </div>
              <p className="text-xs text-gray-600">
                ✓ = same pitch classes in order (octave-insensitive). Hover a bar for the notes on each side.
              </p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyProposal}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
            >
              {comparePart?.isBase ? 'Apply to base melody' : comparePart ? 'Apply to current part' : 'Add as new part'}
            </button>
            <button
              type="button"
              onClick={() => setProposal(null)}
              className="px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white"
            >
              Discard proposal
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
