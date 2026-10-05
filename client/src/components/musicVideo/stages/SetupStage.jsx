import { useState } from 'react';
import AutonomousRunPanel from '../AutonomousRunPanel.jsx';
import SongRevisionPanel from '../SongRevisionPanel.jsx';
import LookReferencesPanel from '../LookReferencesPanel.jsx';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import CreativeSetupPanel from '../CreativeSetupPanel.jsx';
import TrackPanel, { AdvancedTrackControls } from '../TrackPanel.jsx';
import AudioTimingPanel from '../AudioTimingPanel.jsx';
import AnalysisPanel from '../AnalysisPanel.jsx';
import LyricsPanel from '../LyricsPanel.jsx';
import VisualSpecPanel from '../VisualSpecPanel.jsx';
import TreatmentPanel, { treatmentSummary } from '../TreatmentPanel.jsx';
import { AnalyzeAction, MidiAction } from '../ProjectActionGroups.jsx';
import StageSection from '../StageSection.jsx';
import ProjectOptionsPanel, { projectOptionsSummary } from '../ProjectOptionsPanel.jsx';
import { Check } from 'lucide-react';
import { lyricSetupState, projectHasAudio } from '../../../lib/musicVideoStages.js';
import { formatCount } from '../../../utils/formatters.js';

const songSummary = (project, trackLabel) => {
  const lines = (project.lyricCues || []).length;
  const aligned = lines > 0 && project.lyricCues.every((cue) => cue.words?.length);
  const lyrics = lyricSetupState(project);
  const lyricText = lines
    ? [`${formatCount(lines)} lyric ${lines === 1 ? 'line' : 'lines'}`, aligned ? 'aligned' : null, lyrics.verified ? 'verified' : null].filter(Boolean).join(' · ')
    : lyrics.instrumental ? 'Instrumental' : 'No lyrics';
  return [
    projectHasAudio(project) ? trackLabel || 'Track attached' : 'No track yet',
    project.audioAnalysis ? 'Analyzed' : 'Not analyzed',
    lyricText,
  ].join(' · ');
};

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
function AlignWords({ disabled, aligning, status, onAlign }) {
  const [error, setError] = useState('');
  const run = () => {
    setError('');
    Promise.resolve(onAlign()).catch((err) => setError(err?.message || 'Could not align the words to the vocal. Try again.'));
  };
  return (
    <>
      <p className="text-xs text-port-text-muted">
        Align each word to the vocal, then listen back to confirm the timing. Word times can be fine-tuned per line in step 3.
      </p>
      <button type="button" onClick={run} disabled={aligning || disabled}
        className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm text-port-accent disabled:opacity-50 sm:min-h-0">
        {aligning ? 'Aligning…' : 'Align all words'}
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

const directionSummary = (project) => {
  const refs = (project.visualSpec?.references || []).length + (project.styleReferences || []).length;
  return [
    project.concept?.prompt?.trim() ? 'Concept written' : 'No concept yet',
    project.concept?.style?.trim() ? 'Style set' : 'No style yet',
    refs ? `${formatCount(refs)} look ${refs === 1 ? 'reference' : 'references'}` : 'No look references',
  ].join(' · ');
};

/**
 * Setup, in folded sections so each part reads at a glance: Project options
 * (workflow, media, render style, image/video services, autopilot tools), Song
 * & lyrics (the track, its analysis/MIDI and lyrics), Creative direction
 * (universe, cast, places, mood board, concept & style, visual spec) and the
 * Treatment brief. A section opens by default when it holds the next thing to do;
 * an anchor inside a folded section unfolds it (see the page's hash effect).
 */
export default function SetupStage({ board }) {
  const {
    project, tracks, trackName, audioFilename, locked, youtube, separation, midi, midiBound, renderBound, tempo, busy,
    conceptDraft, styleDraft, importingLyrics, aligningLyrics, alignStatus, treatment,
    autopilotRun, autonomous, runStage, onSelectStage,
  } = board;
  const songOpen = !projectHasAudio(project) || !project.audioAnalysis || !lyricSetupState(project).ok;
  const cues = project.lyricCues || [];
  const aligned = cues.length > 0 && cues.every((cue) => cue.words?.length);
  const trackLabel = project.trackId ? trackName(project.trackId) : audioFilename;
  return (
    <>
      {autopilotRun && (
        <AutonomousRunPanel
          key={`autonomous-${project.id}`}
          project={project}
          auto={autonomous}
          readiness={board.productionReadiness}
          selectedStage={runStage}
          onSelectStage={onSelectStage}
          framed
        />
      )}
      <StageSection
        id="mv-setup-options"
        title="Project options"
        summary={projectOptionsSummary(project)}
        defaultOpen
      >
        <ProjectOptionsPanel
          project={project}
          videoSettings={board.videoSettings}
          generatingVideos={Object.keys(board.sceneMedia?.genVideoScenes || {}).length > 0}
          onMediaMode={board.saveMediaMode}
          onRenderStyle={board.onRenderStyle}
          onSaveAutomation={board.saveAutomation}
          onSavePolicy={(productionPolicy) => board.saveCreativeSetup({ productionPolicy })}
        />
      </StageSection>
      <StageSection id="mv-setup-song" title="Song & lyrics" summary={songSummary(project, trackLabel)} defaultOpen={songOpen}>
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
            <SongStep number={3} title="Lyrics" done={cues.length > 0}>
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
            <SongStep number={4} title="Align & verify" done={aligned}>
              <AlignWords
                disabled={cues.length === 0 || !projectHasAudio(project)}
                aligning={aligningLyrics}
                status={alignStatus}
                onAlign={board.onAlignLyrics}
              />
            </SongStep>
          </div>
        </fieldset>
        <StageSection id="mv-setup-advanced-audio" title="Advanced audio" summary="Fork & revise song, vocal stem, sound bed, MIDI, timing revision">
          <SongRevisionPanel key={`song-${project.id}`} project={project} tracks={tracks} onUpdated={board.replaceProject} onFork={board.onForkSong} disabled={locked || renderBound || midiBound} />
          <fieldset disabled={locked} className="min-w-0 space-y-2">
            <AdvancedTrackControls project={project} tracks={tracks} renderBound={renderBound} onProjectUpdated={board.replaceProject} separation={separation} />
            <MidiAction project={project} midi={midi} midiBound={midiBound} />
          </fieldset>
          <AudioTimingPanel key={`timing-${project.id}`} project={project} tracks={tracks} onApplied={board.replaceProject} disabled={locked || renderBound} />
        </StageSection>
      </StageSection>
      <StageSection id="mv-setup-direction" title="Creative direction" summary={directionSummary(project)}>
        <CreativeSetupPanel
          key={`creative-${project.id}`}
          project={project}
          onPendingChange={board.setCreativeSetupPending}
          onSave={board.saveCreativeSetup}
        />
        <LookReferencesPanel key={`look-${project.id}`} project={project}
          onSave={board.saveStyleReferences} onSaveSpec={board.saveVisualSpec} onAddReference={board.onAddReference}
          onPendingChange={board.setStyleReferencesPending} />
        <fieldset disabled={locked} className="min-w-0 space-y-2">
          {/* Concept & style — global direction for the video */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label htmlFor="mv-concept" className="mb-1 block text-xs text-port-text-muted">Concept</label>
              <AutoSizeTextarea
                id="mv-concept"
                value={conceptDraft.value}
                rows={2}
                maxLength={8000}
                onChange={conceptDraft.onChange}
                onBlur={conceptDraft.onBlur}
                placeholder="What is this video about — story, theme, or narrative thread for the AI plan to build on."
                className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label htmlFor="mv-style" className="mb-1 block text-xs text-port-text-muted">Visual style</label>
              <AutoSizeTextarea
                id="mv-style"
                value={styleDraft.value}
                rows={2}
                maxLength={2000}
                onChange={styleDraft.onChange}
                onBlur={styleDraft.onBlur}
                placeholder="Art style, references, palette, mood — appended to every generated frame and shot prompt."
                className="min-h-[44px] w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          <VisualSpecPanel
            key={project.id}
            project={project}
            onSave={board.saveVisualSpec}
          />
        </fieldset>
      </StageSection>
      <StageSection id="mv-setup-treatment" title="Treatment brief" summary={`${treatmentSummary(project)} · feeds the shot planner`}>
        <fieldset disabled={locked} className="min-w-0">
          <TreatmentPanel key={`treatment-${project.id}`} project={project} treatment={treatment} part="brief" />
        </fieldset>
      </StageSection>
    </>
  );
}
