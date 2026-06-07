/**
 * Song editor — /songs/:id.
 *
 * Edit one a cappella song: metadata (title/artist/key/tempo/rhythm shape),
 * lyric sections, the voice layers being stacked, and free-text notation +
 * arrangement notes. Full-width route (Layout.jsx isFullWidth matches
 * `/songs/`) so this page owns its own vertical scroll, mirroring
 * WritersRoomGuide's column layout.
 *
 * Saves are explicit (a Save button) rather than per-keystroke — the workbench
 * is a focused editing surface, and a single PUT keeps the merge simple. The
 * "Add layer from ladder" picker seeds a layer pre-filled from songCraft's
 * foundation-first VOICE_LAYERS so the user can build harmony in the
 * recommended order.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  Music, ArrowLeft, Plus, Trash2, Save, BookOpen, CheckCircle2, Circle, Layers,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { getSong, updateSong } from '../services/api';
import { RHYTHM_SHAPES, VOICE_LAYERS } from '../lib/songCraft';
import SongAiPanel from '../components/songs/SongAiPanel';
import SongRecordings from '../components/songs/SongRecordings';

// In-session-only id for a freshly-added section/layer, used purely as a React
// key until the row is saved. Counter-based (not Math.random, which is
// unavailable in some harnesses and unnecessary here) — uniqueness only needs
// to hold within the editing session. These TEMP ids are stripped on save (see
// stripTempId) so the server assigns a stable `sec-<uuid>`/`layer-<uuid>`; if
// they were persisted, a reload (localSeq → 0) could re-mint `sec-new-0` and
// collide with a saved row, breaking per-id update/remove.
const TEMP_ID_RE = /-new-\d+$/;
let localSeq = 0;
const localId = (prefix) => `${prefix}-new-${localSeq++}`;
// Blank a temp id before save so the server re-ids it; keep stable ids
// (preset ids like `lead`, server-assigned uuids) so dedup + matching survive.
const stripTempId = (row) => (TEMP_ID_RE.test(row.id) ? { ...row, id: '' } : row);

// Mirror the server tempo band (services/songs.js TEMPO_MIN/MAX). We clamp on
// BLUR, not on every keystroke — clamping each keystroke would turn typing
// "68" into "208" (the lone "6" clamps up to 20 first). While editing we keep
// the raw parsed number; clampTempo runs on blur so the saved value lands in
// band without an opaque server 400. Empty input clears (null).
const TEMPO_MIN = 20;
const TEMPO_MAX = 320;
// Parse a number input's value to a number or null, without clamping (used
// on change so intermediate digits aren't mangled).
const parseTempo = (raw) => {
  if (raw === '' || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};
// Clamp a tempo into the supported band (used on blur).
const clampTempo = (n) => {
  if (n == null) return null;
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(n)));
};

export default function SongEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [song, setSong] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getSong(id, { silent: true })
      .then((data) => { if (!cancelled) setSong(data?.song || null); })
      .catch((err) => { if (!cancelled) toast.error(err?.message || 'Failed to load song'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Field setters merge into the in-memory draft; nothing persists until Save.
  const setField = useCallback((key, value) => {
    setSong((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const [save, saving] = useAsyncAction(async () => {
    const patch = {
      title: song.title, artist: song.artist, key: song.key,
      tempo: song.tempo ?? null, rhythmShapeId: song.rhythmShapeId,
      notation: song.notation, notes: song.notes, learned: song.learned,
      // Strip in-session temp ids so the server assigns stable uuids — keeps
      // them from being persisted and later colliding after a reload.
      sections: (song.sections || []).map(stripTempId),
      layers: (song.layers || []).map(stripTempId),
      recordings: (song.recordings || []).map(stripTempId),
    };
    const data = await updateSong(id, patch, { silent: true });
    if (data?.song) setSong(data.song);
    toast.success('Song saved');
    return data?.song;
  }, { errorMessage: 'Failed to save song' });

  // Merge an AI-generated draft into the editor. The server returns canonical
  // fields with server-assigned ids; we replace the editable content (metadata,
  // sections, layers, notation, notes) but PRESERVE the user's recordings and
  // `learned` flag — those aren't the model's to overwrite. Nothing persists
  // until the user hits Save (matches the universe-builder review-then-commit
  // flow). The server already folded any prior draft in when expanding, so we
  // simply apply the returned fields.
  const applyGenerated = useCallback((generated) => {
    setSong((prev) => ({
      ...prev,
      title: generated.title || prev.title,
      artist: generated.artist ?? prev.artist,
      key: generated.key ?? prev.key,
      tempo: generated.tempo ?? prev.tempo,
      rhythmShapeId: generated.rhythmShapeId ?? prev.rhythmShapeId,
      notation: generated.notation ?? prev.notation,
      notes: generated.notes ?? prev.notes,
      sections: Array.isArray(generated.sections) ? generated.sections : prev.sections,
      layers: Array.isArray(generated.layers) ? generated.layers : prev.layers,
    }));
  }, []);

  // --- Section helpers ----------------------------------------------------
  const addSection = () => setSong((prev) => ({
    ...prev,
    sections: [...(prev.sections || []), { id: localId('sec'), label: 'Section', lyrics: '' }],
  }));
  const updateSection = (sid, key, value) => setSong((prev) => ({
    ...prev,
    sections: prev.sections.map((s) => (s.id === sid ? { ...s, [key]: value } : s)),
  }));
  const removeSection = (sid) => setSong((prev) => ({
    ...prev, sections: prev.sections.filter((s) => s.id !== sid),
  }));

  // --- Layer helpers ------------------------------------------------------
  const addLayer = (preset) => setSong((prev) => ({
    ...prev,
    // Presets carry the STABLE bare preset id (`lead`) — the picker already
    // prevents adding the same preset twice, so it's unique among layers, it
    // survives save (not a temp id), and it keeps remainingPresets dedup
    // working. Blank layers use a temp id stripped on save.
    layers: [...(prev.layers || []), preset
      ? { id: preset.id, label: preset.label, part: preset.voices, notes: preset.advice }
      : { id: localId('layer'), label: 'Layer', part: '', notes: '' }],
  }));
  const updateLayer = (lid, key, value) => setSong((prev) => ({
    ...prev,
    layers: prev.layers.map((l) => (l.id === lid ? { ...l, [key]: value } : l)),
  }));
  const removeLayer = (lid) => setSong((prev) => ({
    ...prev, layers: prev.layers.filter((l) => l.id !== lid),
  }));

  // Layer presets the user hasn't added yet, in foundation-first order. Match
  // on the preset id: preset layers (seed or ladder-added) carry the bare
  // preset id like `lead`, so renaming a layer's label can't make its preset
  // reappear and two presets sharing a label can't collide.
  const remainingPresets = useMemo(() => {
    const have = new Set((song?.layers || []).map((l) => l.id));
    return VOICE_LAYERS.filter((p) => !have.has(p.id));
  }, [song?.layers]);

  if (loading) {
    return <div className="p-6 text-sm text-gray-500">Loading song…</div>;
  }
  if (!song) {
    return (
      <div className="p-6">
        <p className="text-sm text-gray-400 mb-4">Song not found.</p>
        <Link to="/songs" className="text-port-accent hover:underline">← Back to Songs</Link>
      </div>
    );
  }

  const labelCls = 'block text-xs text-gray-400 mb-1';
  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';

  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-port-border bg-port-card shrink-0">
        <button
          type="button"
          onClick={() => navigate('/songs')}
          className="p-1 text-gray-400 hover:text-white transition-colors"
          title="Back to Songs"
          aria-label="Back to Songs"
        >
          <ArrowLeft size={18} />
        </button>
        <Music size={18} className="text-port-accent shrink-0" />
        <span className="text-white font-semibold truncate flex-1 min-w-0">{song.title || 'Untitled song'}</span>
        <Link
          to="/songs/guide"
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50"
        >
          <BookOpen size={14} />
          Guide
        </Link>
        <button
          type="button"
          onClick={() => save()}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {/* Metadata */}
          <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="title" className={labelCls}>Title</label>
                <input id="title" type="text" value={song.title} onChange={(e) => setField('title', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor="artist" className={labelCls}>Artist</label>
                <input id="artist" type="text" value={song.artist} onChange={(e) => setField('artist', e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor="key" className={labelCls}>Key</label>
                <input id="key" type="text" value={song.key} onChange={(e) => setField('key', e.target.value)} placeholder="e.g. C major" className={inputCls} />
              </div>
              <div>
                <label htmlFor="tempo" className={labelCls}>Tempo (BPM)</label>
                <input
                  id="tempo"
                  type="number"
                  min={TEMPO_MIN}
                  max={TEMPO_MAX}
                  value={song.tempo ?? ''}
                  onChange={(e) => setField('tempo', parseTempo(e.target.value))}
                  onBlur={() => setField('tempo', clampTempo(song.tempo))}
                  placeholder="e.g. 68"
                  className={inputCls}
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="rhythm" className={labelCls}>Rhythm shape</label>
                <select id="rhythm" value={song.rhythmShapeId} onChange={(e) => setField('rhythmShapeId', e.target.value)} className={inputCls}>
                  <option value="">— Choose a feel —</option>
                  {RHYTHM_SHAPES.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}{s.dirge ? ' · dirge' : ''} ({s.bpm.label})</option>
                  ))}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer w-fit">
              <input type="checkbox" checked={song.learned} onChange={(e) => setField('learned', e.target.checked)} className="accent-port-accent" />
              {song.learned ? <CheckCircle2 size={16} className="text-port-success" /> : <Circle size={16} className="text-gray-600" />}
              Learned (performance-ready)
            </label>
          </section>

          {/* AI assist — generate / expand / evaluate */}
          <SongAiPanel songId={id} onApplyGenerated={applyGenerated} />

          {/* Lyric sections */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-white">Lyrics & structure</h2>
              <button type="button" onClick={addSection} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50">
                <Plus size={14} /> Add section
              </button>
            </div>
            {(song.sections || []).length === 0 ? (
              <p className="text-xs text-gray-500">No sections yet. Add a verse, chorus, or bridge.</p>
            ) : (
              <div className="space-y-3">
                {song.sections.map((s) => (
                  <div key={s.id} className="bg-port-card border border-port-border rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="text"
                        value={s.label}
                        onChange={(e) => updateSection(s.id, 'label', e.target.value)}
                        placeholder="Section label (Verse 1, Chorus…)"
                        aria-label="Section label"
                        className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                      />
                      <button type="button" onClick={() => removeSection(s.id)} className="p-1.5 text-gray-500 hover:text-port-error" aria-label="Remove section">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <textarea
                      value={s.lyrics}
                      onChange={(e) => updateSection(s.id, 'lyrics', e.target.value)}
                      placeholder="Lyrics…"
                      aria-label="Section lyrics"
                      rows={3}
                      className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none font-mono leading-relaxed"
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Voice layers */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Layers size={15} className="text-port-accent" /> Voice layers
              </h2>
              <button type="button" onClick={() => addLayer(null)} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50">
                <Plus size={14} /> Blank layer
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              Build foundation-first: lead, then bass, then thirds and fifths. See the{' '}
              <Link to="/songs/guide" className="text-port-accent hover:underline">Learning Guide</Link> for the full ladder.
            </p>
            {remainingPresets.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {remainingPresets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => addLayer(p)}
                    title={p.advice}
                    className="px-2.5 py-1 text-xs rounded-full border border-port-border text-gray-300 hover:text-white hover:border-port-accent/60"
                  >
                    + {p.label}
                  </button>
                ))}
              </div>
            )}
            {(song.layers || []).length === 0 ? (
              <p className="text-xs text-gray-500">No layers yet. Add the lead melody first.</p>
            ) : (
              <div className="space-y-3">
                {song.layers.map((l) => (
                  <div key={l.id} className="bg-port-card border border-port-border rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="text"
                        value={l.label}
                        onChange={(e) => updateLayer(l.id, 'label', e.target.value)}
                        placeholder="Layer (Lead, Bass, Harmony…)"
                        aria-label="Layer label"
                        className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                      />
                      <input
                        type="text"
                        value={l.part}
                        onChange={(e) => updateLayer(l.id, 'part', e.target.value)}
                        placeholder="Voice (Alto…)"
                        aria-label="Layer voice"
                        className="w-32 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                      />
                      <button type="button" onClick={() => removeLayer(l.id)} className="p-1.5 text-gray-500 hover:text-port-error" aria-label="Remove layer">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <textarea
                      value={l.notes}
                      onChange={(e) => updateLayer(l.id, 'notes', e.target.value)}
                      placeholder="Notes for learning this part — intervals, entrances, breaths…"
                      aria-label="Layer notes"
                      rows={2}
                      className="w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none leading-relaxed"
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Vocal takes — record & layered playback */}
          <SongRecordings
            recordings={song.recordings || []}
            layers={song.layers || []}
            onChange={(recordings) => setField('recordings', recordings)}
          />

          {/* Notation + notes */}
          <section className="grid grid-cols-1 gap-4">
            <div>
              <label htmlFor="notation" className={labelCls}>Notation / chords</label>
              <textarea
                id="notation"
                value={song.notation}
                onChange={(e) => setField('notation', e.target.value)}
                placeholder="Chord progression, lead-sheet notes, solfège — e.g. C — Am — F — G"
                rows={3}
                className={`${inputCls} font-mono leading-relaxed`}
              />
            </div>
            <div>
              <label htmlFor="notes" className={labelCls}>Arrangement & learning notes</label>
              <textarea
                id="notes"
                value={song.notes}
                onChange={(e) => setField('notes', e.target.value)}
                placeholder="How it should feel, dynamics, where to breathe, what to drill…"
                rows={4}
                className={`${inputCls} leading-relaxed`}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
