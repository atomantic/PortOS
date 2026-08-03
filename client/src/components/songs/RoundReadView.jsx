import { Link } from 'react-router';
import { CheckCircle2, Circle, Layers, Video } from 'lucide-react';
import Pill from '../ui/Pill';
import RoundBuiltInBanner from './RoundBuiltInBanner';
import RoundReferenceCard from './RoundReferenceCard';
import RoundSheetMusic from './RoundSheetMusic';
import RoundStack from './RoundStack';
import SongRecordings from './SongRecordings';
import SongTraining from './SongTraining';
import { rhythmShapeLabel } from '../../lib/songCraft';

// --- Read-only performance view -------------------------------------------
// Renders the song for reading / playing / recording: lyrics shown in full
// (no sub-scrollable textareas) and laid out in a responsive grid so short
// sections sit side-by-side and use the available desktop width. The recorder
// stays interactive (recording mutates the draft; the header Save persists it).
export default function RoundReadView({ song, setField, onRefreshTemplate, refreshing, partnerSongs = [], stackOpen = false, onToggleStack, onAnalyze }) {
  const sections = song.sections || [];
  const layers = song.layers || [];
  const references = song.references || [];
  const hasText = (v) => typeof v === 'string' && v.trim().length > 0;
  const feel = song.rhythmShapeId ? rhythmShapeLabel(song.rhythmShapeId) : '';
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
      {song.builtIn && <RoundBuiltInBanner onRefresh={onRefreshTemplate} refreshing={refreshing} />}
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
            <Link key={p.id} to={`/rounds/${p.id}`} className="px-2.5 py-1 text-xs rounded-full border border-port-border text-gray-300 hover:text-white hover:border-port-accent/60">
              {p.title || 'Untitled round'}
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

      {/* Sheet music — the rendered staff, full-width so a row of bars fits.
          Kept at the top with the metronome + recorder so the practice tools
          (read the chart, set the tempo, record against it) lead the view. A
          part switcher appears when the song carries harmony variations. */}
      {!showingStack && (
        <RoundSheetMusic baseScore={song.score} scoreParts={song.scoreParts || []} />
      )}

      {/* Vocal takes — metronome + recording/playback, front-and-centre with the
          sheet music. Recording stays available in read mode (it mutates the
          draft; the header Save persists it). */}
      <SongRecordings
        recordings={song.recordings || []}
        layers={song.layers || []}
        tempo={song.tempo ?? null}
        score={song.score}
        onChange={(recordings) => setField('recordings', recordings)}
      />

      {/* Training — practice & memorize against the score, tracking progress.
          Hidden while the round stack is open (the stack is its own surface). */}
      {!showingStack && (
        <SongTraining
          score={song.score}
          lyricSections={song.sections || []}
          tempo={song.tempo ?? null}
          progress={song.progress ?? null}
          onProgress={(progress) => setField('progress', progress)}
        />
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
            {references.map((r) => <RoundReferenceCard key={r.id} reference={r} onAnalyze={onAnalyze} />)}
          </div>
        </section>
      )}
    </div>
  );
}
