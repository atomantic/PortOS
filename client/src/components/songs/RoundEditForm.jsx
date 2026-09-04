import { Link } from 'react-router';
import {
  AudioLines, CheckCircle2, Circle, Layers, Plus, Trash2, Video,
} from 'lucide-react';
import RoundBuiltInBanner from './RoundBuiltInBanner';
import SongAiPanel from './SongAiPanel';
import SongRecordings from './SongRecordings';
import SongScoreEditor from './SongScoreEditor';
import SongScoreParts from './SongScoreParts';
import SongTraining from './SongTraining';
import { ReferenceAudioAttach } from './ReferenceAnalysis';
import { RHYTHM_SHAPES, rhythmShapeLabel } from '../../lib/songCraft';
import { PARTNERS_MAX, TEMPO_MAX, TEMPO_MIN, clampTempo, parseTempo } from '../../lib/roundDraft.js';
import { isHttpUrl, tiktokVideoId } from '../../utils/urlNormalize';

const labelCls = 'block text-xs text-gray-400 mb-1';
const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';

// --- Editing workbench ------------------------------------------------------
// The `?mode=edit` surface: metadata, AI assist, lyric sections, voice layers,
// round partners, takes, training, references, sheet music + harmony parts, and
// the free-text notation / arrangement notes. Every edit lands in the parent's
// in-memory draft — the page header's Save is what persists it.
export default function RoundEditForm({
  songId, song, setField, rows, otherSongs = [], onTogglePartner,
  baseDirty, onApplyGenerated, onRefreshTemplate, refreshing, onAnalyze,
}) {
  const {
    addSection, updateSection, removeSection,
    addLayer, updateLayer, removeLayer,
    addReference, updateReference, removeReference,
    remainingPresets,
  } = rows;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {song.builtIn && <RoundBuiltInBanner onRefresh={onRefreshTemplate} refreshing={refreshing} />}
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
      <SongAiPanel songId={songId} onApplyGenerated={onApplyGenerated} />

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
                  <button type="button" onClick={() => removeSection(s.id)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-error" aria-label="Remove section">
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
          Build foundation-first: melody, then bass, then the mid &amp; high harmonies. See the{' '}
          <Link to="/rounds/guide" className="text-port-accent hover:underline">Learning Guide</Link> for the full ladder.
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
                  <button type="button" onClick={() => removeLayer(l.id)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-error" aria-label="Remove layer">
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
          Link rounds that are sung at the same time — rounds that share a chord cycle. In View, a “Stack parts” button
          renders them together and plays their takes layered.
        </p>
        {otherSongs.length === 0 ? (
          <p className="text-xs text-gray-500">No other rounds yet to pair with.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {otherSongs.map((s) => {
              const checked = (song.partnerRoundIds || []).includes(s.id);
              const atMax = !checked && (song.partnerRoundIds || []).length >= PARTNERS_MAX;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onTogglePartner(s.id)}
                  disabled={atMax}
                  aria-pressed={checked}
                  title={atMax ? `Up to ${PARTNERS_MAX} partners` : undefined}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors disabled:opacity-40 ${checked ? 'bg-port-accent/15 border-port-accent/60 text-white' : 'border-port-border text-gray-300 hover:text-white hover:border-port-accent/60'}`}
                >
                  {checked ? '✓ ' : '+ '}{s.title || 'Untitled round'}
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
        tempo={song.tempo ?? null}
        score={song.score}
        onChange={(recordings) => setField('recordings', recordings)}
      />

      {/* Training — practice loop, scoring, and learned-progress tracking */}
      <SongTraining
        score={song.score}
        lyricSections={song.sections || []}
        tempo={song.tempo ?? null}
        progress={song.progress ?? null}
        onProgress={(progress) => setField('progress', progress)}
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
                  <button type="button" onClick={() => removeReference(r.id)} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-error shrink-0" aria-label="Remove reference">
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
                {/* Reference-audio analysis (#2106): attach audio (upload or
                    mic capture while the video plays), then analyze it into
                    per-layer proposed parts. Gated on a valid http(s) URL —
                    the server DROPS a reference whose url fails that check,
                    so letting the user attach audio/segments to a droppable
                    row would silently lose that work on Save. */}
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-port-border/60">
                  {isHttpUrl(r.url) ? (
                    <>
                      <ReferenceAudioAttach reference={r} onUpdate={(key, value) => updateReference(r.id, key, value)} />
                      {r.audioFilename && (
                        <button
                          type="button"
                          onClick={() => onAnalyze(r.id)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-accent/50 text-port-accent hover:bg-port-accent/10"
                        >
                          <AudioLines size={14} /> Analyze audio
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-gray-600">Enter a valid http(s) link above to attach audio for analysis.</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Sheet music — live-rendered staff from the lead-sheet notation. */}
      <SongScoreEditor value={song.score} onChange={(v) => setField('score', v)} />

      {/* Harmony variations — bass / mid / high parts derived from the melody.
          `baseDirty` gates the AI derive (it reads the SAVED base score). */}
      <SongScoreParts
        songId={songId}
        baseScore={song.score}
        baseDirty={baseDirty}
        scoreParts={song.scoreParts || []}
        onChange={(scoreParts) => setField('scoreParts', scoreParts)}
      />

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
  );
}
