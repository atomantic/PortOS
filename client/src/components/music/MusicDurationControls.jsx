/** Duration mode/value inputs and the lyric-pacing guidance for MusicGenPanel. */

import { formatDurationSec } from '../../utils/formatters.js';

export default function MusicDurationControls({ engine, autoDurationAvailable, usingAutoDuration, durationMode, setDurationMode, durationSec, setDurationSec, lyricDuration }) {
  return (
    <>
      <div className={autoDurationAvailable ? 'grid grid-cols-2 gap-2' : undefined}>
        {autoDurationAvailable ? (
          <label className="block">
            <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">Duration mode</span>
            <select
              id="musicgen-duration-mode"
              value={durationMode}
              onChange={(e) => setDurationMode(e.target.value)}
              className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
            >
              <option value="auto">Auto — let MiniMax choose</option>
              <option value="manual">Manual</option>
            </select>
          </label>
        ) : null}
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
            Duration (s){engine ? ` — ${engine.minDurationSec}–${engine.maxDurationSec}` : ''}
          </span>
          <input
            id="musicgen-duration"
            type="number"
            value={usingAutoDuration ? lyricDuration.suggestedDurationSec : (durationSec ?? '')}
            min={engine?.minDurationSec}
            max={engine?.maxDurationSec}
            disabled={usingAutoDuration}
            onChange={(e) => {
              setDurationMode('manual');
              setDurationSec(e.target.value === '' ? null : Number(e.target.value));
            }}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-70"
          />
        </label>
      </div>

      {autoDurationAvailable ? (
        <div className="rounded-lg border border-port-accent/20 bg-port-accent/5 px-3 py-2 text-[11px]">
          {lyricDuration.hasLyrics ? (
            <p className="text-gray-300">
              Auto sets a <span className="font-medium text-port-accent">{formatDurationSec(lyricDuration.suggestedDurationSec)}</span> ceiling from {lyricDuration.wordCount} lyric words {lyricDuration.sectionCount > 0 ? <>across {lyricDuration.sectionCount} tagged section{lyricDuration.sectionCount === 1 ? '' : 's'}</> : 'with no tagged sections detected'}, with room for the ending. MiniMax may finish earlier when the composition resolves.
            </p>
          ) : (
            <p className="text-gray-300">
              Auto uses a {formatDurationSec(lyricDuration.suggestedDurationSec)} ceiling because there is no lyric text to measure; MiniMax may finish earlier.
            </p>
          )}
          {lyricDuration.sectionCount === 0 && lyricDuration.hasLyrics ? (
            <p className="mt-1 text-gray-500">No structured lyric sections detected. Add tags such as [intro], [verse], [chorus], and [outro] so MiniMax can pace the composition more reliably.</p>
          ) : null}
          {lyricDuration.sectionCount > 0 && !lyricDuration.hasOutro && lyricDuration.hasLyrics ? (
            <p className="mt-1 text-gray-500">No [outro] section detected. The closing cue is shown below; adding your own [outro] marker gives you control over exactly where the ending lands.</p>
          ) : null}
          {lyricDuration.isCapped ? (
            <p className="mt-1 text-port-warning">These lyrics estimate beyond MiniMax’s five-minute limit, so the final lines may still need to be shortened or split into another render.</p>
          ) : null}
        </div>
      ) : null}
      {autoDurationAvailable && !usingAutoDuration && lyricDuration.hasLyrics && Number.isFinite(durationSec) && durationSec < lyricDuration.suggestedDurationSec ? (
        <p className="text-[11px] text-port-warning">
          This manual ceiling is shorter than the lyric estimate ({formatDurationSec(lyricDuration.suggestedDurationSec)}); the last section or outro may be cut off.
        </p>
      ) : null}
    </>
  );
}
