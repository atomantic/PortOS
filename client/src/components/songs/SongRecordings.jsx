/**
 * SongRecordings — record, save, and layer-play vocal takes for one song.
 *
 * Records mic audio via the shared audioRecorder (→ 16 kHz mono WAV base64),
 * uploads it through /api/uploads, and stores the returned filename on the song
 * as a `recordings[]` entry (persisted by the parent's Save). Multiple takes
 * play back simultaneously through createLayeredPlayer so the user can stack a
 * lead + bass + harmony and rehearse against themselves.
 *
 * Stateless about persistence: it calls up to the parent via `onChange` with the
 * next recordings array (optimistic), and the parent owns the PUT. A freshly
 * recorded take is uploaded immediately (so the file exists) but only saved to
 * the song on the parent's Save — matching the editor's explicit-save model.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Mic, Square, Play, Trash2, Volume2, VolumeX, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import { startMemoRecording } from '../../lib/audioRecorder';
import { createLayeredPlayer } from '../../lib/songPlayback';
import { uploadFile, getUploadUrl } from '../../services/api';
import { formatDurationMs } from '../../utils/formatters';

// Lower bound peak amplitude — below this the take is effectively silence
// (dead mic / muted input), worth warning about before it joins the stack.
const SILENCE_PEAK = 0.01;

// In-session temp id for a take not yet persisted. MUST end in `-new-<n>` so the
// editor's stripTempId (/-new-\d+$/) blanks it on save and the server assigns a
// stable `rec-<uuid>` — otherwise a reload could re-mint the same temp id and
// collide. Counter-based; uniqueness only needs to hold within the session.
let tempSeq = 0;
const tempRecordingId = () => `rec-new-${tempSeq++}`;

export default function SongRecordings({ recordings = [], layers = [], onChange }) {
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [targetLayerId, setTargetLayerId] = useState('');
  const handleRef = useRef(null);   // active MediaRecorder handle
  const playerRef = useRef(null);   // active layered player

  // Tear down any live player/recorder on unmount so a navigation-away can't
  // leave the mic open or audio playing into the void.
  useEffect(() => () => {
    if (playerRef.current) playerRef.current.stop();
    if (handleRef.current) handleRef.current.cancel();
  }, []);

  const layerLabel = useCallback((layerId) => {
    if (!layerId) return '';
    return layers.find((l) => l.id === layerId)?.label || layerId;
  }, [layers]);

  const startRecording = useCallback(async () => {
    if (playerRef.current) { playerRef.current.stop(); setPlaying(false); }
    const handle = await startMemoRecording().catch((err) => {
      toast.error(err?.message || 'Microphone access denied');
      return null;
    });
    if (!handle) return;
    handleRef.current = handle;
    setRecording(true);
  }, []);

  const stopRecording = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;
    setRecording(false);
    setSaving(true);
    const take = await handle.stop().catch((err) => {
      toast.error(err?.message || 'Recording failed');
      return null;
    });
    if (!take) { setSaving(false); return; }
    if (take.peak < SILENCE_PEAK) {
      toast.error('That take was silent — check your microphone and try again.');
      setSaving(false);
      return;
    }
    // Upload the WAV; the returned filename is what we persist + play from.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await uploadFile(take.audioBase64, `vocal-${ts}.wav`).catch((err) => {
      toast.error(err?.message || 'Failed to save recording');
      return null;
    });
    setSaving(false);
    if (!result?.filename) return;

    const next = [
      ...recordings,
      {
        id: tempRecordingId(),
        layerId: targetLayerId,
        label: targetLayerId ? layerLabel(targetLayerId) : 'Take',
        filename: result.filename,
        durationMs: take.durationMs || 0,
        peak: take.peak || 0,
        muted: false,
      },
    ];
    onChange(next);
    toast.success('Take recorded — Save the song to keep it');
  }, [recordings, targetLayerId, layerLabel, onChange]);

  const removeRecording = useCallback((id) => {
    onChange(recordings.filter((r) => r.id !== id));
  }, [recordings, onChange]);

  const toggleMute = useCallback((id) => {
    onChange(recordings.map((r) => (r.id === id ? { ...r, muted: !r.muted } : r)));
  }, [recordings, onChange]);

  const assignLayer = useCallback((id, layerId) => {
    onChange(recordings.map((r) => (r.id === id
      ? { ...r, layerId, label: layerId ? layerLabel(layerId) : (r.label || 'Take') }
      : r)));
  }, [recordings, layerLabel, onChange]);

  const playAll = useCallback(async () => {
    if (playerRef.current) playerRef.current.stop();
    const takes = recordings.map((r) => ({ id: r.id, url: getUploadUrl(r.filename), muted: r.muted }));
    if (takes.every((t) => t.muted)) { toast.error('All takes are muted'); return; }
    const player = createLayeredPlayer(takes);
    player.onEnded(() => setPlaying(false));
    playerRef.current = player;
    setPlaying(true);
    await player.play().catch((err) => {
      toast.error(err?.message || 'Playback failed');
      setPlaying(false);
    });
  }, [recordings]);

  const stopPlay = useCallback(() => {
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false);
  }, []);

  const audibleCount = useMemo(() => recordings.filter((r) => !r.muted).length, [recordings]);

  return (
    <section>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Mic size={15} className="text-port-accent" /> Vocal takes
        </h2>
        <div className="flex items-center gap-2">
          {recordings.length > 0 && (
            playing ? (
              <button type="button" onClick={stopPlay} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50">
                <Square size={14} /> Stop
              </button>
            ) : (
              <button type="button" onClick={playAll} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50" title="Play all unmuted takes together">
                <Play size={14} /> Play layered ({audibleCount})
              </button>
            )
          )}
          {recording ? (
            <button type="button" onClick={stopRecording} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90 animate-pulse">
              <Square size={14} /> Stop & save
            </button>
          ) : (
            <button type="button" onClick={startRecording} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
              {saving ? 'Saving…' : 'Record take'}
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-2">
        Record each part, then “Play layered” to stack them — sing along to build harmony against yourself.
        {recording && <span className="text-port-error"> ● Recording… sing now.</span>}
      </p>

      {/* Layer the next take targets (optional) */}
      {layers.length > 0 && !recording && (
        <div className="mb-3">
          <label htmlFor="rec-target-layer" className="block text-xs text-gray-400 mb-1">Next take is for layer</label>
          <select
            id="rec-target-layer"
            value={targetLayerId}
            onChange={(e) => setTargetLayerId(e.target.value)}
            className="w-full sm:w-64 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
          >
            <option value="">— Unassigned —</option>
            {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
      )}

      {recordings.length === 0 ? (
        <p className="text-xs text-gray-500">No takes yet. Record the lead first, then layer in harmonies.</p>
      ) : (
        <ul className="space-y-2">
          {recordings.map((r) => (
            <li key={r.id} className={`bg-port-card border rounded-lg flex items-center gap-2 px-3 py-2 ${r.muted ? 'border-port-border opacity-60' : 'border-port-border'}`}>
              <button
                type="button"
                onClick={() => toggleMute(r.id)}
                className={`p-1 shrink-0 ${r.muted ? 'text-gray-600 hover:text-gray-400' : 'text-port-accent hover:text-port-accent/80'}`}
                aria-label={r.muted ? 'Unmute take' : 'Mute take'}
                title={r.muted ? 'Muted — excluded from layered play' : 'Audible in layered play'}
              >
                {r.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-white truncate">{r.label || 'Take'}</span>
                  {r.durationMs > 0 && <span className="text-xs text-gray-500 shrink-0">{formatDurationMs(r.durationMs)}</span>}
                </div>
                {layers.length > 0 && (
                  <select
                    value={r.layerId || ''}
                    onChange={(e) => assignLayer(r.id, e.target.value)}
                    aria-label="Assign take to layer"
                    className="mt-1 bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-gray-300 focus:border-port-accent focus:outline-none"
                  >
                    <option value="">— Unassigned —</option>
                    {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                )}
              </div>
              {/* Solo listen to one take */}
              <audio controls preload="none" src={getUploadUrl(r.filename)} className="h-8 max-w-[160px] hidden sm:block" />
              <button type="button" onClick={() => removeRecording(r.id)} className="p-1.5 text-gray-500 hover:text-port-error shrink-0" aria-label="Remove take">
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
