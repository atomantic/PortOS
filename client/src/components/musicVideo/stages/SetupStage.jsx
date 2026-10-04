import AutonomousRunPanel from '../AutonomousRunPanel.jsx';
import SongRevisionPanel from '../SongRevisionPanel.jsx';
import StyleReferencesPanel from '../StyleReferencesPanel.jsx';
import AutoSizeTextarea from '../../ui/AutoSizeTextarea';
import CreativeSetupPanel from '../CreativeSetupPanel.jsx';
import TrackPanel from '../TrackPanel.jsx';
import AnalysisPanel from '../AnalysisPanel.jsx';
import LyricsPanel from '../LyricsPanel.jsx';
import VisualSpecPanel from '../VisualSpecPanel.jsx';
import TreatmentPanel from '../TreatmentPanel.jsx';
import { AudioActions } from '../ProjectActionGroups.jsx';
import StageSection from '../StageSection.jsx';
import ProjectOptionsPanel, { projectOptionsSummary } from '../ProjectOptionsPanel.jsx';
import { projectHasAudio } from '../../../lib/musicVideoStages.js';
import { formatCount } from '../../../utils/formatters.js';

const songSummary = (project, trackLabel) => {
  const lines = (project.lyricCues || []).length;
  return [
    projectHasAudio(project) ? trackLabel || 'Track attached' : 'No track yet',
    project.audioAnalysis ? 'Analyzed' : 'Not analyzed',
    lines ? `${formatCount(lines)} lyric ${lines === 1 ? 'line' : 'lines'}` : 'No lyrics',
  ].join(' · ');
};

const directionSummary = (project) => {
  const refs = (project.styleReferences || []).length;
  return [
    project.concept?.prompt?.trim() ? 'Concept written' : 'No concept yet',
    project.concept?.style?.trim() ? 'Style set' : 'No style yet',
    refs ? `${formatCount(refs)} style ${refs === 1 ? 'reference' : 'references'}` : 'No style references',
  ].join(' · ');
};

/**
 * Setup, in folded sections so each part reads at a glance: Project options
 * (workflow, media, render style, image/video services, autopilot tools), Song
 * & lyrics (the track, its analysis/MIDI and lyrics), Creative direction
 * (universe, cast, places, mood board, concept & style, visual spec) and the
 * Treatment. A section opens by default when it holds the next thing to do;
 * an anchor inside a folded section unfolds it (see the page's hash effect).
 */
export default function SetupStage({ board }) {
  const {
    project, tracks, trackName, audioFilename, locked, youtube, separation, midi, midiBound, renderBound, tempo, busy,
    conceptDraft, styleDraft, importingLyrics, aligningLyrics, treatment,
    autopilotRun, autonomous, runStage, onSelectStage,
  } = board;
  const songOpen = !projectHasAudio(project) || !project.audioAnalysis;
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
        />
      </StageSection>
      <StageSection id="mv-setup-song" title="Song & lyrics" summary={songSummary(project, trackLabel)} defaultOpen={songOpen}>
        <SongRevisionPanel key={`song-${project.id}`} project={project} tracks={tracks} onUpdated={board.replaceProject} onFork={board.onForkSong} disabled={locked || renderBound || midiBound} />
        <fieldset disabled={locked} className="min-w-0">
          <div id="mv-track" className="space-y-2">
            <TrackPanel
              project={project}
              tracks={tracks}
              trackName={trackName}
              audioFilename={audioFilename}
              youtube={youtube}
              renderBound={renderBound}
              midiBound={midiBound}
              onChangeTrack={board.onChangeTrack}
              onProjectUpdated={board.replaceProject}
              separation={separation}
            />
            <AudioActions project={project} midi={midi} midiBound={midiBound} busy={busy} onAnalyze={board.onAnalyze} />
            <AnalysisPanel
              audioAnalysis={project.audioAnalysis}
              scenes={project.scenes || []}
              tempo={tempo}
              onReanalyze={board.onAnalyze}
              analyzing={busy.analyzing}
            />
            <LyricsPanel
              project={project}
              onEditLocal={board.editProjectLocal}
              onSave={board.saveProjectFields}
              onImport={board.onImportLyrics}
              onImportTrack={board.onImportTrackLyrics}
              importing={importingLyrics}
              onAlign={board.onAlignLyrics}
              aligning={aligningLyrics}
            />
          </div>
        </fieldset>
      </StageSection>
      <StageSection id="mv-setup-direction" title="Creative direction" summary={directionSummary(project)}>
        <CreativeSetupPanel
          key={`creative-${project.id}`}
          project={project}
          onPendingChange={board.setCreativeSetupPending}
          onSave={board.saveCreativeSetup}
        />
        <StyleReferencesPanel key={`moodboard-${project.id}`} project={project}
          onSave={board.saveStyleReferences} onPendingChange={board.setStyleReferencesPending} />
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
            onAddReference={board.onAddReference}
          />
        </fieldset>
      </StageSection>
      <StageSection id="mv-setup-treatment" title="Treatment" summary="The shot-by-shot treatment the plan builds on">
        <fieldset disabled={locked} className="min-w-0">
          <TreatmentPanel key={`treatment-${project.id}`} project={project} treatment={treatment} />
        </fieldset>
      </StageSection>
    </>
  );
}
