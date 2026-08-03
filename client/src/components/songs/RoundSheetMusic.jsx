import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ScoreSheet from './ScoreSheet';
import PianoRoll, { layerColor } from './PianoRoll';
import { parseScore, scoreHasMusic } from '../../lib/scoreNotation';
import { createMultiScorePlayer, DEFAULT_BPM } from '../../lib/scorePlayback';
import { harmonyPartOrder } from '../../lib/songCraft';

// Sheet-music card for the Round read view: the base melody plus any harmony
// variations. Every song that has music gets the layered MIDI player — a tempo
// control plus the Staff ↔ Piano-roll (Synthesia) view toggle, synthesized in
// sync by createMultiScorePlayer. With more than one part it also grows a
// per-part checkbox row (hear any combination of voices) and a pill row that
// picks which staff is *shown* (independent of what plays); the playhead lights
// up on the shown staff when it's one of the parts currently sounding. A
// single-part song hides those multi-part affordances but keeps the piano view.
// Returns null when there's no music anywhere.
export default function RoundSheetMusic({ baseScore, scoreParts = [] }) {
  const tabs = useMemo(() => {
    const out = [];
    if (scoreHasMusic(baseScore)) out.push({ key: 'melody', label: 'Melody', score: baseScore });
    (scoreParts || [])
      .filter((p) => scoreHasMusic(p.score))
      .slice()
      .sort((a, b) => harmonyPartOrder(a.role) - harmonyPartOrder(b.role))
      .forEach((p) => out.push({ key: p.id, label: p.label || 'Part', score: p.score }));
    return out;
  }, [baseScore, scoreParts]);

  if (!tabs.length) return null;
  return <LayeredSheetMusic tabs={tabs} />;
}

// Multi-part sheet music with a layered MIDI player. `selected` (the checked
// parts) drives playback; `viewKey` drives which staff is rendered. The combined
// player is rebuilt whenever the selection, tab set, or tempo changes so it
// always sounds exactly the checked voices.
function LayeredSheetMusic({ tabs }) {
  const uid = useId();
  const tabsKey = tabs.map((t) => t.key).join('|');
  const multiPart = tabs.length > 1;

  // 'staff' = SVG sheet music; 'piano' = Synthesia-style falling-note piano roll.
  const [view, setView] = useState('staff');
  const [viewKey, setViewKey] = useState(tabs[0].key);

  // Stable per-part colors (by tab order) shared by the piano roll and the layer
  // swatches so every surface agrees on which color is which voice.
  const colorByKey = useMemo(
    () => new Map(tabs.map((t, i) => [t.key, layerColor(i)])),
    [tabsKey],
  );
  // Default: every part checked, so Play gives the full stack out of the box.
  // Reconcile across tab-set changes — keep checks for parts that still exist,
  // include any newly-added part, and never leave the selection empty.
  const [selected, setSelected] = useState(() => new Set(tabs.map((t) => t.key)));
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(tabs.filter((t) => prev.has(t.key)).map((t) => t.key));
      if (next.size === 0) tabs.forEach((t) => next.add(t.key));
      return next;
    });
  }, [tabsKey]);

  const melodyScore = tabs[0].score;
  const tempoFromMelody = useMemo(() => {
    const t = parseScore(melodyScore).tempo;
    return Number.isFinite(t) && t > 0 ? t : DEFAULT_BPM;
  }, [melodyScore]);
  const [tempo, setTempo] = useState(tempoFromMelody);
  useEffect(() => { setTempo(tempoFromMelody); }, [tempoFromMelody]);

  const playerRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeByPart, setActiveByPart] = useState({}); // partKey → now-sounding note index
  // Live playhead in score-seconds for the piano roll; stable so its rAF loop
  // doesn't restart on every render (reads the player ref, 0 when torn down).
  const getPosition = useCallback(() => playerRef.current?.position?.() ?? 0, []);

  const selectionKey = tabs.filter((t) => selected.has(t.key)).map((t) => t.key).join('|');
  // Notation content of every tab — changes when a score's TEXT changes even if
  // its id/tempo don't (e.g. "Refresh from template"), so the player is rebuilt
  // against the freshly-parsed scores rather than playing the stale ones.
  const scoresKey = tabs.map((t) => t.score).join('');

  const teardown = useCallback(() => {
    if (playerRef.current) { playerRef.current.stop(); playerRef.current = null; }
    setIsPlaying(false);
    setActiveByPart({});
  }, []);

  // A changed selection / tab set / score content / tempo invalidates the player.
  useEffect(() => { teardown(); }, [selectionKey, tabsKey, scoresKey, tempo, teardown]);
  // Tear down live audio on unmount.
  useEffect(() => () => teardown(), [teardown]);

  const ensurePlayer = () => {
    if (!playerRef.current) {
      const parts = tabs
        .filter((t) => selected.has(t.key))
        .map((t) => ({ id: t.key, score: parseScore(t.score) }));
      playerRef.current = createMultiScorePlayer(parts, {
        bpm: tempo,
        onNote: (id, i) => setActiveByPart((prev) => {
          const next = i == null ? -1 : i;
          return prev[id] === next ? prev : { ...prev, [id]: next };
        }),
        onEnded: () => { setIsPlaying(false); setActiveByPart({}); },
      });
    }
    return playerRef.current;
  };

  const togglePlay = () => {
    if (!selected.size) return;
    const player = ensurePlayer();
    if (isPlaying) { player.pause(); setIsPlaying(false); return; }
    setIsPlaying(true);
    Promise.resolve(player.play()).catch(() => setIsPlaying(false));
  };

  const handleStop = () => { teardown(); };

  const toggleSelected = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const current = tabs.find((t) => t.key === viewKey) || tabs[0];
  // Light the playhead on the shown staff only when it's one of the parts that's
  // actually sounding; otherwise -1 (no highlight) rather than null (which would
  // hand control back to <ScoreSheet>'s own — here unused — internal player).
  const shownActive = selected.has(current.key) ? (activeByPart[current.key] ?? -1) : -1;

  // Selected layers the piano roll renders together — raw score text (it parses)
  // plus the shared per-layer color.
  const pianoParts = useMemo(
    () => tabs.filter((t) => selected.has(t.key)).map((t) => ({ id: t.key, label: t.label, color: colorByKey.get(t.key), score: t.score })),
    [tabs, selectionKey, colorByKey],
  );

  const transportBtn = 'flex items-center gap-1 rounded-md border border-port-border bg-port-card px-2 py-1 text-white hover:border-port-accent transition-colors disabled:opacity-40 disabled:hover:border-port-border';

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-white">Sheet music</h2>

      {/* Layered MIDI transport: play the checked combination of parts together. */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
        <button type="button" onClick={togglePlay} disabled={!selected.size} aria-label={isPlaying ? 'Pause parts' : 'Play selected parts'} className={transportBtn}>
          <span aria-hidden="true">{isPlaying ? '⏸' : '▶'}</span>
          <span className="hidden sm:inline">{isPlaying ? 'Pause' : 'Play parts'}</span>
        </button>
        <button type="button" onClick={handleStop} disabled={!isPlaying} aria-label="Stop" className={transportBtn}>
          <span aria-hidden="true">⏹</span>
          <span className="hidden sm:inline">Stop</span>
        </button>
        <label htmlFor={`${uid}-tempo`} className="flex items-center gap-1">
          <span>Tempo</span>
          <input
            id={`${uid}-tempo`}
            type="number"
            min={20}
            max={300}
            value={tempo}
            onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) setTempo(n); }}
            className="w-16 rounded-md border border-port-border bg-port-card px-2 py-1 text-white"
          />
          <span>BPM</span>
        </label>

        {/* Staff ↔ Piano-roll (Synthesia) view toggle — both share this transport. */}
        <div className="ml-auto flex items-center rounded-md border border-port-border overflow-hidden" role="group" aria-label="Sheet view">
          {[['staff', 'Staff'], ['piano', 'Piano']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              aria-pressed={view === key}
              className={`px-2.5 py-1 transition-colors ${view === key ? 'bg-port-accent text-white' : 'bg-port-card text-gray-300 hover:text-white'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* One checkbox per part — the mix that Play sounds. Swatch = piano color.
          A single-part song has nothing to combine, so the row is hidden. */}
      {multiPart && (
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <legend className="sr-only">Parts to play together</legend>
        <span className="text-gray-500">Layers:</span>
        {tabs.map((t) => (
          <label key={t.key} htmlFor={`${uid}-pick-${t.key}`} className="flex items-center gap-1.5 text-gray-300 cursor-pointer">
            <input
              id={`${uid}-pick-${t.key}`}
              type="checkbox"
              checked={selected.has(t.key)}
              onChange={() => toggleSelected(t.key)}
              className="accent-port-accent"
            />
            <span
              aria-hidden="true"
              className="inline-block w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: selected.has(t.key) ? colorByKey.get(t.key) : 'transparent', border: `1px solid ${colorByKey.get(t.key)}` }}
            />
            {t.label}
          </label>
        ))}
      </fieldset>
      )}

      {view === 'staff' ? (
        <>
          {/* Pill row picks which staff is shown (independent of what plays).
              With a single part there's nothing to pick between, so it's hidden. */}
          {multiPart && (
          <div className="flex flex-wrap gap-1.5">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setViewKey(t.key)}
                aria-pressed={t.key === current.key}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${t.key === current.key ? 'bg-port-accent text-white border-port-accent' : 'border-port-border text-gray-300 hover:text-white hover:border-port-accent/60'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          )}

          <div className="bg-port-card border border-port-border rounded-lg p-4 overflow-x-auto">
            <ScoreSheet key={current.key} text={current.score} controls={false} activeNoteIndex={shownActive} />
          </div>
        </>
      ) : (
        <div className="bg-port-card border border-port-border rounded-lg p-2">
          <PianoRoll parts={pianoParts} tempo={tempo} getPosition={getPosition} playing={isPlaying} />
        </div>
      )}
    </section>
  );
}
