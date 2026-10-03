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

/**
 * Setup: where the song, its analysis and the creative direction come from —
 * creative setup (universe, cast, places), the track and its analysis/MIDI,
 * lyrics, concept & style, the visual spec and the treatment.
 */
export default function SetupStage({ board }) {
  const {
    project, tracks, trackName, audioFilename, locked, youtube, separation, midi, midiBound, renderBound, tempo, busy,
    conceptDraft, styleDraft, importingLyrics, aligningLyrics, treatment,
    autopilotRun, autonomous, runStage, onSelectStage,
  } = board;
  return (
    <>
      {autopilotRun && (
        <AutonomousRunPanel
          key={`autonomous-${project.id}`}
          project={project}
          auto={autonomous}
          selectedStage={runStage}
          onSelectStage={onSelectStage}
          framed
        />
      )}
      <SongRevisionPanel key={`song-${project.id}`} project={project} tracks={tracks} onUpdated={board.replaceProject} onFork={board.onForkSong} disabled={locked || renderBound || midiBound} />
      <CreativeSetupPanel
        key={`creative-${project.id}`}
        project={project}
        onPendingChange={board.setCreativeSetupPending}
        onSave={board.saveCreativeSetup}
      />
      <StyleReferencesPanel key={`moodboard-${project.id}`} project={project}
        onSave={board.saveStyleReferences} onPendingChange={board.setStyleReferencesPending} />
      <fieldset disabled={locked} className="min-w-0">
        <div id="mv-track" className="space-y-2 rounded-lg border border-port-border bg-port-card p-3">
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

          {/* Concept & style — global direction for the video */}
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
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
          <TreatmentPanel key={`treatment-${project.id}`} project={project} treatment={treatment} />
        </div>
      </fieldset>
    </>
  );
}
