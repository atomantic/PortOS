import { useState } from 'react';
import TrackPanel from '../TrackPanel.jsx';
import AnalysisPanel from '../AnalysisPanel.jsx';
import LyricsPanel from '../LyricsPanel.jsx';
import LyricTimingCheck from '../LyricTimingCheck.jsx';
import { AnalyzeAction } from '../ProjectActionGroups.jsx';
import { Check } from 'lucide-react';
import { lyricSetupState, projectHasAudio } from '../../../lib/musicVideoStages.js';

/** One numbered step of Song & lyrics, with a done state beside its title. */
function SongStep({ number, title, done, children }) {
  return (
    <section aria-label={`Step ${number}: ${title}`} className="min-w-0 space-y-2 rounded-lg border border-port-border p-2">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${done ? 'bg-port-success text-white' : 'bg-port-border text-port-text-muted'}`}>
          {done ? <Check size={12} /> : number}
        </span>
        {number}. {title}
        <span className={`text-xs font-normal ${done ? 'text-port-success' : 'text-port-text-muted'}`}>{done ? 'Done' : 'To do'}</span>
      </h3>
      {children}
    </section>
  );
}

/** Whole-song word alignment; the page's handler is silent, so errors surface here. */
function AlignWords({ disabled, aligning, status, aligned, onAlign }) {
  const [error, setError] = useState('');
  const run = () => {
    setError('');
    Promise.resolve(onAlign()).catch((err) => setError(err?.message || 'Could not align the words to the vocal. Try again.'));
  };
  return (
    <>
      <p className="text-xs text-port-text-muted">
        {aligned ? 'Every word is placed. Listen back, fine-tune any line in step 3, then verify.' : 'Place each word on the vocal, then listen back.'}
      </p>
      <button type="button" onClick={run} disabled={aligning || disabled}
        className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-port-accent disabled:opacity-50 sm:min-h-0">
        {aligning ? 'Aligning…' : aligned ? 'Re-align all words' : 'Align all words'}
      </button>
      {status && (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-port-text-muted">
          <span>{status.label}{status.percent > 0 ? ` ${status.percent}%` : ''}</span>
          <button type="button" onClick={status.onCancel}
            className="min-h-[44px] rounded border border-port-border px-2 text-port-error sm:min-h-0">Cancel</button>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
    </>
  );
}

/**
 * Song: the track, its analysis, the lyrics, and their word timing — four
 * numbered parts, each marked done or to do, all open. Forking or revising the
 * song, the vocal stem, MIDI and timing revisions live in Project settings ›
 * Audio; the render style and services in Project settings › Project.
 */
export default function SetupStage({ board }) {
  const {
    project, tracks, trackName, audioFilename, locked, youtube, midiBound, renderBound, tempo, busy,
    importingLyrics, aligningLyrics, alignStatus,
  } = board;
  const cues = project.lyricCues || [];
  const aligned = cues.length > 0 && cues.every((cue) => cue.words?.length);
  const lyrics = lyricSetupState(project, board.productionReadiness);
  return (
    <fieldset disabled={locked} className="min-w-0">
      <div id="mv-track" className="space-y-2">
        <SongStep number={1} title="Track" done={projectHasAudio(project)}>
          <TrackPanel
            project={project}
            tracks={tracks}
            trackName={trackName}
            audioFilename={audioFilename}
            youtube={youtube}
            renderBound={renderBound}
            midiBound={midiBound}
            onChangeTrack={board.onChangeTrack}
          />
        </SongStep>
        <SongStep number={2} title="Analyze" done={Boolean(project.audioAnalysis)}>
          <AnalyzeAction project={project} busy={busy} onAnalyze={board.onAnalyze} />
          <AnalysisPanel
            audioAnalysis={project.audioAnalysis}
            scenes={project.scenes || []}
            tempo={tempo}
            onReanalyze={board.onAnalyze}
            analyzing={busy.analyzing}
          />
        </SongStep>
        <SongStep number={3} title="Lyrics" done={cues.length > 0 || lyrics.instrumental}>
          <LyricsPanel
            inline
            project={project}
            onEditLocal={board.editProjectLocal}
            onSave={board.saveProjectFields}
            onImport={board.onImportLyrics}
            onImportTrack={board.onImportTrackLyrics}
            importing={importingLyrics}
            onAlign={board.onAlignLyrics}
            aligning={aligningLyrics}
          />
        </SongStep>
        <SongStep number={4} title="Time and verify" done={lyrics.verified || lyrics.ok}>
          {!lyrics.instrumental && (
            <AlignWords
              disabled={cues.length === 0 || !projectHasAudio(project)}
              aligning={aligningLyrics}
              status={alignStatus}
              aligned={aligned}
              onAlign={board.onAlignLyrics}
            />
          )}
          {board.productionReview && (
            <LyricTimingCheck project={project} review={board.productionReview} planning={board.planningDraft} disabled={locked} />
          )}
        </SongStep>
      </div>
    </fieldset>
  );
}
