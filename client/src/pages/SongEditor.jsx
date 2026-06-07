/**
 * Song editor — /songs/:id.
 *
 * Two URL-param-driven modes (`?mode=read` default, `?mode=edit`):
 *  - READ: a clean, desktop-wide performance view — lyrics rendered in full
 *    (no sub-scrollable textareas), sections laid out in a responsive grid to
 *    use horizontal real-estate and cut vertical scrolling, with the recorder
 *    front-and-centre for playing/recording.
 *  - EDIT: the editing workbench — metadata, lyric sections, voice layers, and
 *    free-text notation + arrangement notes.
 *
 * Full-width route (Layout.jsx isFullWidth matches `/songs/`) so this page owns
 * its own vertical scroll, mirroring WritersRoomGuide's column layout. The mode
 * lives in the URL (not local state) so a view is linkable — per the project's
 * "linkable routes for all views" convention.
 *
 * Saves are explicit (a Save button) rather than per-keystroke — the workbench
 * is a focused editing surface, and a single PUT keeps the merge simple. Save
 * stays available in READ mode too, because recording a take mutates the draft.
 * The "Add layer from ladder" picker seeds a layer pre-filled from songCraft's
 * foundation-first VOICE_LAYERS so the user can build harmony in the
 * recommended order.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import {
  Music, ArrowLeft, Plus, Trash2, Save, BookOpen, CheckCircle2, Circle, Layers, Eye, Pencil,
  Sparkles, RefreshCw, Video, ExternalLink,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { getSong, updateSong, refreshSongTemplate, listSongs } from '../services/api';
import { RHYTHM_SHAPES, VOICE_LAYERS, rhythmShapeLabel } from '../lib/songCraft';
import Pill from '../components/ui/Pill';
import SongAiPanel from '../components/songs/SongAiPanel';
import SongRecordings from '../components/songs/SongRecordings';
import SongScoreEditor from '../components/songs/SongScoreEditor';
import ScoreSheet from '../components/songs/ScoreSheet';
import RoundStack from '../components/songs/RoundStack';
import { scoreHasMusic } from '../lib/scoreNotation';

// Cap on partner songs — mirrors services/songs.js PARTNERS_MAX. Used only to
// disable adding more in the editor; the server enforces the real bound.
const PARTNERS_MAX = 12;

// Extract a TikTok video id from a share/watch URL so we can render TikTok's
// documented iframe Embed Player (https://www.tiktok.com/player/v1/<id>)
// instead of loading their embed.js. Returns null for anything that isn't a
// TikTok video URL — those references render as plain links.
const tiktokVideoId = (url) => {
  // Anchor the host so look-alikes (nottiktok.com, evil.com/#tiktok.com/…)
  // don't match — tiktok.com must be preceded by start, `//`, or a subdomain dot.
  const m = /(?:^|\/\/|\.)tiktok\.com\/(?:@[\w.-]+\/video|v|embed(?:\/v2)?|player\/v1)\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
};
const tiktokEmbedSrc = (id) => `https://www.tiktok.com/player/v1/${id}`;
// Only http(s) URLs are safe to render as a clickable link — reject
// javascript:/data: and other schemes so a stored reference can't smuggle a
// script into an href.
const isHttpUrl = (url) => /^https?:\/\//i.test(url || '');

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
  const [searchParams, setSearchParams] = useSearchParams();
  const editing = searchParams.get('mode') === 'edit';
  const setMode = useCallback((mode) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (mode === 'edit') next.set('mode', 'edit');
      else next.delete('mode');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  // Round-stack view lives in the URL (?stack=1) so the stacked parts are a
  // linkable view, like ?mode — per the "linkable routes for all views" rule.
  const stackOpen = searchParams.get('stack') === '1';
  const setStack = useCallback((open) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (open) next.set('stack', '1');
      else next.delete('stack');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [song, setSong] = useState(null);
  const [loading, setLoading] = useState(true);
  // All songs — resolves partner records for the round stack and the "Sings
  // with" editor's pick list. Best-effort; the page works without it.
  const [allSongs, setAllSongs] = useState([]);

  useEffect(() => {
    let cancelled = false;
    // Reset to the loading state on every id change — partner links navigate
    // song→song without unmounting this component, so without this the previous
    // draft would render under the new id and a Save during the load window would
    // write the old draft into the new song's record. The loading guard below
    // hides the editor (and its Save button) until the new song arrives.
    setLoading(true);
    setSong(null);
    getSong(id, { silent: true })
      .then((data) => { if (!cancelled) setSong(data?.song || null); })
      .catch((err) => { if (!cancelled) toast.error(err?.message || 'Failed to load song'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);

  // Refresh the all-songs list whenever the open song changes — this component
  // stays mounted across /songs/:id navigation, so a once-on-mount fetch would
  // leave partner records (titles, saved takes) stale after editing a partner
  // and navigating back. The list is small and single-user, so re-fetching on
  // navigation is cheap and keeps the round stack honest.
  useEffect(() => {
    let cancelled = false;
    listSongs({ silent: true })
      .then((data) => { if (!cancelled) setAllSongs(data?.songs || []); })
      .catch(() => { /* the page degrades to no partner resolution */ });
    return () => { cancelled = true; };
  }, [id]);

  // Resolve this song's partner ids to records (skip any that no longer exist).
  const partnerSongs = useMemo(() => {
    const byId = new Map(allSongs.map((s) => [s.id, s]));
    return (song?.partnerSongIds || []).map((pid) => byId.get(pid)).filter(Boolean);
  }, [allSongs, song?.partnerSongIds]);
  // Other songs to offer as partners in the editor, alphabetical.
  const otherSongs = useMemo(
    () => allSongs.filter((s) => s.id !== id).sort((a, b) => (a.title || '').localeCompare(b.title || '')),
    [allSongs, id],
  );
  const togglePartner = useCallback((pid) => setSong((prev) => {
    if (!prev) return prev;
    const cur = prev.partnerSongIds || [];
    if (cur.includes(pid)) return { ...prev, partnerSongIds: cur.filter((x) => x !== pid) };
    if (cur.length >= PARTNERS_MAX) return prev;
    return { ...prev, partnerSongIds: [...cur, pid] };
  }), []);

  // Field setters merge into the in-memory draft; nothing persists until Save.
  const setField = useCallback((key, value) => {
    setSong((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  const [save, saving] = useAsyncAction(async () => {
    const patch = {
      title: song.title, artist: song.artist, key: song.key,
      tempo: song.tempo ?? null, rhythmShapeId: song.rhythmShapeId,
      notation: song.notation, score: song.score, notes: song.notes, learned: song.learned,
      // Strip in-session temp ids so the server assigns stable uuids — keeps
      // them from being persisted and later colliding after a reload.
      sections: (song.sections || []).map(stripTempId),
      layers: (song.layers || []).map(stripTempId),
      recordings: (song.recordings || []).map(stripTempId),
      references: (song.references || []).map(stripTempId),
      partnerSongIds: song.partnerSongIds || [],
    };
    const data = await updateSong(id, patch, { silent: true });
    if (data?.song) setSong(data.song);
    toast.success('Song saved');
    return data?.song;
  }, { errorMessage: 'Failed to save song' });

  // Restore a built-in default to its shipped content (lyrics, layers,
  // references). Persists server-side immediately and preserves the user's
  // recordings + learned progress; replaces any local unsaved edits, so the
  // BuiltInBanner gates this behind an inline confirm.
  const [refreshTemplate, refreshing] = useAsyncAction(async () => {
    const data = await refreshSongTemplate(id, { silent: true });
    if (data?.song) setSong(data.song);
    toast.success('Refreshed from the bundled template');
    return data?.song;
  }, { errorMessage: 'Failed to refresh from template' });

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

  // --- Reference helpers --------------------------------------------------
  const addReference = () => setSong((prev) => ({
    ...prev,
    references: [...(prev.references || []), { id: localId('ref'), url: '', label: '', note: '' }],
  }));
  const updateReference = (rid, key, value) => setSong((prev) => ({
    ...prev,
    references: prev.references.map((r) => (r.id === rid ? { ...r, [key]: value } : r)),
  }));
  const removeReference = (rid) => setSong((prev) => ({
    ...prev, references: prev.references.filter((r) => r.id !== rid),
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
        {/* View / Edit toggle — mode lives in the URL so each view is linkable. */}
        <div className="flex items-center rounded-lg border border-port-border overflow-hidden shrink-0">
          <button
            type="button"
            onClick={() => setMode('read')}
            aria-pressed={!editing}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors ${!editing ? 'bg-port-accent text-white' : 'text-gray-300 hover:text-white hover:bg-port-border/50'}`}
          >
            <Eye size={14} /> View
          </button>
          <button
            type="button"
            onClick={() => setMode('edit')}
            aria-pressed={editing}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs transition-colors border-l border-port-border ${editing ? 'bg-port-accent text-white' : 'text-gray-300 hover:text-white hover:bg-port-border/50'}`}
          >
            <Pencil size={14} /> Edit
          </button>
        </div>
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
        {!editing && (
          <ReadView
            song={song}
            setField={setField}
            onRefreshTemplate={refreshTemplate}
            refreshing={refreshing}
            partnerSongs={partnerSongs}
            stackOpen={stackOpen}
            onToggleStack={setStack}
          />
        )}

        {editing && (
        <div className="max-w-5xl mx-auto space-y-6">
          {song.builtIn && <BuiltInBanner onRefresh={refreshTemplate} refreshing={refreshing} />}
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
                    <option key={s.id} value={s.id}>{rhythmShapeLabel(s.id)}</option>
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
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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

          {/* Sings with — partner songs for the round-stack (quodlibet) view */}
          <section>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-white mb-2">
              <Layers size={15} className="text-port-accent" /> Sings with (round partners)
            </h2>
            <p className="text-xs text-gray-500 mb-2">
              Link songs that are sung at the same time — rounds that share a chord cycle. In View, a “Stack parts” button
              renders them together and plays their takes layered.
            </p>
            {otherSongs.length === 0 ? (
              <p className="text-xs text-gray-500">No other songs yet to pair with.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {otherSongs.map((s) => {
                  const checked = (song.partnerSongIds || []).includes(s.id);
                  const atMax = !checked && (song.partnerSongIds || []).length >= PARTNERS_MAX;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => togglePartner(s.id)}
                      disabled={atMax}
                      aria-pressed={checked}
                      title={atMax ? `Up to ${PARTNERS_MAX} partners` : undefined}
                      className={`px-2.5 py-1 text-xs rounded-full border transition-colors disabled:opacity-40 ${checked ? 'bg-port-accent/15 border-port-accent/60 text-white' : 'border-port-border text-gray-300 hover:text-white hover:border-port-accent/60'}`}
                    >
                      {checked ? '✓ ' : '+ '}{s.title || 'Untitled song'}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Vocal takes — record & layered playback */}
          <SongRecordings
            recordings={song.recordings || []}
            layers={song.layers || []}
            onChange={(recordings) => setField('recordings', recordings)}
          />

          {/* Reference material — links / videos (TikTok embeds in read view) */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <Video size={15} className="text-port-accent" /> Reference material
              </h2>
              <button type="button" onClick={addReference} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50">
                <Plus size={14} /> Add reference
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              Paste a link to a performance, tutorial, or chart. TikTok video links play inline in the View tab.
            </p>
            {(song.references || []).length === 0 ? (
              <p className="text-xs text-gray-500">No references yet. Add a TikTok or other link to study from.</p>
            ) : (
              <div className="space-y-3">
                {song.references.map((r) => (
                  <div key={r.id} className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <input
                        type="url"
                        value={r.url}
                        onChange={(e) => updateReference(r.id, 'url', e.target.value)}
                        placeholder="https://www.tiktok.com/@user/video/…"
                        aria-label="Reference URL"
                        className="flex-1 min-w-0 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                      />
                      <button type="button" onClick={() => removeReference(r.id)} className="p-1.5 text-gray-500 hover:text-port-error shrink-0" aria-label="Remove reference">
                        <Trash2 size={15} />
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={r.label}
                        onChange={(e) => updateReference(r.id, 'label', e.target.value)}
                        placeholder="Label (e.g. TikTok · @user)"
                        aria-label="Reference label"
                        className="bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                      />
                      <input
                        type="text"
                        value={r.note}
                        onChange={(e) => updateReference(r.id, 'note', e.target.value)}
                        placeholder="Note (what to listen for…)"
                        aria-label="Reference note"
                        className="bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
                      />
                    </div>
                    {tiktokVideoId(r.url) && <p className="text-xs text-port-success">✓ TikTok video — embeds in View</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Sheet music — live-rendered staff from the lead-sheet notation. */}
          <SongScoreEditor value={song.score} onChange={(v) => setField('score', v)} />

          {/* Notation + notes */}
          <section className="grid grid-cols-1 gap-4">
            <div>
              <label htmlFor="notation" className={labelCls}>Notation / chords (free text)</label>
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
        )}
      </div>
    </div>
  );
}

// --- Read-only performance view -------------------------------------------
// Renders the song for reading / playing / recording: lyrics shown in full
// (no sub-scrollable textareas) and laid out in a responsive grid so short
// sections sit side-by-side and use the available desktop width. The recorder
// stays interactive (recording mutates the draft; the header Save persists it).
function ReadView({ song, setField, onRefreshTemplate, refreshing, partnerSongs = [], stackOpen = false, onToggleStack }) {
  const sections = song.sections || [];
  const layers = song.layers || [];
  const references = song.references || [];
  const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
  const feel = song.rhythmShapeId ? rhythmShapeLabel(song.rhythmShapeId) : '';
  // Gate the whole sheet-music section on whether the score has notes. Memoized
  // so a recording-driven re-render doesn't re-parse the score each time
  // (ScoreSheet parses it again internally only when it actually renders).
  const hasScore = useMemo(() => scoreHasMusic(song.score), [song.score]);
  // Only actually swap to the stacked view when there are partners to stack —
  // otherwise `?stack=1` with no partners would hide the single-song view and
  // render nothing.
  const showingStack = stackOpen && partnerSongs.length > 0;

  // Label + value badge, two-toned, built on the shared Pill primitive.
  const metaBadge = (label, value) => (
    <Pill tone="muted">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-200">{value}</span>
    </Pill>
  );

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {song.builtIn && <BuiltInBanner onRefresh={onRefreshTemplate} refreshing={refreshing} />}
      {/* Compact meta line — no form fields, just the at-a-glance facts. */}
      <div className="flex flex-wrap items-center gap-2">
        {hasText(song.artist) && metaBadge('Artist', song.artist)}
        {hasText(song.key) && metaBadge('Key', song.key)}
        {song.tempo != null && metaBadge('Tempo', `${song.tempo} BPM`)}
        {feel && metaBadge('Feel', feel)}
        <Pill tone={song.learned ? 'success' : 'muted'} icon={song.learned ? CheckCircle2 : Circle}>
          {song.learned ? 'Learned' : 'Learning'}
        </Pill>
      </div>

      {/* Sings with — partner rounds, with a toggle for the stacked all-parts view. */}
      {partnerSongs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Sings with:</span>
          {partnerSongs.map((p) => (
            <Link key={p.id} to={`/songs/${p.id}`} className="px-2.5 py-1 text-xs rounded-full border border-port-border text-gray-300 hover:text-white hover:border-port-accent/60">
              {p.title || 'Untitled song'}
            </Link>
          ))}
          <button
            type="button"
            onClick={() => onToggleStack?.(!stackOpen)}
            aria-pressed={stackOpen}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border transition-colors ${stackOpen ? 'bg-port-accent text-white border-port-accent' : 'border-port-border text-gray-300 hover:text-white hover:border-port-accent/60'}`}
          >
            <Layers size={13} /> {stackOpen ? 'Hide stack' : 'Stack parts'}
          </button>
        </div>
      )}

      {/* Round stack — every part at once, replacing the single-song reading
          surface while open. */}
      {showingStack && (
        <RoundStack songs={[song, ...partnerSongs]} />
      )}

      {/* Sheet music — the rendered staff, full-width so a row of bars fits. */}
      {!showingStack && hasScore && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-white">Sheet music</h2>
          <div className="bg-port-card border border-port-border rounded-lg p-4 overflow-x-auto">
            <ScoreSheet text={song.score} />
          </div>
        </section>
      )}

      {!showingStack && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Lyrics — the main reading surface, given the most width. */}
        <section className="lg:col-span-2 space-y-3">
          <h2 className="text-sm font-semibold text-white">Lyrics</h2>
          {sections.length === 0 ? (
            <p className="text-xs text-gray-500">No lyrics yet. Switch to Edit to add a verse or chorus.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {sections.map((s) => (
                <div key={s.id} className="bg-port-card border border-port-border rounded-lg p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-port-accent mb-2">{s.label || 'Section'}</h3>
                  {hasText(s.lyrics)
                    ? <p className="text-sm text-gray-100 whitespace-pre-wrap leading-relaxed">{s.lyrics}</p>
                    : <p className="text-xs text-gray-600 italic">No lyrics</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Side rail — notation, layers, and notes. */}
        <aside className="space-y-6">
          {hasText(song.notation) && (
            <section>
              <h2 className="text-sm font-semibold text-white mb-2">Notation / chords</h2>
              <p className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-100 whitespace-pre-wrap leading-relaxed font-mono">{song.notation}</p>
            </section>
          )}

          {layers.length > 0 && (
            <section>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white mb-2">
                <Layers size={15} className="text-port-accent" /> Voice layers
              </h2>
              <ul className="space-y-2">
                {layers.map((l) => (
                  <li key={l.id} className="bg-port-card border border-port-border rounded-lg p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-sm text-white">{l.label || 'Layer'}</span>
                      {hasText(l.part) && <span className="text-xs text-gray-500">{l.part}</span>}
                    </div>
                    {hasText(l.notes) && <p className="mt-1 text-xs text-gray-400 whitespace-pre-wrap leading-relaxed">{l.notes}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {hasText(song.notes) && (
            <section>
              <h2 className="text-sm font-semibold text-white mb-2">Arrangement & notes</h2>
              <p className="bg-port-card border border-port-border rounded-lg p-4 text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">{song.notes}</p>
            </section>
          )}
        </aside>
      </div>
      )}

      {/* Reference material — TikTok videos embed; other links render as cards. */}
      {references.length > 0 && (
        <section>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-white mb-3">
            <Video size={15} className="text-port-accent" /> Reference material
          </h2>
          <div className="flex flex-wrap gap-4">
            {references.map((r) => <ReferenceCard key={r.id} reference={r} />)}
          </div>
        </section>
      )}

      {/* Vocal takes — recording/playback stays available in read mode. */}
      <SongRecordings
        recordings={song.recordings || []}
        layers={song.layers || []}
        onChange={(recordings) => setField('recordings', recordings)}
      />
    </div>
  );
}

// One reference: a TikTok video renders as the official embed iframe; any other
// URL renders as a link card (label + note + the raw URL).
function ReferenceCard({ reference }) {
  const ttId = tiktokVideoId(reference.url);
  const title = reference.label || reference.url;
  const safeHref = isHttpUrl(reference.url);
  if (ttId) {
    return (
      <div className="w-full sm:w-[325px] space-y-2">
        <iframe
          title={title}
          src={tiktokEmbedSrc(ttId)}
          className="w-full h-[575px] rounded-lg border border-port-border bg-port-card"
          loading="lazy"
          allow="encrypted-media; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
        />
        {(reference.label || reference.note) && (
          <div className="px-1">
            {reference.label && <p className="text-sm text-white truncate">{reference.label}</p>}
            {reference.note && <p className="text-xs text-gray-500">{reference.note}</p>}
          </div>
        )}
      </div>
    );
  }
  // Non-http(s) URLs render as a non-clickable card so a javascript:/data:
  // scheme can't ride into an href.
  const Wrapper = safeHref ? 'a' : 'div';
  const wrapperProps = safeHref
    ? { href: reference.url, target: '_blank', rel: 'noopener noreferrer' }
    : {};
  return (
    <Wrapper
      {...wrapperProps}
      className={`w-full sm:w-[325px] bg-port-card border border-port-border rounded-lg p-4 ${safeHref ? 'hover:border-port-accent/50 transition-colors' : ''}`}
    >
      <div className="flex items-center gap-2 text-white">
        <ExternalLink size={15} className="text-port-accent shrink-0" />
        <span className="text-sm truncate">{title}</span>
      </div>
      {reference.note && <p className="mt-1 text-xs text-gray-500">{reference.note}</p>}
      <p className="mt-1 text-xs text-gray-600 truncate">{reference.url}</p>
    </Wrapper>
  );
}

// Built-in default banner — shows the shipped-default label and an inline-
// confirmed "Refresh from template" action (restores shipped content, keeps the
// user's recordings + learned progress). Inline confirm rather than a two-click
// arm so the destructive-of-edits nature is explicit without a hidden re-click.
function BuiltInBanner({ onRefresh, refreshing }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-3 bg-port-accent/5 border border-port-accent/20 rounded-lg px-3 py-2">
      <Pill tone="accent" icon={Sparkles}>Built-in default</Pill>
      <span className="text-xs text-gray-400 flex-1 min-w-0">
        Shipped with PortOS. Refresh to restore the latest bundled lyrics, arrangement & references — your recordings and learned progress are kept.
      </span>
      {confirming ? (
        <span className="flex items-center gap-2">
          <span className="text-xs text-gray-300">Replace local edits?</span>
          <button
            type="button"
            onClick={() => { onRefresh(); setConfirming(false); }}
            disabled={refreshing}
            className="px-2.5 py-1 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2.5 py-1 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={refreshing}
          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-50 shrink-0"
        >
          <RefreshCw size={14} /> Refresh from template
        </button>
      )}
    </div>
  );
}
